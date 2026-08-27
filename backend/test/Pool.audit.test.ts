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
  mrnOverride: `0x${string}` | null = null,
) {
  const addresses = (tokens ?? base.tokenAddresses) as readonly [`0x${string}`, `0x${string}`, `0x${string}`];
  return viem.deployContract("Pool", [
    [...addresses],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    DEFAULT_FEE_NUM,
    treasuryOverride ?? base.treasury.account.address,
    mrnOverride ?? base.mrn.address,
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

// Pool amorce + un gestionnaire nomme pour l'epoch 1, tarif de base fixe a 5
// dans la fenetre de priorite. Partage par les describe III] et IV] : les deux
// ont besoin d'un manager pour que le partage (protocolCut, managerCut) soit
// non trivial. Motif : setAuction -> setManager -> saut dans la fenetre ->
// setFee(5). deployTokensFixture est appele directement (pas via loadFixture)
// comme deployTokensAndSeededPoolFixture, pour rester composable sous loadFixture.
async function deploySeededPoolWithManagerFixture() {
  const base = await deployTokensFixture();
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
      it("un deploiement avec un token a 18 decimales en indice 1 revert avec InvalidTokenDecimals, pas avec succes", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        // MRN est deploye avec 18 decimales (constructeur ERC20 standard,
        // `decimals() = 18` par defaut). On en deploie une SECONDE instance
        // pour tenir l'indice 1 du panier : elle a bien 18 decimales, mais
        // son adresse est distincte de `_mrn` (base.mrn), donc la garde
        // `_mrn` (Pool.sol:162) passe et c'est
        // `require(IERC20Metadata(token1).decimals() == 8, InvalidTokenDecimals())`
        // (Pool.sol:164) qui reprend la main. Le panier melange donc
        // 8 decimales (WBTC, LBTC) et 18 decimales (token18).
        const token18 = await viem.deployContract("MRN", []);
        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, [base.wbtc.address, token18.address, base.lbtc.address]),
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

    describe("C) MRN : adresse nulle ou collidee avec une jambe", function () {
      // Pool.sol:162 —
      // require(_mrn != address(0) && _mrn != token0 && _mrn != token1 && _mrn != token2, InvalidMrn())
      // `mrn` est immutable et sert d'assise au loyer du protocole ; une
      // adresse nulle ou confondue avec une jambe gelerait ce loyer sans
      // recours. Meme famille que InvalidTreasury (I]) et DuplicateToken (B).
      it("un deploiement avec _mrn = address(0) revert avec InvalidMrn, pas avec succes", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, undefined, undefined, "0x0000000000000000000000000000000000000000"),
          "InvalidMrn",
        );
      });

      it("un deploiement avec _mrn collide sur token0 revert avec InvalidMrn, pas avec succes", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, undefined, undefined, base.wbtc.address),
          "InvalidMrn",
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Caracterisation du partage des frais (voisin du defaut 4, PAS sa preuve)
  //
  // Ce describe NE pin PAS le defaut 4. Le fix `cbef81a` n'a touche que la
  // ligne de SIMULATION de la garde de bande (`afterSwapReserves[_indexIn]` :
  // `_amount` -> `amountInToReserves`) ; l'ECRITURE `reserves[_indexIn] +=
  // uint72(amountInToReserves)` etait deja sur le NET avant `cbef81a`. Comme
  // ce test n'observe QUE `reserves[0]` apres swap, il passerait a
  // l'identique sur `9bd8659` : il ne discrimine pas le fix.
  //
  // La vraie garde de bande sur le NET est epinglee par
  // `test_MaxInBandAmountIsExactlyTheBoundary` (`test/Pool.swap.t.sol`) : la
  // borne `MAX_IN_BAND_AMOUNT` a bouge de 76 624 746 076 a 76 627 560 281
  // PRECISEMENT parce que la simulation de la bande passe du brut au net.
  //
  // Ce que ce test caracterise a la place : l'arithmetique du partage des
  // frais sous un gestionnaire nomme. Sous un manager, `managerCut =
  // baseAmount - protocolCut` est non nul, donc la lamelle prelevee sur
  // l'entree (`protocolCut + managerCut`) est franche et l'egalite
  // `reserves[0] apres == reserves[0] avant + (brut - lamelle)` se lit sans
  // etre noyee par la troncature. Les trois assertions restent vraies et
  // utiles comme caracterisation ; aucune ne pretend demontrer le defaut 4.
  // -------------------------------------------------------------------------

  describe("III] Le partage des frais retire une lamelle des reserves entrantes", function () {
    it("sous un manager nomme, reserves[0] apres swap vaut l'etat d'avant plus le NET du frais (brut moins protocolCut moins managerCut)", async function () {
      // Fixture AVEC gestionnaire : sans manager, managerCut = 0 et la
      // divergence se reduit a protocolCut, minuscule et vite ecrasee par la
      // troncature. Un manager nomme rend le partage (protocolCut, managerCut)
      // = baseAmount, donc la lamelle est franche.
      const { pool, depositor, wbtc, effectiveAtSwap } =
        await networkHelpers.loadFixture(deploySeededPoolWithManagerFixture);

      assert.equal(
        effectiveAtSwap,
        5n,
        `feeInForce vaut ${effectiveAtSwap} apres setFee(5), attendu 5`,
      );

      const r0Before = BigInt(await pool.read.reserves([0n]));

      // baseAmount = swapAmount * 5 / 10000 doit valoir >= 100 pour survivre a
      // la troncature, donc swapAmount >= 200_000. A 1_000_000 sats :
      //   baseAmount        = 1_000_000 * 5 / 10000 = 500
      //   protocolCut       = 500 * 1000 / 10000     = 50
      //   managerCut        = 500 - 50               = 450   (un manager est nomme)
      //   amountInToReserves = 1_000_000 - 50 - 450  = 999_500
      // 1_000_000 sats est negligeable devant les reserves amorcees
      // (100_000e8 par jambe), donc le swap reste dans les bandes
      // floor 13 % / ceiling 53 %.
      const swapAmount = 1_000_000n;
      const feeInForceNum = BigInt(await pool.read.feeInForce());
      const baseAmount = (swapAmount * feeInForceNum) / FEE_DEN;
      const protocolCut = (baseAmount * PROTOCOL_FEE_BPS) / SPLIT_DEN;
      const managerCut = baseAmount - protocolCut;
      const amountInToReserves = swapAmount - protocolCut - managerCut;

      await wbtc.write.approve([pool.address, swapAmount], { account: depositor.account });
      await pool.write.swap([0n, swapAmount, 2n, 0n], { account: depositor.account });

      const r0After = BigInt(await pool.read.reserves([0n]));

      const expectedReal = r0Before + amountInToReserves;
      assert.equal(
        r0After,
        expectedReal,
        `reserves[0] apres swap vaut ${r0After}, attendu ${expectedReal} (= ${r0Before} + ${amountInToReserves} : NET du frais, pas BRUT)`,
      );

      const simulatedGross = r0Before + swapAmount;
      const divergence = simulatedGross - r0After;
      assert.equal(
        divergence,
        protocolCut + managerCut,
        `divergence simule/reel vaut ${divergence}, attendu ${protocolCut + managerCut} (= protocolCut + managerCut, la lamelle que la simulation naive r0 + swapAmount ignore)`,
      );
      assert.ok(
        divergence > 0n,
        `la lamelle du partage devrait etre strictement positive sous un manager nomme (divergence=${divergence}), sinon protocolCut + managerCut a ete ecrase par la troncature`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Defaut 5
  // -------------------------------------------------------------------------

  describe("IV] Le frais du pool ne recompense pas le fractionnement du swap", function () {
    // DECISION DE CONCEPTION (journal 03-III2-OUVERT.md, 11:28) : la linearite
    // du cut MANAGER est HORS perimetre du defaut 5. Le floor sur baseAmount /
    // protocolCut / managerCut est un partage INTERNE {protocole, manager} ->
    // {reserves LP} ; il ne fuit aucune valeur vers l'appelant et reste
    // deliberement en floor. Ce test n'observe donc QUE ce que l'appelant paie
    // et ne touche PLUS feesOwed[manager].
    it("le cout total en fractionnant un swap est superieur ou egal au cout en un seul coup", async function () {
      const ctx = await networkHelpers.loadFixture(deploySeededPoolWithManagerFixture);
      assert.equal(
        ctx.effectiveAtSwap,
        5n,
        `feeInForce vaut ${ctx.effectiveAtSwap} apres setFee(5), attendu 5`,
      );

      const oneShot = 4000n;
      const ticket = 1999n;

      // Une seule assertion, et elle passe par le VRAI contrat via
      // `simulate.swap`. (L'ancienne 1re assertion comparait
      // `2n * ceilDiv(1999n*5n, 10000n)` a `ceilDiv(4000n*5n, 10000n)` avec le
      // helper TS local : `2n >= 2n` calcule entierement hors chaine,
      // insensible a Pool.sol:362. Retiree — cf. rapport Pass A point 2.)
      //
      // Cout REEL paye par l'appelant sur des swaps reellement executes :
      // cost = _amount - amountOut, feeAmount pris par ceilDiv a Pool.sol:362.
      //   un coup     : feeAmount = ceilDiv(4000*5, 10000) = 2, dxNet = 3998,
      //                 cost = 4000 - out(3998)
      //   fractionne  : feeAmount = ceilDiv(1999*5, 10000) = 1 par ticket,
      //                 dxNet = 1998, cost = somme (1999 - out(1998))
      // Sur ce pool (reserves 1e13 par jambe) : costOneShot = 3, costSplit = 4.
      // Si L362 repassait en floor : le frais du ticket 1999 tomberait de
      // ceilDiv(9995,10000)=1 a floor=0 (dxNet 1999 au lieu de 1998), rendant
      // 1 sat par ticket a l'appelant -> costSplit = 2, tandis que costOneShot
      // reste 3 (4000*5 = 20000 est divisible par 10000, floor == ceil). La
      // 2e assertion casserait donc : 2 >= 3 est faux. Elle discrimine bien
      // un retour en floor de L362.
      const { result: outOneShot } = await ctx.pool.simulate.swap([0n, oneShot, 2n, 0n], {
        account: ctx.depositor.account.address,
      });
      const costOneShot = oneShot - outOneShot;

      const ctx2 = await networkHelpers.loadFixture(deploySeededPoolWithManagerFixture);
      let costSplit = 0n;
      for (let k = 0; k < 2; k++) {
        const { result: out } = await ctx2.pool.simulate.swap([0n, ticket, 2n, 0n], {
          account: ctx2.depositor.account.address,
        });
        costSplit += ticket - out;
        await ctx2.pool.write.swap([0n, ticket, 2n, 0n], { account: ctx2.depositor.account });
      }

      assert.ok(
        costSplit >= costOneShot,
        `cout reel en fractionnant (${costSplit}) < cout en un coup (${costOneShot}) : l'appelant gagnerait a fractionner`,
      );
    });
  });
});

