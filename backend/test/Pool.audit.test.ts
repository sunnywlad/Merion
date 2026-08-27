// Audit Pool — defauts 1, 3, 4, 5 du brief.
//
// Cinq cas, meme couche TypeScript/viem que les autres suites de la piscine,
// meme justification : ce qu'ils epinglent est ce que le constructeur et
// `swap` DECIDENT face a des appels venus de l'exterieur, lus ensuite par les
// memes getters que le front appelle. Conventions reprises de
// test/Pool.constructor.test.ts et test/Pool.swap.test.ts.
//
// Forme cible : cinq tests ROUGES, chacun ecrit contre la ligne de Pool.sol
// qu'il epingle, chacun formule pour echouer aujourd'hui et passer apres le
// correctif annonce. Le diagnostic de chaque assertion dit l'invariant
// viole, jamais la valeur rendue.
//
// Regle d'or : chaque attendu se calcule depuis la formule, jamais depuis
// une lecture anterieure au bug hypothetique.

import { artifacts, network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeErrorResult, type Abi } from "viem";

const { viem, networkHelpers } = await network.create();

const POOL_ABI = (await artifacts.readArtifact("Pool")).abi as Abi;

// Constantes Pool.sol, dupliquees en dur.
const MAX_FEE_NUM = 50n;
const FEE_DEN = 10000n;
const SPLIT_DEN = 10000n;
const PROTOCOL_FEE_BPS = 1000n;
const UNBALANCE_TOL_BPS = 200n;
const TOL_DEN = 10000n;

const DEFAULT_FEE_NUM = 5n;
const MIN_FEE_NUM = 1n;
const EPOCH_DURATION = 14400n;
const PRIORITY_WINDOW = 12n;

// Plancher et plafond des bandes, lus en clair depuis Pool.sol:20-21.
const FLOOR_NUM = 13n;
const CEILING_NUM = 53n;

// ---------------------------------------------------------------------------
// Fixture de base : trois jetons, un MRN, un pool deploye avec les valeurs
// de production. Dupliquee depuis Pool.constructor.test.ts (cf. README : pas
// de fixtures partagees entre fichiers, chaque suite ouvre sa propre
// connexion via network.create()).
// ---------------------------------------------------------------------------

async function deployTokensFixture() {
  const [deployer, depositor, other, treasury, attacker] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  const mrn = await viem.deployContract("MRN", []);

  const tokenAddresses = [wbtc.address, cbbtc.address, lbtc.address] as const;

  return { deployer, depositor, other, treasury, attacker, wbtc, cbbtc, lbtc, mrn, tokenAddresses };
}

type TokensFixture = Awaited<ReturnType<typeof deployTokensFixture>>;

async function deployPoolWith(
  base: TokensFixture,
  tokens: readonly `0x${string}`[] | null = null,
  treasuryOverride: `0x${string}` | null = null,
) {
  const addresses = (tokens ?? base.tokenAddresses) as readonly [`0x${string}`, `0x${string}`, `0x${string}`];
  return viem.deployContract("Pool", [
    [...addresses],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    DEFAULT_FEE_NUM,
    treasuryOverride ?? base.treasury.account.address,
    base.mrn.address,
    base.deployer.account.address,
  ]);
}

async function bootstrapPool(
  base: TokensFixture,
  pool: Awaited<ReturnType<typeof deployPoolWith>>,
  depositor: TokensFixture["depositor"],
  seedAmount: bigint = 100_000n * 10n ** 8n,
) {
  // Le depositor doit conserver du token0 AU-DELA de l'amorcage : les tests
  // des defauts 4 (swap de 4000) et 5 (1 swap de 4000 + 2 swaps de 1999)
  // utilisent le depositor comme swapper et ont besoin de son solde pour
  // transferer, pas seulement pour son allowance. On mint donc
  // `seedAmount + headroom`, on approuve le total, et `addLiquidity` ne
  // consomme que `seedAmount`. Le reliquat reste au depositor.
  const headroom = 100n * 10n ** 8n;
  const totalAmount = seedAmount + headroom;
  for (const t of [base.wbtc, base.cbbtc, base.lbtc]) {
    await t.write.mint([depositor.account.address, totalAmount]);
    await t.write.approve([pool.address, totalAmount], { account: depositor.account });
  }
  await pool.write.addLiquidity([0n, seedAmount, 0n], { account: depositor.account });
  return pool;
}

async function deployTokensAndSeededPoolFixture() {
  const base = await deployTokensFixture();
  const pool = await deployPoolWith(base);
  await bootstrapPool(base, pool, base.depositor);
  return { ...base, pool };
}

// ---------------------------------------------------------------------------
// Helper : capture la donnee de revert d'un DEPLOIEMENT et compare le nom
// de l'erreur decodee a celui attendu. Repris de Pool.constructor.test.ts :
// viem.assertions.revertWithCustomError ne fonctionne pas sur un
// DEPLOIEMENT (cf. la longue note de ce fichier), il faut remonter la
// chaine `cause` jusqu'a la donnee hexadecimale brute.
// ---------------------------------------------------------------------------

async function assertDeployRevertsWithCustomError(
  promise: Promise<unknown>,
  expectedErrorName: string,
) {
  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    while (current !== undefined && current !== null) {
      const data = (current as { data?: unknown }).data;
      if (typeof data === "string" && data.startsWith("0x")) {
        const decoded = decodeErrorResult({ abi: POOL_ABI, data: data as `0x${string}` });
        assert.equal(
          decoded.errorName,
          expectedErrorName,
          `le deploiement a reverte avec ${decoded.errorName}, attendu ${expectedErrorName}`,
        );
        return;
      }
      current = (current as { cause?: unknown }).cause;
    }
    assert.fail(
      `aucune donnee de revert trouvee dans la chaine d'erreurs ; erreur recue : ${String(error)}`,
    );
    return;
  }
  assert.fail(
    `le deploiement aurait du revert avec ${expectedErrorName}, mais il a reussi`,
  );
}

describe("Pool.audit", async function () {

  // -------------------------------------------------------------------------
  // Defaut 1 — `Pool.sol:147` : `treasury = _treasury;` est affectee sans
  // garde. Le constructeur valide les frais, l'horloge et la bande, mais
  // laisse passer `treasury == address(0)`. La consequence est dans
  // `claimProtocolFees` (`Pool.sol:419`) : `safeTransfer(treasury, owed)`
  // sur 0x0 reverte en `ERC20InvalidReceiver` (OZ v5), et les frais de
  // protocole accumules deviennent inatteignables. Le bon test epingle la
  // racine, pas la consequence : la deploiement aurait du etre refuse.
  // -------------------------------------------------------------------------

  describe("I] treasury == address(0) accepte par le constructeur", function () {
    it("un deploiement avec treasury = address(0) revert avec InvalidTreasury (construit), pas avec succes (actuel)", async function () {
      const base = await networkHelpers.loadFixture(deployTokensFixture);

      // Le deploiement utilise 0x0 comme sixieme argument. Aucun require ne
      // protege cette affectation (Pool.sol:140-143 sont les quatre gardes
      // existantes, aucune ne touche `_treasury`). Le contrat est deploye,
      // les frais de protocole collectes ulterieurement y seront perdus.
      await assertDeployRevertsWithCustomError(
        deployPoolWith(base, undefined, "0x0000000000000000000000000000000000000000"),
        "InvalidTreasury",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Defaut 3 — `Pool.sol:152-154` : les trois affectations `token0 = _tokens[i]`
  // sont faites sans aucun controle. Deux consequents distincts, sur
  // lesquels il faut deux tests :
  //   A) `decimals()` des trois jetons n'est pas verifie. Le Pool derive
  //      `decimals() = 8` (`Pool.sol:157-159`) pour lui-meme, mais ne
  //      verifie pas que ses trois jambes sont aussi en 8 decimales. Un
  //      MRN (18 decimales) en indice 1 deploye sans bruit, et le
  //      contrat qui en resulte ecrit des montants dans une echelle ou
  //      il ne saura plus rien compter.
  //   B) `_tokens` peut contenir la meme adresse deux ou trois fois. Le
  //      constructeur ne dedoublonne pas. `addLiquidity` credite chaque
  //      reserve separement (`Pool.sol:302-304` puis `317` sur la branche
  //      amorcee) ; la meme adresse sous-jacente recoit donc le cumul
  //      des jambes confondues, et `removeLiquidity` (`Pool.sol:339`)
  //      tente un second transfert superieur au solde reel. Le retrait
  //      gele sur la premiere part brulee qui declenche le second
  //      `safeTransfer`, et les parts brulees sont detruites quand meme
  //      (`Pool.sol:337` precede `339`), donc l'utilisateur perd des
  //      parts sans rien recevoir.
  // Les deux cas reclament des erreurs distinctes dans le correctif ;
  // ce test les pose separement pour ne pas fusionner ce qu'il faut
  // pouvoir diagnostiquer.
  // -------------------------------------------------------------------------

  describe("II] Le constructeur ne verifie ni les decimales ni l'unicite des trois adresses", function () {
    describe("A) Decimales : un token a 18 decimales est accepte a cote de tokens a 8", function () {
      it("un deploiement avec MRN (18 decimales) en indice 1 revert avec InvalidTokenDecimals, pas avec succes", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        // MRN est deploye avec 18 decimales (MRN.sol, constructeur ERC20
        // standard, `decimals() = 18` par defaut). Le panier melange
        // donc 8 decimales (WBTC, LBTC) et 18 decimales (MRN). Aucun
        // require du constructeur ne le refuse (Pool.sol:140-143 sont
        // les quatre gardes existantes : frais, frais min, duree
        // d'epoque, fenetre ; aucun ne touche les jetons).
        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, [base.wbtc.address, base.mrn.address, base.lbtc.address]),
          "InvalidTokenDecimals",
        );
      });
    });

    describe("B) Unicite : deux jambes sur la meme adresse gele les retraits", function () {
      it("un deploiement avec token0 == token1 revert avec DuplicateToken, pas avec succes", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        // Le panier duplique WBTC a l'indice 0 et a l'indice 1. Le
        // constructeur ne dedoublonne pas (Pool.sol:152-154 sont trois
        // affectations separees, aucune ne compare les adresses entre
        // elles). Une fois deploye, `addLiquidity` croirait garnir deux
        // reserves distinctes alors qu'elles pointent sur le meme
        // solde ERC-20, et `removeLiquidity` gelerait sur le second
        // transfert sortant. Le test epingle la racine : le deploiement
        // aurait du etre refuse.
        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, [base.wbtc.address, base.wbtc.address, base.lbtc.address]),
          "DuplicateToken",
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Defaut 4
  // -------------------------------------------------------------------------

  describe("III] La garde de bande opere sur un etat simule distinct de l'etat ecrit", function () {
    it("apres un swap qui passe la garde de bande, la reserve entrante reelle est le NET du frais, pas le BRUT simule", async function () {
      const { pool, depositor, wbtc } = await networkHelpers.loadFixture(deployTokensAndSeededPoolFixture);

      const r0Before = BigInt(await pool.read.reserves([0n]));

      const swapAmount = 4000n;
      const feeNum = BigInt(await pool.read.feeNum());
      const baseAmount = (swapAmount * feeNum) / FEE_DEN;
      const protocolCut = (baseAmount * PROTOCOL_FEE_BPS) / SPLIT_DEN;
      const managerCut = 0n;
      const netIn = swapAmount - protocolCut - managerCut;

      await wbtc.write.approve([pool.address, swapAmount], { account: depositor.account });
      await pool.write.swap([0n, swapAmount, 2n, 0n], { account: depositor.account });

      const r0After = BigInt(await pool.read.reserves([0n]));

      const expectedReal = r0Before + netIn;
      assert.equal(
        r0After,
        expectedReal,
        `reserves[0] apres swap vaut ${r0After}, attendu ${expectedReal} (= ${r0Before} + ${netIn} : NET, pas BRUT)`,
      );

      const simulatedGross = r0Before + swapAmount;
      const divergence = simulatedGross - r0After;
      assert.equal(
        divergence,
        baseAmount,
        `divergence simule/rel vaut ${divergence}, attendu ${baseAmount} (= baseAmount, frais partage que la simulation ignore)`,
      );
      assert.ok(
        divergence > 0n,
        `simule et rel devraient diverger strictement (divergence=${divergence}), sinon la garde opere deja sur le NET`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Defaut 5
  // -------------------------------------------------------------------------

  describe("IV] Le frais arrondit a la troncature au profit de l'appelant", function () {
    async function deploySeededPoolWithManagerFixture() {
      const base = await networkHelpers.loadFixture(deployTokensFixture);
      const pool = await deployPoolWith(base);
      await bootstrapPool(base, pool, base.depositor);

      await pool.write.setAuction([base.attacker.account.address], {
        account: base.deployer.account,
      });
      const managerAddr = base.other.account.address;
      await pool.write.setManager([1n, managerAddr], {
        account: base.attacker.account,
      });

      const genesis = BigInt(await pool.read.GENESIS());
      const windowOpen = genesis + EPOCH_DURATION + 1n;
      await networkHelpers.time.setNextBlockTimestamp(windowOpen);
      await networkHelpers.mine();

      await pool.write.setFee([5n], { account: base.other.account });

      const effectiveAtSwap = BigInt(await pool.read.feeInForce());

      await base.wbtc.write.approve([pool.address, 21_000_000n * 10n ** 8n], {
        account: base.depositor.account,
      });

      return { ...base, pool, managerAddr, effectiveAtSwap };
    }

    it("un swap de 4000 sats collecte 2 sats de frais ; deux swaps de 1999 collectent 0", async function () {
      const ctx = await networkHelpers.loadFixture(deploySeededPoolWithManagerFixture);
      assert.equal(
        ctx.effectiveAtSwap,
        5n,
        `feeInForce vaut ${ctx.effectiveAtSwap} apres setFee(5), attendu 5`,
      );

      const swapAmount = 4000n;
      await ctx.pool.write.swap([0n, swapAmount, 2n, 0n], { account: ctx.depositor.account });
      const feesAfter1Swap = BigInt(await ctx.pool.read.feesOwed([ctx.managerAddr, 0n]));
      assert.equal(
        feesAfter1Swap,
        2n,
        `feesOwed[manager][0] apres 1 swap de ${swapAmount} vaut ${feesAfter1Swap}, attendu 2 (managerCut = 2 - 0)`,
      );

      const ctx2 = await networkHelpers.loadFixture(deploySeededPoolWithManagerFixture);
      const smallTicket = 1999n;
      for (let k = 0; k < 2; k++) {
        await ctx2.pool.write.swap([0n, smallTicket, 2n, 0n], {
          account: ctx2.depositor.account,
        });
      }
      const feesAfter2SmallSwaps = BigInt(await ctx2.pool.read.feesOwed([ctx2.managerAddr, 0n]));
      assert.equal(
        feesAfter2SmallSwaps,
        0n,
        `feesOwed[manager][0] apres 2 swaps de ${smallTicket} vaut ${feesAfter2SmallSwaps}, attendu 0 (1999*5/10000 = 0 par troncature)`,
      );

      // La troncature FLOOR fait que deux swaps de 1999 collectent 0+0=0 sats
      // de frais alors qu'un swap de 4000 collecte 2 sats. Les frais ne sont
      // PAS lineaires en la taille : un appelant qui fragmente son swap en
      // tickets trop petits pour atteindre la troncature paye moins que sa
      // part. La correction est ceilDiv sur baseAmount (et toutes les parts
      // qui en dependent) : apres le fix, chaque swap de 1999 collecte 1 sat
      // (ceilDiv(1999*5, 10000) = 1), les deux swaps collectent 2, et
      // l'egalite avec feesAfter1Swap tient. L'assertion ci-dessous etablit
      // l'invariant cible : fees lineaires en la taille, pas sous-additives.
      assert.equal(
        feesAfter1Swap,
        feesAfter2SmallSwaps,
        `1 swap de ${swapAmount} (fees=${feesAfter1Swap}) devrait rapporter autant que 2 swaps de ${smallTicket} (fees=${feesAfter2SmallSwaps}) ; troncature FLOOR sous-additive : floor(1999*5/10000)+floor(1999*5/10000)=0 mais floor(4000*5/10000)=2`,
      );
    });
  });
});

