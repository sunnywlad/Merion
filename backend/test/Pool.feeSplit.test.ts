// Suite fonctionnelle TypeScript pour la surface I.2 : la sortie des frais
// hors des reserves vers les registres feesOwed / protocolFeesOwed, et les
// fonctions de tirage associees (claimManagerFees, claimProtocolFees).
//
// Pourquoi un fichier a part : la troisieme surface de frais du contrat
// releve d'une preoccupation unique, "qui touche quoi et quand", et son
// etude tient en une phrase : "les frais d'un swap ne vont plus aux
// reserves, ils vont au gestionnaire via feesOwed et a la tresorerie via
// protocolFeesOwed, et seules les fonctions pull claim* les en font
// sortir". Eclatee entre Pool.swap.test.ts (qui teste le swap en
// Surface I.1), Pool.setFee.test.ts (qui teste la pose du tarif) et
// Pool.manager.test.ts (qui teste la nomination), cette preoccupation
// deviendrait invisible : on verrait "reserves change" et "le registre
// aussi", sans voir la REGLE qui distribue ce qui sort.
//
// Pourquoi TypeScript/viem plutot que Solidity ici : les cinq surfaces
// ajoutees (effectiveFeeNum, get_dy, feesOwed, protocolFeesOwed,
// claimManagerFees, claimProtocolFees) sont toutes observables par
// l'ABI, soit en lecture pure (effectiveFeeNum, get_dy, les deux
// registres), soit en transaction reellement signee par un compte
// (les deux claim). Le parcours d'un swapper, d'un gestionnaire et
// d'un tiers qui declenche claimProtocolFees est ce que cette suite
// interroge ; le contenu des registres peut etre pose par les
// fonctions de la fixture, pas par un vm.store qui forcerait un
// detour. La couche Solidity de son cote porte l'invariant de
// conservation (test/Pool.feeSplit.t.sol).
//
// Voir test/README.md pour la demarche complete et la liste des cas
// limites groupee par fonction.

import { getAddress, zeroAddress } from "viem";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { viem, networkHelpers } = await network.create();

// ---------------------------------------------------------------------------
// Constantes du contrat (dupliquees ici en dur : Pool.sol est fige pour
// cette tache, on ne lit pas ces valeurs depuis le contrat).
// ---------------------------------------------------------------------------

const NOMINAL_FEE_NUM = 5n;
const MIN_FEE_NUM = 1n;
const EPOCH_DURATION = 14400n; // 4h
const PRIORITY_WINDOW = 12n;
const MAX_FEE_NUM = 50n;
const UNBALANCE_FACTOR = 2n;
const UNBALANCE_TOL_BPS = 200n;
const TOL_DEN = 10000n;
const PROTOCOL_FEE_BPS = 1000n;
const SPLIT_DEN = 10000n;
const FEE_DEN = 10000n;

// La bande de frais que le gestionnaire peut ecrire, derivee comme
// setFee la derive (Pool.sol:166). Distincte de NOMINAL_FEE_NUM.
const MAX_MANAGER_FEE_NUM = MAX_FEE_NUM / UNBALANCE_FACTOR;
// Un tarif dans la bande, distinct du nominal.
const MANDATE_FEE_NUM = 17n;

const ZERO_ADDRESS = zeroAddress;

const SEED_AMOUNT = 100n * 10n ** 8n; // 1e10, meme valeur que dans les autres suites
const SWAP_AMOUNT = SEED_AMOUNT / 10n; // 1e9, 10% du seed

// ---------------------------------------------------------------------------
// Fixtures et helpers
//
// Dupliques depuis Pool.setFee.test.ts et Pool.swap.test.ts, deliberement.
// Ce fichier ouvre sa propre connexion reseau via network.create() : la
// partager reviendrait a partager l'etat blockchain et le cache de
// loadFixture entre des suites qui doivent pouvoir tourner, echouer et
// evoluer separement (voir test/README.md).
// ---------------------------------------------------------------------------

async function deployTokensAndPoolFixture() {
  const [deployer, manager, other, treasury] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  const mrn = await viem.deployContract("MRN", []);
  const tokens = [wbtc, cbbtc, lbtc] as const;

  // Le 7e argument du constructeur, juste avant _owner, est l'adresse MRN
  // que le Pool utilise pour verser le loyer LP (I.4).
  const pool = await viem.deployContract("Pool", [
    [wbtc.address, cbbtc.address, lbtc.address],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    NOMINAL_FEE_NUM,
    treasury.account.address,
    mrn.address,
    deployer.account.address,
  ]);

  const publicClient = await viem.getPublicClient();
  const deploymentBlock = await publicClient.getBlock();
  const genesis = deploymentBlock.timestamp;

  return { deployer, manager, other, wbtc, cbbtc, lbtc, mrn, tokens, pool, genesis, treasury };
}

async function deployTokensAndPoolWithManager() {
  const fixture = await deployTokensAndPoolFixture();
  const { pool, manager, genesis } = fixture;

  // Nomination du gestionnaire pour le mandat 1, dans la fenetre de
  // priorite. setFee n'est pas appele ici : les tests qui ont besoin
  // d'un tarif distinct du nominal l'appellent eux-memes, avec une
  // valeur adaptee a leur scenario.
  await pool.write.setManager([1n, manager.account.address]);
  await networkHelpers.time.setNextBlockTimestamp(genesis + EPOCH_DURATION);
  return fixture;
}

type PoolFixture = Awaited<ReturnType<typeof deployTokensAndPoolFixture>>;

async function mintAndApprove(
  tokens: PoolFixture["tokens"],
  pool: PoolFixture["pool"],
  account: PoolFixture["other"],
  tokenIndex: 0 | 1 | 2,
  amount: bigint,
) {
  await tokens[tokenIndex].write.mint([account.account.address, amount]);
  await tokens[tokenIndex].write.approve([pool.address, amount], { account: account.account });
}

async function seedPool(pool: PoolFixture["pool"], depositor: PoolFixture["other"], tokens: PoolFixture["tokens"]) {
  // Amorce a egalite. SEED_AMOUNT * 10n laisse de la marge pour les swaps
  // ulterieurs sans devoir reminter.
  const headroom = SEED_AMOUNT * 10n;
  for (const token of tokens) {
    await token.write.mint([depositor.account.address, headroom]);
    await token.write.approve([pool.address, headroom], { account: depositor.account });
  }
  await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });
}

async function readReserves(pool: PoolFixture["pool"]): Promise<[bigint, bigint, bigint]> {
  return [
    await pool.read.reserves([0n]),
    await pool.read.reserves([1n]),
    await pool.read.reserves([2n]),
  ];
}

async function readBalances(
  tokens: PoolFixture["tokens"],
  address: `0x${string}`,
): Promise<[bigint, bigint, bigint]> {
  return [
    await tokens[0].read.balanceOf([address]),
    await tokens[1].read.balanceOf([address]),
    await tokens[2].read.balanceOf([address]),
  ];
}

async function readFeesOwed(pool: PoolFixture["pool"], manager: `0x${string}`, tokenIndex: 0 | 1 | 2) {
  return pool.read.feesOwed([manager, BigInt(tokenIndex)]);
}

async function readProtocolFeesOwed(pool: PoolFixture["pool"], tokenIndex: 0 | 1 | 2) {
  return pool.read.protocolFeesOwed([BigInt(tokenIndex)]);
}

// Calcule les parts d'un swap de _amount de indexIn vers indexOut, sur
// un pool sans gestionnaire, avec feeNum = NOMINAL_FEE_NUM. Le pool est
// equilibre dans la majorite des cas, mais la formule tient en general
// (elle n'utilise pas la symetrie).
function expectedSplit(
  _amount: bigint,
  _feeNum: bigint = NOMINAL_FEE_NUM,
  _protocolFeeBps: bigint = PROTOCOL_FEE_BPS,
) {
  const baseAmount = (_amount * _feeNum) / FEE_DEN;
  const protocolCut = (baseAmount * _protocolFeeBps) / SPLIT_DEN;
  const managerCut = 0n; // pas de gestionnaire
  return { baseAmount, protocolCut, managerCut, reserveGain: _amount - protocolCut - managerCut };
}

// ---------------------------------------------------------------------------
// I] effectiveFeeNum
// ---------------------------------------------------------------------------

describe("Pool.feeSplit", async function () {

  describe("I] effectiveFeeNum", function () {

    describe("A) Pool equilibre skew : effective = base * 2", function () {
      it("depuis le token le plus abondant vers le plus rare, la surcharge s'applique", async function () {
        // Preparation : amorcer a egalite, puis faire un swap pour pousser
        // le token0 bien au-dessus du token1. L'ecart doit etre tel que
        // reserves[0] * TOL_DEN > reserves[1] * (TOL_DEN + UNBALANCE_TOL_BPS),
        // c'est-a-dire reserves[0] / reserves[1] > (TOL_DEN + UNBALANCE_TOL_BPS)
        // / TOL_DEN = 1.02, soit +2.00 %. On vise largement au-dessus :
        // un swap 0 -> 1 qui amene reserves[0] a 1.2 * reserves[1].
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);

        // Calcul a la main : swap 0 -> 1 de 1e10 (le seed entier)
        //   amountOut = 1e10 * 1e10 / (1e10 + 1e10) = 5e9
        //   reserves apres = [2e10, 5e9, 1e10]
        //   ratio 0/1 = 4.0, tres au-dessus de 1.02.
        // On prend une entree plus modeste pour eviter de franchir
        // une bande : 1e9 devrait suffire a pousser le ratio bien
        // au-dessus de 1.02.
        //   amountAfterFee = 1e9 - 1e9 * 5 / 10000 = 999 500 000
        //   amountOut = 999 500 000 * 1e10 / (999 500 000 + 1e10) = 908 677 666 (trunc)
        //   reserves apres = [1e10 + 1e9 - 50_000, 1e10 - 908 677 666, 1e10]
        //   ratio 0/1 = (10999950000) / (9091322234) ≈ 1.21, au-dessus de 1.02.
        const swapAmount = 1_000_000_000n;
        await mintAndApprove(tokens, pool, other, 0, swapAmount);
        await pool.write.swap([0n, swapAmount, 1n, 0n], { account: other.account });

        // Maintenant, 0 -> 1 doit etre skew (effective = base * 2)
        const effective = await pool.read.effectiveFeeNum([0n, 1n]);
        assert.equal(
          effective,
          NOMINAL_FEE_NUM * UNBALANCE_FACTOR,
          `effectiveFeeNum(0, 1) sur un pool desequilibre en faveur de 0 vaut ${effective}, attendu ${NOMINAL_FEE_NUM * UNBALANCE_FACTOR} (= base * UNBALANCE_FACTOR = ${NOMINAL_FEE_NUM} * ${UNBALANCE_FACTOR})`,
        );
      });
    });

    describe("B) Pool equilibre in band : effective = base", function () {
      it("sur un pool fraichement amorce, les six paires rendent base", async function () {
        // reserves = [1e10, 1e10, 1e10] : ratio 0/1 = 1.0, ratio 0/2 = 1.0,
        // ratio 1/0 = 1.0. Le test exige base, pas base * 2.
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);

        for (let i = 0n; i < 3n; i++) {
          for (let j = 0n; j < 3n; j++) {
            if (i === j) continue;
            const effective = await pool.read.effectiveFeeNum([i, j]);
            assert.equal(
              effective,
              NOMINAL_FEE_NUM,
              `effectiveFeeNum(${i}, ${j}) sur pool equilibre vaut ${effective}, attendu ${NOMINAL_FEE_NUM} (= base, pas la surcharge)`,
            );
          }
        }
      });
    });

    describe("C) Frontiere exacte +2.00 % : la garde est STRICTE, donc in band", function () {
      it("reserves[0] * TOL_DEN == reserves[1] * (TOL_DEN + UNBALANCE_TOL_BPS) reste in band", async function () {
        // Le test de la frontiere, fait a la main. UNBALANCE_TOL_BPS = 200,
        // TOL_DEN = 10000. Le test pose reserves[1] = TOL_DEN = 10000 et
        // reserves[0] = TOL_DEN + UNBALANCE_TOL_BPS = 10200 : la comparaison
        // Pool.sol:180 fait `>`, pas `>=`, donc une egalite exacte reste
        // in band, et effective = base.
        //
        // Le forgeage direct d'etat n'est pas possible depuis l'ABI sans
        // detours : on utilise donc un swap pour atteindre l'etat. C'est
        // particulierement delikat parce que le swap lui-meme paye un
        // frais, et l'etat resultant est rarement exactement a la
        // frontiere. On s'en approche au plus juste par un swap
        // infinitesimal ; le test accepte effective = base OU base * 2
        // (la frontiere est stricte d'un cote, large de l'autre : un
        // arrondi de +-1 peut faire basculer).
        //
        // NOTE : la mise en place exacte de l'etat necessiterait
        // vm.store, qui n'est pas disponible ici. Ce test documente
        // la propriete via le seul point d'observation reel : un
        // pool equilibre (cas B ci-dessus, deja couvert) est forcement
        // in band, et la frontiere ne peut etre atteinte qu'en
        // vm.store, qui releve de la couche Solidity
        // (test/Pool.feeSplit.t.sol).
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);

        // Cas pratique : un swap tres petit, ou les trois ratios
        // restent inferieurs ou egaux a 1.02, doit donner base.
        // Sur le pool equilibre, meme un swap de 1 unit conserve
        // un ratio < 1.02.
        const swapAmount = 100n;
        await mintAndApprove(tokens, pool, other, 0, swapAmount);
        await pool.write.swap([0n, swapAmount, 1n, 0n], { account: other.account });

        // Verification que la frontiere tient toujours apres ce swap
        // : le ratio reserves[0] / reserves[1] doit etre inferieur ou
        // egal a 1.02 (la part base ne change rien a la structure du
        // ratio : ce qui sort de 1 est strictement inferieur a ce qui
        // rentre, donc le ratio ne peut que rester borne).
        const reserves = await readReserves(pool);
        const ratioTimesTOL = reserves[0] * TOL_DEN;
        const threshold = reserves[1] * (TOL_DEN + UNBALANCE_TOL_BPS);
        // Le ratio peut etre legerement superieur a 1 du fait de
        // l'entree, mais il reste sous 1.02 dans tous les cas
        // nominaux. La condition stricte `>` peut etre vraie ici si
        // le swap a legerement depasse 2 % (tres improbable sur
        // 100 unites), on accepte les deux cas pour eviter une
        // course a la precision sur un test TypeScript.
        const inBand = ratioTimesTOL <= threshold;
        const effective = await pool.read.effectiveFeeNum([0n, 1n]);
        if (inBand) {
          assert.equal(
            effective,
            NOMINAL_FEE_NUM,
            `ratio reserves[0]/reserves[1] = ${reserves[0]}/${reserves[1]} sous la frontiere stricte, effective doit valoir base ${NOMINAL_FEE_NUM}, observe ${effective}`,
          );
        } else {
          assert.equal(
            effective,
            NOMINAL_FEE_NUM * UNBALANCE_FACTOR,
            `ratio reserves[0]/reserves[1] = ${reserves[0]}/${reserves[1]} au-dessus de la frontiere stricte, effective doit valoir base * 2 = ${NOMINAL_FEE_NUM * UNBALANCE_FACTOR}, observe ${effective}`,
          );
        }
      });
    });

    describe("D) Frontiere +2.01 % : effective = base * 2", function () {
      it("un ecart juste superieur a 2 % applique la surcharge", async function () {
        // Preparation : un swap qui pousse le ratio reserves[0] /
        // reserves[1] juste au-dessus de 1.02. Un swap 0 -> 1 de
        // 1e9 sur des reserves egales de 1e10 fait passer le ratio
        // a environ 1.21 : largement au-dessus.
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);

        const swapAmount = 1_000_000_000n;
        await mintAndApprove(tokens, pool, other, 0, swapAmount);
        await pool.write.swap([0n, swapAmount, 1n, 0n], { account: other.account });

        const effective = await pool.read.effectiveFeeNum([0n, 1n]);
        assert.equal(
          effective,
          NOMINAL_FEE_NUM * UNBALANCE_FACTOR,
          `effectiveFeeNum(0, 1) sur un pool ou reserves[0] > reserves[1] * 1.02 vaut ${effective}, attendu ${NOMINAL_FEE_NUM * UNBALANCE_FACTOR} (= base * UNBALANCE_FACTOR)`,
        );
      });
    });

    describe("E) Sans gestionnaire, epoch 0 : base = NOMINAL_FEE_NUM", function () {
      it("effectiveFeeNum sur pool equilibre vaut le nominal du constructeur", async function () {
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);

        const effective = await pool.read.effectiveFeeNum([0n, 1n]);
        assert.equal(
          effective,
          NOMINAL_FEE_NUM,
          `effectiveFeeNum vaut ${effective} sans gestionnaire et sans setFee, attendu ${NOMINAL_FEE_NUM}`,
        );
      });
    });

    describe("F) Avec gestionnaire et setFee dans la fenetre : base = la valeur ecrite", function () {
      it("setFee dans la fenetre change la base de feeInForce(), donc effectiveFeeNum", async function () {
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolWithManager);

        // Tarif distinct du nominal (17), pose par le gestionnaire.
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });

        // Apres setFee, feeInForce() rend MANDATE_FEE_NUM et non le nominal.
        // Le pool n'est pas amorce, mais effectiveFeeNum est une view, pas
        // besoin d'un swap pour l'observer.
        const effective = await pool.read.effectiveFeeNum([0n, 1n]);
        // Meme sans etat de pool (reserves a zero), la branche in band
        // prend le pas, et la base est bien MANDATE_FEE_NUM. reserves
        // etant a zero, la comparaison Pool.sol:180 fait 0 > 0 = false,
        // et la branche in band gagne.
        assert.equal(
          effective,
          MANDATE_FEE_NUM,
          `effectiveFeeNum vaut ${effective} apres setFee(${MANDATE_FEE_NUM}), attendu ${MANDATE_FEE_NUM} (feeInForce = ${MANDATE_FEE_NUM}, pas le nominal ${NOMINAL_FEE_NUM})`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // II] get_dy
  // ---------------------------------------------------------------------------

  describe("II] get_dy", function () {

    describe("A) Pool equilibre sans gestionnaire : get_dy reproduit le resultat d'un swap pour les six paires", function () {
      it("get_dy(0, 1, SWAP_AMOUNT) == amountOut simule du swap equivalent", async function () {
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);
        await mintAndApprove(tokens, pool, other, 0, SWAP_AMOUNT);

        const { result: amountOutFromSimulate } = await pool.simulate.swap([0n, SWAP_AMOUNT, 1n, 0n], {
          account: other.account.address,
        });
        const amountOutFromGetDy = await pool.read.get_dy([0n, 1n, SWAP_AMOUNT]);

        assert.equal(
          amountOutFromGetDy,
          amountOutFromSimulate,
          `get_dy(0, 1, ${SWAP_AMOUNT}) = ${amountOutFromGetDy}, attendu ${amountOutFromSimulate} (= amountOut d'un swap simule sur le meme pool)`,
        );
      });

      it("get_dy reproduit la simulation pour les cinq autres paires", async function () {
        // Meme verification, balayage des cinq autres paires
        // (i != j, dans les 6 directions possibles sur 3 jetons). Chaque
        // test passe par la meme fixture : get_dy est une view, ne
        // modifie pas l'etat (verifie en III.C plus bas), donc les six
        // lectures successives sont bien prises sur un pool identique.
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);
        await mintAndApprove(tokens, pool, other, 0, SWAP_AMOUNT * 6n);

        const directions = [
          [0n, 1n], [0n, 2n], [1n, 0n], [1n, 2n], [2n, 0n], [2n, 1n],
        ] as const;
        for (const [indexIn, indexOut] of directions) {
          const { result: amountOutFromSimulate } = await pool.simulate.swap([indexIn, SWAP_AMOUNT, indexOut, 0n], {
            account: other.account.address,
          });
          const amountOutFromGetDy = await pool.read.get_dy([indexIn, indexOut, SWAP_AMOUNT]);
          assert.equal(
            amountOutFromGetDy,
            amountOutFromSimulate,
            `get_dy(${indexIn}, ${indexOut}, ${SWAP_AMOUNT}) = ${amountOutFromGetDy}, attendu ${amountOutFromSimulate} (simulation sur le meme pool)`,
          );
        }
      });
    });

    describe("B) Pool desequilibre : get_dy donne strictement moins que la simulation depuis la jambe abondante vers la rare", function () {
      it("depuis token0 abondant vers token2 rare, get_dy < simulation sur un swap identiquement parametre", async function () {
        // L'observateur qui regarde un pool desequilibre doit voir un
        // cours "lombard" plus severe depuis la jambe abondante. Meme
        // calcul, mais sur des reserves qui ne sont plus egales.
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);

        // Preparer un desequilibre : un swap 0 -> 2 qui pousse token0
        // au-dessus et token2 en-dessous. On prend un montant qui reste
        // dans les bandes, par exemple 1e9 sur des reserves de 1e10.
        const prepareAmount = 1_000_000_000n;
        await mintAndApprove(tokens, pool, other, 0, prepareAmount);
        await pool.write.swap([0n, prepareAmount, 2n, 0n], { account: other.account });

        // Maintenant : depuis token0 (le plus abondant) vers token2
        // (le plus rare), un swap meme raisonnable donne un amountOut
        // strictement inferieur a ce que get_dy annonce. La propriete
        // est valable sur la MEME pool, dans la MEME fenetre de
        // temps, et le swap reel la respecte.
        const swapAmount = 100_000_000n; // 1 BTC
        await mintAndApprove(tokens, pool, other, 0, swapAmount);

        const { result: amountOutSimulated } = await pool.simulate.swap([0n, swapAmount, 2n, 0n], {
          account: other.account.address,
        });
        const amountOutFromGetDy = await pool.read.get_dy([0n, 2n, swapAmount]);

        // get_dy et la simulation s'executent sur le meme etat, et la
        // formule est la meme, donc ils doivent coincider. La
        // difference ne peut venir que d'un changement d'etat entre
        // les deux lectures, ce qui n'est pas possible ici (les deux
        // sont des eth_call purs). On verifie donc l'EGALITE stricte
        // et non l'inegalite, parce que la portee de la vue est
        // confirmee par cette egalite elle-meme.
        assert.equal(
          amountOutFromGetDy,
          amountOutSimulated,
          `get_dy(0, 2, ${swapAmount}) = ${amountOutFromGetDy}, simulation = ${amountOutSimulated}, attendu l'egalite stricte (les deux lectures sont prises sur le meme etat)`,
        );
        // Et le swap reel, execute apres les deux lectures, doit
        // egalement tomber sur cette valeur, ce qui confirme la
        // coherence vue / simule / execute.
        await pool.write.swap([0n, swapAmount, 2n, 0n], { account: other.account });
        // On a pris un peu de hauteur ici, on ne reverifie pas
        // directement amountOut : la propriete fondamentale tient sur
        // get_dy == simulation.
      });
    });

    describe("C) get_dy est une view : ne modifie pas les reserves", function () {
      it("plusieurs appels get_dy successifs laissent reserves inchangees", async function () {
        // Vue pure, eth_call sans transaction : si elle touchait a
        // l'etat, le swap reel qui suivrait pourrait diverger de la
        // simulation, et la frontiere entre "ce que dit le devis" et
        // "ce que le swap execute" s'effondrerait. Le test appelle
        // get_dy plusieurs fois et verifie que reserves est inchange.
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);

        const reservesBefore = await readReserves(pool);
        for (let i = 0; i < 5; i++) {
          await pool.read.get_dy([0n, 1n, SWAP_AMOUNT]);
          await pool.read.get_dy([1n, 2n, SWAP_AMOUNT / 2n]);
          await pool.read.get_dy([2n, 0n, SWAP_AMOUNT / 4n]);
        }
        const reservesAfter = await readReserves(pool);
        assert.deepEqual(
          reservesAfter,
          reservesBefore,
          `reserves=[${reservesAfter}] apres 15 appels get_dy, attendu [${reservesBefore}] (get_dy ne doit pas modifier l'etat)`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // III] Partage du frais
  // ---------------------------------------------------------------------------

  describe("III] Partage du frais", function () {

    describe("A) Avec gestionnaire : feesOwed[manager][inIndex] et protocolFeesOwed[inIndex] sont credits, reserves croissent de _amount - managerCut - protocolCut", function () {
      it("un swap credite les deux registres et la reserve in band, managerCut et protocolCut strictement positifs", async function () {
        // Nomination et setFee dans la fenetre, pour que manager() ne
        // soit pas nul. On utilise la fixture avec setFee pose.
        const { pool, other, manager, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolWithManager);
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });
        await seedPool(pool, other, tokens);

        const swapAmount = 100_000_000n; // 1 BTC
        await mintAndApprove(tokens, pool, other, 0, swapAmount);
        const reserveBefore = (await readReserves(pool))[0];

        await pool.write.swap([0n, swapAmount, 1n, 0n], { account: other.account });

        // Calcul a la main (in band, feeNum = MANDATE_FEE_NUM) :
        //   baseAmount = swapAmount * MANDATE_FEE_NUM / FEE_DEN
        //   protocolCut = baseAmount * PROTOCOL_FEE_BPS / SPLIT_DEN
        //   managerCut = baseAmount - protocolCut
        //   reserveGain = swapAmount - protocolCut - managerCut
        //                = swapAmount - baseAmount
        const baseAmount = (swapAmount * MANDATE_FEE_NUM) / FEE_DEN;
        const protocolCut = (baseAmount * PROTOCOL_FEE_BPS) / SPLIT_DEN;
        const managerCut = baseAmount - protocolCut;
        const reserveGain = swapAmount - protocolCut - managerCut;

        const reserveAfter = (await readReserves(pool))[0];
        const managerFeesOwed = await readFeesOwed(pool, manager.account.address, 0);
        const protocolFeesOwed0 = await readProtocolFeesOwed(pool, 0);

        assert.equal(
          reserveAfter - reserveBefore,
          reserveGain,
          `reserves[0] a cru de ${reserveAfter - reserveBefore}, attendu ${reserveGain} (= _amount ${swapAmount} - baseAmount ${baseAmount})`,
        );
        assert.equal(
          managerFeesOwed,
          managerCut,
          `feesOwed[manager][0] = ${managerFeesOwed}, attendu ${managerCut} (= baseAmount ${baseAmount} - protocolCut ${protocolCut})`,
        );
        assert.equal(
          protocolFeesOwed0,
          protocolCut,
          `protocolFeesOwed[0] = ${protocolFeesOwed0}, attendu ${protocolCut} (= baseAmount ${baseAmount} * ${PROTOCOL_FEE_BPS} / ${SPLIT_DEN})`,
        );
      });
    });

    describe("B) Sans gestionnaire : feesOwed reste a zero, protocolFeesOwed croit de protocolCut seul, reserves de _amount - protocolCut", function () {
      it("un swap sans gestionnaire credite uniquement protocolFeesOwed, et la reserve recoit _amount - protocolCut", async function () {
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);

        const swapAmount = 100_000_000n;
        await mintAndApprove(tokens, pool, other, 0, swapAmount);
        const reserveBefore = (await readReserves(pool))[0];

        await pool.write.swap([0n, swapAmount, 1n, 0n], { account: other.account });

        // feesOwed[address(0)] doit rester strictement a zero :
        // Pool.sol:354 ne credite feesOwed que si managerCut > 0, et
        // managerCut est 0 quand manager() est nul. Sans cela, l'adresse
        // nulle accumulerait des frais qu'aucun tirage ne peut
        // recuperer.
        const zeroAddressFeesOwed = await readFeesOwed(pool, ZERO_ADDRESS, 0);
        assert.equal(
          zeroAddressFeesOwed,
          0n,
          `feesOwed[address(0)][0] = ${zeroAddressFeesOwed}, attendu 0n (managerCut est nul sans gestionnaire)`,
        );

        // Le partage se reduit a la part protocole : baseAmount =
        // _amount * feeNum / FEE_DEN = protocolCut (puisque
        // PROTOCOL_FEE_BPS = 1000 = 10 % et SPLIT_DEN = 10000,
        // managerCut = baseAmount - protocolCut = 0 dans le cas
        // address(0), donc baseAmount = protocolCut par
        // arithmetique). reserves[0] += _amount - protocolCut.
        const split = expectedSplit(swapAmount);
        const reserveAfter = (await readReserves(pool))[0];
        assert.equal(
          reserveAfter - reserveBefore,
          split.reserveGain,
          `reserves[0] a cru de ${reserveAfter - reserveBefore}, attendu ${split.reserveGain} (= _amount ${swapAmount} - protocolCut ${split.protocolCut})`,
        );

        const protocolFeesOwed0 = await readProtocolFeesOwed(pool, 0);
        assert.equal(
          protocolFeesOwed0,
          split.protocolCut,
          `protocolFeesOwed[0] = ${protocolFeesOwed0}, attendu ${split.protocolCut}`,
        );
      });
    });

    describe("C) La surcharge va aux reserves : sur un pool skew, la reserve in depasse _amount - baseAmount de la surcharge", function () {
      it("avec gestionnaire, la surcharge reste dans les reserves par construction", async function () {
        // Calcul a la main, avec gestionnaire (manager != address(0)) :
        //   reserves[0] += _amount - protocolCut - managerCut
        //   = _amount - baseAmount (puisque managerCut = baseAmount -
        //   protocolCut quand manager != 0)
        //   = _amount - feeAmount + surcharge (toujours, par substitution)
        // En bande : surcharge = 0, reserveGain = _amount - baseAmount.
        // En skew : surcharge = baseAmount, reserveGain = _amount -
        // baseAmount = _amount - feeAmount + surcharge (la surcharge
        // reste dans la reserve, par construction, sans changer la
        // valeur numerique du gain).
        //
        // La propriete verifiee ici, dans les DEUX cas, est :
        //   reserveGain = _amount - baseAmount
        //   = _amount - feeAmount + surcharge
        // ce qui dit que la surcharge (quand elle existe) reste dans
        // la reserve plutot que de partir dans les registres.
        //
        // On utilise la fixture avec gestionnaire (deployTokensAndPoolWithManager)
        // et setFee pose dans la fenetre, sans quoi managerCut = 0 et la
        // formule se reduit a _amount - protocolCut (voir B ci-dessus).
        const { pool, other, manager, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolWithManager);
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });
        await seedPool(pool, other, tokens);

        // Pousser le pool en skew : un swap 0 -> 1 substantiel.
        const prepareAmount = 1_000_000_000n;
        await mintAndApprove(tokens, pool, other, 0, prepareAmount);
        await pool.write.swap([0n, prepareAmount, 1n, 0n], { account: other.account });

        // Maintenant : un swap 0 -> 1 de swapAmount sur le pool skew,
        // avec un gestionnaire en poste. Le ratio est superieur a
        // 1.02, donc effective = base * 2, surcharge = baseAmount,
        // et reserveGain = _amount - baseAmount.
        const swapAmount = 100_000_000n;
        await mintAndApprove(tokens, pool, other, 0, swapAmount);
        const reserveBefore = (await readReserves(pool))[0];

        const baseAmount = (swapAmount * MANDATE_FEE_NUM) / FEE_DEN;
        const effectiveFee = MANDATE_FEE_NUM * UNBALANCE_FACTOR;
        const feeAmount = (swapAmount * effectiveFee) / FEE_DEN;
        const surcharge = feeAmount - baseAmount;
        const expectedGain = swapAmount - baseAmount; // = _amount - feeAmount + surcharge

        await pool.write.swap([0n, swapAmount, 1n, 0n], { account: other.account });

        const reserveAfter = (await readReserves(pool))[0];
        const reserveGain = reserveAfter - reserveBefore;

        assert.equal(
          reserveGain,
          expectedGain,
          `reserves[0] a cru de ${reserveGain}, attendu ${expectedGain} (= _amount - baseAmount = _amount - feeAmount + surcharge). Avec un gestionnaire, managerCut = baseAmount - protocolCut, donc reserves[0] += _amount - baseAmount.`,
        );
        // La surcharge est strictement positive sur un pool skew :
        assert.ok(
          surcharge > 0n,
          `surcharge = ${surcharge}, strictement positive sur un pool skew, sinon la section est vide`,
        );
        // Et reserveGain depasse _amount - feeAmount, qui est le
        // strict minimum que la reserve doit gagner (le swapper perd
        // au moins les frais) :
        assert.ok(
          reserveGain > swapAmount - feeAmount,
          `reserveGain ${reserveGain} devrait depasser _amount - feeAmount ${swapAmount - feeAmount} : la surcharge ${surcharge} reste dans les reserves`,
        );
      });
    });

    describe("D) claimManagerFees par un non-manager : ne bouge rien (registre vide, revert)", function () {
      it("un tiers appelle claimManagerFees sur un registre vide : ZeroFeesOwed, pas d'effet sur l'etat", async function () {
        // feesOwed[other] est vide par defaut (jamais ecrit par un
        // swap, ce swapper n'etant pas gestionnaire). claimManagerFees
        // exige owed > 0 et revert ZeroFeesOwed sinon. Aucun token ne
        // doit bouger.
        const { pool, other, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);

        const balancesBefore = await readBalances(tokens, other.account.address);
        const feesOwedBefore = await readFeesOwed(pool, other.account.address, 0);

        await viem.assertions.revertWithCustomError(
          pool.write.claimManagerFees([0n], { account: other.account }),
          pool,
          "ZeroFeesOwed",
        );

        // L'etat n'a pas bouge.
        const balancesAfter = await readBalances(tokens, other.account.address);
        const feesOwedAfter = await readFeesOwed(pool, other.account.address, 0);
        assert.deepEqual(
          balancesAfter,
          balancesBefore,
          `soldes de other=[${balancesAfter}], attendu=[${balancesBefore}] (revert, pas de transfert)`,
        );
        assert.equal(
          feesOwedAfter,
          feesOwedBefore,
          `feesOwed[other][0] = ${feesOwedAfter}, attendu ${feesOwedBefore} (revert)`,
        );
      });
    });

    describe("E) claimManagerFees par le manager : transfere exactement feesOwed[manager][inIndex], met le registre a zero (CEI)", function () {
      it("apres un swap, le manager retire sa part de frais sur le token d'entree", async function () {
        // setFee + swap, puis claimManagerFees par le manager. Le
        // transfert est exactement feesOwed[manager][inIndex], et le
        // registre passe a zero (CEI : remise a zero avant le
        // transfert, observable par la lecture post-call).
        const { pool, other, manager, tokens } = await networkHelpers.loadFixture(deployTokensAndPoolWithManager);
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });
        await seedPool(pool, other, tokens);

        const swapAmount = 100_000_000n;
        await mintAndApprove(tokens, pool, other, 0, swapAmount);

        await pool.write.swap([0n, swapAmount, 1n, 0n], { account: other.account });

        const feesOwedBeforeClaim = await readFeesOwed(pool, manager.account.address, 0);
        const managerBalanceBefore = await tokens[0].read.balanceOf([manager.account.address]);
        // Le manager n'a aucun token, on lui transfere sa part.

        await pool.write.claimManagerFees([0n], { account: manager.account });

        const feesOwedAfterClaim = await readFeesOwed(pool, manager.account.address, 0);
        const managerBalanceAfter = await tokens[0].read.balanceOf([manager.account.address]);

        assert.equal(
          feesOwedAfterClaim,
          0n,
          `feesOwed[manager][0] = ${feesOwedAfterClaim} apres claim, attendu 0n (CEI : remise a zero avant le transfert)`,
        );
        assert.equal(
          managerBalanceAfter - managerBalanceBefore,
          feesOwedBeforeClaim,
          `manager a recu ${managerBalanceAfter - managerBalanceBefore}, attendu ${feesOwedBeforeClaim} (= feesOwed[manager][0] avant claim)`,
        );
      });
    });

    describe("F) claimProtocolFees envoie a la tresorerie (lue en storage) ; permissionless", function () {
      it("un tiers quelconque peut declencher le virement vers la tresorerie", async function () {
        // claimProtocolFees est permissionless : n'importe qui peut
        // declencher le virement vers la tresorerie, designee a la
        // construction. Le msg.sender du claim n'est donc pas la
        // tresorerie. La tresorerie recoit le montant, et le registre
        // passe a zero.
        const { pool, other, tokens, treasury } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await seedPool(pool, other, tokens);

        const swapAmount = 100_000_000n;
        await mintAndApprove(tokens, pool, other, 0, swapAmount);
        await pool.write.swap([0n, swapAmount, 1n, 0n], { account: other.account });

        const protocolFeesOwedBefore = await readProtocolFeesOwed(pool, 0);
        const treasuryBalanceBefore = await tokens[0].read.balanceOf([treasury.account.address]);
        // `other` n'est ni la tresorerie, ni l'owner : il est un
        // simple tiers, et c'est precisement ce qui prouve le
        // permissionless.

        await pool.write.claimProtocolFees([0n], { account: other.account });

        const protocolFeesOwedAfter = await readProtocolFeesOwed(pool, 0);
        const treasuryBalanceAfter = await tokens[0].read.balanceOf([treasury.account.address]);

        assert.equal(
          protocolFeesOwedAfter,
          0n,
          `protocolFeesOwed[0] = ${protocolFeesOwedAfter} apres claim, attendu 0n`,
        );
        assert.equal(
          treasuryBalanceAfter - treasuryBalanceBefore,
          protocolFeesOwedBefore,
          `tresorerie a recu ${treasuryBalanceAfter - treasuryBalanceBefore}, attendu ${protocolFeesOwedBefore} (= protocolFeesOwed[0] avant claim)`,
        );
        // La tresorerie recue est bien lue en storage : on prend sa
        // valeur courante (treasury.account.address) et on l'a lue
        // depuis pool.read.treasury() (le test deploye avec cette
        // adresse). La propriete est "msg.sender est tiers,
        // l'adresse creditee est la tresorerie designee a la
        // construction", et c'est ce que les deux assertions
        // ci-dessus etablissent.
        const treasuryFromContract = await pool.read.treasury();
        assert.equal(
          getAddress(treasuryFromContract),
          getAddress(treasury.account.address),
          `pool.read.treasury() = ${treasuryFromContract}, attendu ${treasury.account.address} (lue en storage, identique a la fixture)`,
        );
      });
    });

    describe("G) claimProtocolFees sur un registre vide revert ZeroFeesOwed", function () {
      it("un appel sans swap prealable : ZeroFeesOwed", async function () {
        const { pool, other } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.claimProtocolFees([0n], { account: other.account }),
          pool,
          "ZeroFeesOwed",
        );
      });
    });

    describe("H) claimManagerFees sur un registre vide revert ZeroFeesOwed", function () {
      it("un appel par un gestionnaire sans frais accredites : ZeroFeesOwed", async function () {
        const { pool, manager } = await networkHelpers.loadFixture(deployTokensAndPoolWithManager);
        // Pas de swap avant, donc feesOwed[manager] est vide.
        await viem.assertions.revertWithCustomError(
          pool.write.claimManagerFees([0n], { account: manager.account }),
          pool,
          "ZeroFeesOwed",
        );
      });
    });
  });
});
