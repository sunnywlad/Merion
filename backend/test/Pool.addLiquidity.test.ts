// Suite fonctionnelle TypeScript pour Pool.addLiquidity().
//
// Pourquoi TypeScript/viem plutot que Solidity ici : ces tests appellent le
// contrat exactement comme le fait le front, a travers l'ABI generee, et
// orchestrent trois ERC-20 (mint + approve) avant chaque depot. C'est de
// l'integration multi-contrats, le terrain naturel de la couche TS. La
// couche Solidity (fuzz + invariants, plus les cas qui exigent de forger
// l'etat par vm.store) est traitee a part (voir test/Pool.invariant.t.sol et
// test/Pool.forgedState.t.sol).
//
// Voir test/README.md pour la demarche complete et la liste des cas limites
// groupee par fonction.

import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContractFunctionRevertedError } from "viem";

const { viem, networkHelpers } = await network.create();

// ---------------------------------------------------------------------------
// Constantes du contrat (dupliquees ici en dur : Pool.sol est fige pour cette
// tache, on ne lit pas ces valeurs depuis le contrat).
// ---------------------------------------------------------------------------

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;
const MINIMUM_LIQUIDITY = 1000n;
const UINT72_MAX = 2n ** 72n - 1n;
const DEFAULT_FEE_NUM = 5n; // reprend la valeur du Pool.t.sol d'origine
const MIN_FEE_NUM = 1n; // _minFeeNum passe au constructeur, cf. PoolTestBase.sol
const ZERO_FEE_NUM = 0n;
const EPOCH_DURATION = 14400n; // 4h, cf. build-auction.md 5.0 bis
const PRIORITY_WINDOW = 12n; // cf. build-auction.md 5.0 bis

// Codes de panic Solidity utilises dans cette suite (Panic(uint256)).
const PANIC_ARITHMETIC_OVERFLOW = 17n; // 0x11
const PANIC_ARRAY_OUT_OF_BOUNDS = 50n; // 0x32

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Coeur commun a toutes les fixtures : deploie les 3 ERC-20 puis le pool avec
// le `feeNum` donne. Pas utilisable tel quel avec loadFixture (qui exige des
// fonctions nommees et sans argument pour son cache) : les deux fixtures
// ci-dessous sont de simples enveloppes nommees qui le figent a une valeur.
async function deployTokensAndPool(feeNum: bigint) {
  const [deployer, depositor, other, treasury] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  const tokens = [wbtc, cbbtc, lbtc] as const;

  const pool = await viem.deployContract("Pool", [
    [wbtc.address, cbbtc.address, lbtc.address],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    feeNum,
    treasury.account.address,
    deployer.account.address,
  ]);

  return { deployer, depositor, other, wbtc, cbbtc, lbtc, tokens, pool };
}

async function deployTokensAndPoolFixture() {
  return deployTokensAndPool(DEFAULT_FEE_NUM);
}

async function deployZeroFeeTokensAndPoolFixture() {
  return deployTokensAndPool(ZERO_FEE_NUM);
}

type PoolFixture = Awaited<ReturnType<typeof deployTokensAndPoolFixture>>;

// Mint `amount` des 3 tokens vers `account` et approuve le pool pour ce meme
// montant sur chacun. Suffit pour tout depot ancre sur un pool dont les trois
// reserves sont EGALES (l'amorcage l'est toujours, Pool.sol:93 : amounts[0]
// = amounts[1] = amounts[2] = _amount) : chaque jambe tire alors exactement
// le meme montant, quel que soit l'ancre choisie.
async function mintAndApprove(
  tokens: PoolFixture["tokens"],
  pool: PoolFixture["pool"],
  account: PoolFixture["depositor"],
  amount: bigint,
) {
  for (const token of tokens) {
    await token.write.mint([account.account.address, amount]);
    await token.write.approve([pool.address, amount], { account: account.account });
  }
}

// Mint et approuve, jambe par jambe, exactement ce qu'un depot ancre sur
// `anchor` va reellement tirer sur chacun des trois tokens : amounts[i] =
// ceilDiv(_amount * reservesBefore[i], reservesBefore[anchor]) (Pool.sol:108),
// la meme formule que le contrat sur la branche supply != 0. Necessaire des
// que le pool n'est plus egalement reparti entre les trois reserves (apres un
// swap, par exemple) : un `mintAndApprove` a montant unique sous-dimensionne
// alors les jambes qui pesent plus que l'ancre. Le +1n de marge absorbe
// l'arrondi vers le haut de ceilDiv, pour ne jamais laisser l'allowance a une
// unite pres de ce que le contrat va reellement demander.
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

async function mintAndApproveForAnchoredDeposit(
  tokens: PoolFixture["tokens"],
  pool: PoolFixture["pool"],
  account: PoolFixture["depositor"],
  anchor: 0n | 1n | 2n,
  amount: bigint,
  reservesBefore: [bigint, bigint, bigint],
) {
  for (let i = 0; i < 3; i++) {
    const legAmount = ceilDiv(amount * reservesBefore[i], reservesBefore[Number(anchor)]);
    await tokens[i].write.mint([account.account.address, legAmount]);
    await tokens[i].write.approve([pool.address, legAmount], { account: account.account });
  }
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

// Rejette avec le panic Solidity `expectedCode` (17n = 0x11, 50n = 0x32), et
// verifie que c'est bien celui-la.
//
// Route retenue, et pourquoi : un panic Solidity est une erreur ABI standard,
// Panic(uint256). viem la decode et la range dans un
// `ContractFunctionRevertedError` (son champ `.data` porte `errorName` et
// `args` deja decodes), quelque part dans la chaine `cause` de l'erreur levee
// par `write`. On remonte donc cette chaine jusqu'a le trouver, puis on
// verifie le nom ABI et l'argument numerique.
//
// Ecarte volontairement : chercher "0x11" par expression reguliere dans le
// message d'erreur, comme le suggerait une premiere version de ce helper.
// Ce motif hexadecimal peut apparaitre n'importe ou ailleurs dans le meme
// message (une adresse, un hash, un autre montant) : un test ainsi ecrit
// peut passer pour la mauvaise raison, en ne verifiant rien de la structure
// reelle de l'erreur.
async function assertPanic(promise: Promise<unknown>, expectedCode: bigint) {
  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    while (current !== undefined && current !== null) {
      if (current instanceof ContractFunctionRevertedError) {
        assert.deepEqual(
          { errorName: current.data?.errorName, code: current.data?.args?.[0] },
          { errorName: "Panic", code: expectedCode },
          `attendu un revert Panic(${expectedCode}), obtenu ${current.data?.errorName}(${current.data?.args})`,
        );
        return;
      }
      current = (current as { cause?: unknown }).cause;
    }
    assert.fail(
      `aucun ContractFunctionRevertedError trouve dans la chaine d'erreurs ; erreur recue : ${String(error)}`,
    );
    return;
  }
  assert.fail(`la fonction aurait du revert avec Panic(${expectedCode}), mais n'a pas revert`);
}

const SEED_AMOUNT = 100n * 10n ** 8n; // pool amorce a 100 (8 decimales) sur chaque reserve
// Amorcage a montants egaux (Pool.sol:93) : approuver SEED_AMOUNT a plat sur
// les trois tokens suffit pour n'importe quel ancre, les trois jambes tirant
// exactement le meme montant.
const EXPECTED_BOOTSTRAP_MINTED_SHARES = 3n * SEED_AMOUNT - MINIMUM_LIQUIDITY; // 29 999 999 000
const EXPECTED_BOOTSTRAP_TOTAL_SUPPLY = 3n * SEED_AMOUNT; // 30 000 000 000

async function deploySeededPoolFixture() {
  const base = await deployTokensAndPoolFixture();
  const { depositor, tokens, pool } = base;

  // Marge genereuse pour les depots/echanges additionnels effectues dans les
  // tests qui reutilisent cette fixture.
  const headroom = SEED_AMOUNT * 10n;
  await mintAndApprove(tokens, pool, depositor, headroom);

  await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

  return { ...base, seedAmount: SEED_AMOUNT };
}

// Fixture dediee au pool desequilibre (section II.D). feeNum = 0 ici, par
// choix delibere : avec des frais non nuls, le swap ci-dessous produirait des
// reserves qui ne se divisent pas proprement, et les depots "10% du pool"
// utilises dans toute la section D laisseraient un reste d'arrondi qui
// polluerait les assertions de ratio/proportionnalite. Le comportement des
// frais est deja couvert par les tests de swap (hors perimetre de ce
// fichier) ; cette fixture isole la seule arithmetique d'addLiquidity.
//
// Compose deployZeroFeeTokensAndPoolFixture plutot que de redeployer les 3
// ERC-20 et le pool en double : seul l'amorcage + le swap sont propres a
// cette fixture.
//
// Calcul a la main : amorcage a egalite (Pool.sol:93), _amount = 1000e8 =>
// reserves = [1000e8, 1000e8, 1000e8]. Swap de 250e8, token0 -> token2,
// feeNum = 0 :
//   amountOut = 250e8 * 1000e8 / (250e8 + 1000e8) = 250e8 * 1000e8 / 1250e8
//             = 200e8 (division exacte)
// Reserves apres le swap : [1250e8, 1000e8, 800e8]. token0 (wBTC) devient
// l'actif le plus ABONDANT (il a recu le swap), token2 (lBTC) le plus RARE
// (il en est sorti), token1 (cbBTC) reste au milieu, inchange par le swap.
// Bandes verifiees a la main (floor = 13, ceiling = 53, les trois passent) :
// sum = 3050e8, token0 = 40,98 %, token1 = 32,79 %, token2 = 26,23 %.
async function deployImbalancedPoolFixture() {
  const base = await deployZeroFeeTokensAndPoolFixture();
  const { depositor, tokens, pool } = base;

  const seedAmount = 1000n * 10n ** 8n;
  await mintAndApprove(tokens, pool, depositor, seedAmount * 10n);
  await pool.write.addLiquidity([0n, seedAmount, 0n], { account: depositor.account });

  const swapAmount = 250n * 10n ** 8n;
  await pool.write.swap([0n, swapAmount, 2n, 0n], { account: depositor.account });

  return { ...base, seedAmount };
}

// Verifie que deposer, ancre sur `anchor`, ne modifie pas la composition du
// pool desequilibre (le rapport entre les trois reserves). Factorisee ici
// pour etre appelee depuis trois `it` distincts, un par ancre : ce sont trois
// scenarios independants (un depot ancre sur token0 est une transaction
// differente d'un depot ancre sur token1), donc trois tests, chacun avec sa
// propre assertion.
async function assertCompositionPreservedWhenAnchoredOn(anchor: 0n | 1n | 2n) {
  const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
  const reservesBefore = await readReserves(pool);
  const depositAmount = reservesBefore[Number(anchor)] / 10n; // 10% de la reserve ancre

  // Reserves desequilibrees ([1250e8, 1000e8, 800e8]) : un montant flat sur
  // les trois tokens sous-dimensionne les jambes non ancrees des que l'ancre
  // n'est pas la plus grosse ; mintAndApproveForAnchoredDeposit calcule
  // exactement ce que chaque jambe va tirer.
  await mintAndApproveForAnchoredDeposit(tokens, pool, other, anchor, depositAmount, reservesBefore);
  await pool.write.addLiquidity([anchor, depositAmount, 0n], { account: other.account });

  const reservesAfter = await readReserves(pool);
  // On ne recalcule pas la formule interne (Pool.sol:108) : le depot choisi
  // vaut exactement 10% de la reserve ancre, et par construction (les 3
  // reserves de la fixture se divisent proprement par 10) chaque reserve doit
  // alors croitre de 10%, quelle que soit l'ancre. C'est cette croissance
  // uniforme, indépendante de l'ancre, qui est la propriete testee.
  const expectedReservesAfter = reservesBefore.map((r) => r + r / 10n) as [bigint, bigint, bigint];

  assert.deepEqual(
    reservesAfter,
    expectedReservesAfter,
    `composition modifiee par un depot ancre sur l'indice ${anchor} : avant=[${reservesBefore}], apres=[${reservesAfter}], attendu=[${expectedReservesAfter}]`,
  );
}

describe("Pool.addLiquidity", async function () {

  // ---------------------------------------------------------------------------
  // I] addLiquidity sur pool vide
  // ---------------------------------------------------------------------------

  describe("I] addLiquidity sur pool vide", function () {
    describe("A) Cas nominal", function () {
      it("mintedShares vaut 3 * _amount - MINIMUM_LIQUIDITY", async function () {
        // Amorcage a montants egaux (Pool.sol:91-98) : les trois jambes
        // recoivent _amount chacune, quel que soit l'ancre (elle n'est meme
        // pas lue sur cette branche, voir I.C ci-dessous).
        //   mintedShares = 3 * 10 000 000 000 - 1000 = 29 999 999 000
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const mintedShares = await pool.read.balanceOf([depositor.account.address]);
        assert.equal(
          mintedShares,
          EXPECTED_BOOTSTRAP_MINTED_SHARES,
          `mintedShares=${mintedShares}, attendu ${EXPECTED_BOOTSTRAP_MINTED_SHARES} (calcul a la main en commentaire)`,
        );
      });

      it("les trois reserves valent chacune _amount", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const reserves = await readReserves(pool);
        const expectedReserves: [bigint, bigint, bigint] = [SEED_AMOUNT, SEED_AMOUNT, SEED_AMOUNT];
        assert.deepEqual(
          reserves,
          expectedReserves,
          `reserves=[${reserves}], attendu=[${expectedReserves}] (amorcage a montants egaux)`,
        );
      });

      it("MINIMUM_LIQUIDITY est detenu par l'adresse morte", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const deadBalance = await pool.read.balanceOf([DEAD_ADDRESS]);
        assert.equal(
          deadBalance,
          MINIMUM_LIQUIDITY,
          `solde LP de l'adresse morte=${deadBalance}, attendu ${MINIMUM_LIQUIDITY}`,
        );
      });

      it("totalSupply() inclut les parts brulees vers l'adresse morte", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const totalSupply = await pool.read.totalSupply();
        assert.equal(
          totalSupply,
          EXPECTED_BOOTSTRAP_TOTAL_SUPPLY,
          `totalSupply=${totalSupply}, attendu ${EXPECTED_BOOTSTRAP_TOTAL_SUPPLY} (parts du deposant + MINIMUM_LIQUIDITY brulee, soit 3 * _amount)`,
        );
      });

      it("le solde du pool en chacun des trois tokens augmente de _amount", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const poolBalances = await readBalances(tokens, pool.address);
        const expectedBalances: [bigint, bigint, bigint] = [SEED_AMOUNT, SEED_AMOUNT, SEED_AMOUNT];
        assert.deepEqual(
          poolBalances,
          expectedBalances,
          `soldes du pool=[${poolBalances}], attendu=[${expectedBalances}]`,
        );
      });

      it("le solde du deposant en chacun des trois tokens diminue de _amount", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);
        const balancesBefore = await readBalances(tokens, depositor.account.address);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const balancesAfter = await readBalances(tokens, depositor.account.address);
        const spent = balancesBefore.map((before, i) => before - balancesAfter[i]);
        const expectedSpent: [bigint, bigint, bigint] = [SEED_AMOUNT, SEED_AMOUNT, SEED_AMOUNT];
        assert.deepEqual(
          spent,
          expectedSpent,
          `depense=[${spent}] (avant - apres), attendu=[${expectedSpent}]`,
        );
      });

      it("l'evenement AddedLiquidity est emis avec les bons arguments", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await viem.assertions.emitWithArgs(
          pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account }),
          pool,
          "AddedLiquidity",
          [depositor.account.address, [SEED_AMOUNT, SEED_AMOUNT, SEED_AMOUNT], EXPECTED_BOOTSTRAP_MINTED_SHARES],
        );
      });
    });

    describe("B) Reverts", function () {
      it("somme des trois jambes < MINIMUM_LIQUIDITY echoue par panic 0x11, pas par une erreur nommee", async function () {
        // Amorcage a egalite : la somme des trois jambes vaut 3 * _amount.
        // 3 * 333 = 999 < MINIMUM_LIQUIDITY (1000) : la soustraction
        // sous-flow avant meme d'atteindre le require de BadSlippage
        // (Pool.sol:91-92).
        const { pool, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        const tooSmallAmount = 333n;

        await assertPanic(
          pool.write.addLiquidity([0n, tooSmallAmount, 0n], { account: depositor.account }),
          PANIC_ARITHMETIC_OVERFLOW,
        );
      });

      it("_amount hors bornes uint72 sur pool vide : aucune garde ReserveOverflow, l'allowance manquante revert en premier", async function () {
        // Constat important : la branche d'amorcage (Pool.sol:90-99) ne porte
        // AUCUN require de type ReserveOverflow, contrairement a la branche
        // supply != 0 (Pool.sol:109) et a swap() (Pool.sol:144). Le cast
        // `uint72(amounts[i])` (Pool.sol:96) tronquerait silencieusement un
        // _amount hors bornes plutot que de revert. Ce n'est pas exploitable
        // en pratique : MockWrappedBTC est plafonne a 21 000 000e8
        // (ERC20Capped), tres en dessous de uint72.max (~4,7e21), donc aucun
        // depositor ne peut jamais reellement detenir/approuver un montant
        // pareil. Sans mint ni approve (comme ici), le premier echec reel
        // est simplement l'allowance manquante au moment du safeTransferFrom
        // (Pool.sol:115), sur le token d'indice 0.
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        const tooLargeAmount = UINT72_MAX + 1n;

        await viem.assertions.revertWithCustomError(
          pool.write.addLiquidity([0n, tooLargeAmount, 0n], { account: depositor.account }),
          tokens[0],
          "ERC20InsufficientAllowance",
        );
      });

      it("ordre des gardes sur pool vide : _minShares trop exigeant echoue par BadSlippage, avant meme un probleme d'allowance", async function () {
        // Le require de BadSlippage (Pool.sol:92) est le tout premier controle
        // de la branche d'amorcage, avant la moindre ecriture ou le moindre
        // transfert : un _minShares insatisfaisable y revert sans qu'aucun
        // mint ni approve ne soit necessaire, la preuve que ce require
        // s'execute avant tout safeTransferFrom.
        const { pool, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        const impossibleMinShares = EXPECTED_BOOTSTRAP_MINTED_SHARES + 1n;

        await viem.assertions.revertWithCustomError(
          pool.write.addLiquidity([0n, SEED_AMOUNT, impossibleMinShares], { account: depositor.account }),
          pool,
          "BadSlippage",
        );
      });
    });

    describe("C) Cas limites", function () {
      it("_minShares exactement egal aux parts mintees est accepte", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        // Ne doit pas revert : on attend juste que la promesse se resolve.
        await assert.doesNotReject(
          pool.write.addLiquidity([0n, SEED_AMOUNT, EXPECTED_BOOTSTRAP_MINTED_SHARES], { account: depositor.account }),
          "un _minShares egal aux parts mintees ne devrait pas revert",
        );
      });

      it("_anchorIndex hors bornes (99) sur un pool vide n'est jamais lu : le depot reussit normalement", async function () {
        // Sur la branche supply == 0 (Pool.sol:90-99), _anchorIndex n'apparait
        // dans AUCUNE expression : ni `cachedReserves[_anchorIndex]` (cette
        // variable n'existe meme pas sur cette branche), ni ailleurs. Un
        // index hors bornes n'a donc litteralement rien a heurter : le depot
        // se comporte exactement comme avec anchor = 0.
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([99n, SEED_AMOUNT, 0n], { account: depositor.account });

        const mintedShares = await pool.read.balanceOf([depositor.account.address]);
        assert.equal(
          mintedShares,
          EXPECTED_BOOTSTRAP_MINTED_SHARES,
          `mintedShares=${mintedShares} avec anchor=99, attendu ${EXPECTED_BOOTSTRAP_MINTED_SHARES} (identique a anchor=0, l'ancre est ignoree sur cette branche)`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // II] addLiquidity sur pool amorce
  // ---------------------------------------------------------------------------

  describe("II] addLiquidity sur pool amorce", function () {
    const ADD_AMOUNT = SEED_AMOUNT / 2n; // 50e8 : depot additionnel distinct du depot initial

    describe("A) Cas nominal", function () {
      it("mintedShares vaut supply * _amount / reserves[anchor]", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const supplyBefore = await pool.read.totalSupply();
        const reservesBefore = await readReserves(pool);

        await pool.write.addLiquidity([0n, ADD_AMOUNT, 0n], { account: depositor.account });

        const mintedShares = await pool.read.balanceOf([depositor.account.address]);
        const expectedTotalShares = EXPECTED_BOOTSTRAP_MINTED_SHARES + (supplyBefore * ADD_AMOUNT) / reservesBefore[0];
        assert.equal(
          mintedShares,
          expectedTotalShares,
          `solde LP du deposant=${mintedShares}, attendu ${expectedTotalShares} (supplyAvant=${supplyBefore}, reserveAncre=${reservesBefore[0]})`,
        );
      });

      it("chaque reserve croit de _amount * reserves[i] / reserves[anchor], arrondi au plafond entier (ceilDiv)", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const reservesBefore = await readReserves(pool);

        await pool.write.addLiquidity([0n, ADD_AMOUNT, 0n], { account: depositor.account });

        const reservesAfter = await readReserves(pool);
        const growth = reservesAfter.map((after, i) => after - reservesBefore[i]) as [bigint, bigint, bigint];
        const expectedGrowth = reservesBefore.map(
          (r) => ceilDiv(ADD_AMOUNT * r, reservesBefore[0]),
        ) as [bigint, bigint, bigint];
        assert.deepEqual(
          growth,
          expectedGrowth,
          `croissance des reserves=[${growth}], attendu=[${expectedGrowth}] (reservesAvant=[${reservesBefore}])`,
        );
      });

      it("sur un pool fraichement amorce, mintedShares est identique quel que soit l'ancre (les trois reserves sont egales)", async function () {
        // Consequence directe de l'amorcage a montants egaux : reserves[0] ==
        // reserves[1] == reserves[2] juste apres le premier depot, donc
        // mintedShares = supply * _amount / reserves[anchor] ne depend plus
        // du tout de l'ancre choisie. C'est une egalite a TROIS termes
        // desormais (et non plus seulement entre deux ancres qui partagent
        // le meme poids cible, comme du temps de l'amorcage pondere) :
        // comparaison intrinsequement collective, donc un seul it avec une
        // unique assertion, message listant les trois valeurs.
        const mintedSharesByAnchor: bigint[] = [];

        for (const anchor of [0n, 1n, 2n]) {
          const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
          await pool.write.addLiquidity([anchor, ADD_AMOUNT, 0n], { account: depositor.account });
          const mintedTotal = await pool.read.balanceOf([depositor.account.address]);
          mintedSharesByAnchor.push(mintedTotal);
        }

        assert.deepEqual(
          mintedSharesByAnchor,
          [mintedSharesByAnchor[0], mintedSharesByAnchor[0], mintedSharesByAnchor[0]],
          `mintedShares devrait etre identique pour les trois ancres : [${mintedSharesByAnchor}]`,
        );
      });

      it("un second deposant obtient des parts proportionnelles au premier", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const supplyBefore = await pool.read.totalSupply();
        const reservesBefore = await readReserves(pool);
        await mintAndApproveForAnchoredDeposit(tokens, pool, other, 0n, ADD_AMOUNT, reservesBefore);

        await pool.write.addLiquidity([0n, ADD_AMOUNT, 0n], { account: other.account });

        const otherShares = await pool.read.balanceOf([other.account.address]);
        const expectedShares = (supplyBefore * ADD_AMOUNT) / reservesBefore[0];
        assert.equal(
          otherShares,
          expectedShares,
          `parts du second deposant=${otherShares}, attendu ${expectedShares} (supplyAvant=${supplyBefore})`,
        );
      });
    });

    describe("B) Reverts", function () {
      it("une approbation insuffisante sur un seul des trois tokens revert (ERC-20)", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        // Reserves egales apres l'amorcage : les trois jambes tirent
        // exactement ADD_AMOUNT chacune, quel que soit l'ancre. Les deux
        // premiers tokens sont approuves pour exactement ce montant, le
        // troisieme (lbtc, index 2) ne l'est pas du tout : le transferFrom
        // sur lbtc doit revert avant la fin de la boucle (Pool.sol:114-116).
        await tokens[0].write.mint([other.account.address, ADD_AMOUNT]);
        await tokens[0].write.approve([pool.address, ADD_AMOUNT], { account: other.account });
        await tokens[1].write.mint([other.account.address, ADD_AMOUNT]);
        await tokens[1].write.approve([pool.address, ADD_AMOUNT], { account: other.account });
        await tokens[2].write.mint([other.account.address, ADD_AMOUNT]);
        // pas d'approve sur tokens[2]

        await viem.assertions.revertWithCustomError(
          pool.write.addLiquidity([0n, ADD_AMOUNT, 0n], { account: other.account }),
          tokens[2],
          "ERC20InsufficientAllowance",
        );
      });

      it("_amount == 0 : ZeroOutput, un depot qui ne mint aucune part est refuse", async function () {
        // La garde `mintedShares > 0` (Pool.sol:104) vit dans la branche
        // `supply != 0` seulement : sur la branche d'amorcage, mintedShares =
        // 3 * _amount - MINIMUM_LIQUIDITY ne peut pas valoir zero (3 *
        // _amount == 1000 n'a pas de solution entiere), un `require` y serait
        // du code mort. Sur pool vide, _amount == 0 sous-flow toujours en
        // panic 0x11, teste en I.B.
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.addLiquidity([0n, 0n, 0n], { account: depositor.account }),
          pool,
          "ZeroOutput",
        );
      });
    });

    describe("C) Cas limites", function () {
      it("_anchorIndex hors bornes (99) sur un pool amorce echoue par panic 0x32", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        // Sur la branche supply != 0, cachedReserves[_anchorIndex] est lu des
        // le calcul de mintedShares : un index hors bornes d'un tableau
        // memoire declenche un acces hors bornes (Pool.sol:103).

        await assertPanic(
          pool.write.addLiquidity([99n, SEED_AMOUNT, 0n], { account: depositor.account }),
          PANIC_ARRAY_OUT_OF_BOUNDS,
        );
      });
    });

    describe("D) Pool desequilibre", function () {
      describe("1) Composition et parts, independamment de la formule interne", function () {
        it("un depot ancre sur token0 ne modifie pas la composition du pool", async function () {
          await assertCompositionPreservedWhenAnchoredOn(0n);
        });

        it("un depot ancre sur token1 ne modifie pas la composition du pool", async function () {
          await assertCompositionPreservedWhenAnchoredOn(1n);
        });

        it("un depot ancre sur token2 ne modifie pas la composition du pool", async function () {
          await assertCompositionPreservedWhenAnchoredOn(2n);
        });

        it("ancre sur l'actif abondant, un apport de 10% du pool mint 10% du totalSupply precedent", async function () {
          // Le swap prealable de la fixture a fait grossir token0 (entrant) et
          // maigrir token2 (sortant), sans toucher token1 : l'actif le plus
          // abondant est desormais token0 (1250e8).
          const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const supplyBefore = await pool.read.totalSupply();
          const reservesBefore = await readReserves(pool);
          const depositAmount = reservesBefore[0] / 10n; // token0 = actif abondant (1250e8)

          await mintAndApproveForAnchoredDeposit(tokens, pool, other, 0n, depositAmount, reservesBefore);
          await pool.write.addLiquidity([0n, depositAmount, 0n], { account: other.account });

          const mintedShares = await pool.read.balanceOf([other.account.address]);
          const expectedShares = supplyBefore / 10n;
          assert.equal(
            mintedShares,
            expectedShares,
            `parts mintees=${mintedShares}, attendu 10% de supplyAvant (${supplyBefore}) = ${expectedShares}`,
          );
        });

        it("ancre sur l'actif rare, un apport de 10% du pool mint 10% du totalSupply precedent", async function () {
          // L'actif rare est token2 (lBTC, 800e8), celui qui est sorti lors du
          // swap prealable de la fixture.
          const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const supplyBefore = await pool.read.totalSupply();
          const reservesBefore = await readReserves(pool);
          const depositAmount = reservesBefore[2] / 10n; // token2 = actif rare (800e8)

          await mintAndApproveForAnchoredDeposit(tokens, pool, other, 2n, depositAmount, reservesBefore);
          await pool.write.addLiquidity([2n, depositAmount, 0n], { account: other.account });

          const mintedShares = await pool.read.balanceOf([other.account.address]);
          const expectedShares = supplyBefore / 10n;
          assert.equal(
            mintedShares,
            expectedShares,
            `parts mintees=${mintedShares}, attendu 10% de supplyAvant (${supplyBefore}) = ${expectedShares}`,
          );
        });
      });

      describe("2) Consequence observable du choix de l'ancre (calcul a la main)", function () {
        it("a _amount identique, ancrer sur l'actif abondant (token0) mint 24 000 000 000 parts", async function () {
          // totalSupply = 300 000 000 000 (= 3 * seedAmount : fixe depuis
          // l'amorcage, le swap qui desequilibre la fixture ne mint ni ne
          // brule aucune part LP, seule la COMPOSITION des reserves change,
          // pas leur somme rapportee au totalSupply)
          // reserves avant depot = [1250e8, 1000e8, 800e8] (cf. fixture)
          // mintedShares = totalSupply * amount / reserves[0]
          //              = 300 000 000 000 * 10 000 000 000 / 125 000 000 000
          //              = 24 000 000 000 (division exacte)
          const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const amount = 100n * 10n ** 8n;
          await mintAndApprove(tokens, pool, other, amount);

          await pool.write.addLiquidity([0n, amount, 0n], { account: other.account });

          const mintedShares = await pool.read.balanceOf([other.account.address]);
          const expectedShares = 24_000_000_000n;
          assert.equal(
            mintedShares,
            expectedShares,
            `parts mintees=${mintedShares}, attendu ${expectedShares} (calcul a la main en commentaire)`,
          );
        });

        it("a _amount identique, ancrer sur l'actif rare (token2) mint 37 500 000 000 parts", async function () {
          // totalSupply = 300 000 000 000 (cf. test voisin)
          // reserves avant depot = [1250e8, 1000e8, 800e8] (cf. fixture)
          // mintedShares = totalSupply * amount / reserves[2]
          //              = 300 000 000 000 * 10 000 000 000 / 80 000 000 000
          //              = 37 500 000 000 (division exacte)
          const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const amount = 100n * 10n ** 8n;
          const reservesBefore = await readReserves(pool);
          await mintAndApproveForAnchoredDeposit(tokens, pool, other, 2n, amount, reservesBefore);

          await pool.write.addLiquidity([2n, amount, 0n], { account: other.account });

          const mintedShares = await pool.read.balanceOf([other.account.address]);
          const expectedShares = 37_500_000_000n;
          assert.equal(
            mintedShares,
            expectedShares,
            `parts mintees=${mintedShares}, attendu ${expectedShares} (calcul a la main en commentaire)`,
          );
        });

        it("a _amount identique, l'ancre rare preleve plus sur la jambe non ancree que l'ancre abondante", async function () {
          // amount = 100e8, reserves = [1250e8, 1000e8, 800e8]. On compare le
          // prelevement sur TOKEN1 (jamais choisi comme ancre dans ce test) :
          //   ancre = token0 (abondant) : amounts[1] = ceilDiv(amount * reserves[1], reserves[0])
          //                                          = ceilDiv(10e9 * 100e9, 125e9) = 8 000 000 000
          //   ancre = token2 (rare)     : amounts[1] = ceilDiv(amount * reserves[1], reserves[2])
          //                                          = ceilDiv(10e9 * 100e9, 80e9) = 12 500 000 000
          // On lit les soldes reels plutot que de reappliquer la formule.
          const amount = 100n * 10n ** 8n;

          const abundant = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          await mintAndApprove(abundant.tokens, abundant.pool, abundant.other, amount);
          const token1BeforeAbundant = await abundant.tokens[1].read.balanceOf([abundant.other.account.address]);
          await abundant.pool.write.addLiquidity([0n, amount, 0n], { account: abundant.other.account });
          const token1AfterAbundant = await abundant.tokens[1].read.balanceOf([abundant.other.account.address]);
          const pulledAbundant = token1BeforeAbundant - token1AfterAbundant;

          // loadFixture restaure l'etat au snapshot (avant le depot ci-dessus)
          const rare = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const rareReservesBefore = await readReserves(rare.pool);
          await mintAndApproveForAnchoredDeposit(rare.tokens, rare.pool, rare.other, 2n, amount, rareReservesBefore);
          const token1BeforeRare = await rare.tokens[1].read.balanceOf([rare.other.account.address]);
          await rare.pool.write.addLiquidity([2n, amount, 0n], { account: rare.other.account });
          const token1AfterRare = await rare.tokens[1].read.balanceOf([rare.other.account.address]);
          const pulledRare = token1BeforeRare - token1AfterRare;

          assert.ok(
            pulledRare > pulledAbundant,
            `ancre rare devrait prelever plus sur token1 : rare=${pulledRare}, abondante=${pulledAbundant}`,
          );
        });
      });

      describe("3) Evenement avec des montants distincts", function () {
        it("l'evenement AddedLiquidity est emis avec des amountsIn distincts sur un pool desequilibre", async function () {
          // Ancre = token0 (abondant), amount = 100e8, reserves avant =
          // [1250e8, 1000e8, 800e8], mintedShares = 24 000 000 000 (cf. test
          // hardcode ci-dessus).
          // amounts[0] = amount                              = 10 000 000 000
          // amounts[1] = ceilDiv(amount * reserves[1], reserves[0]) =  8 000 000 000
          // amounts[2] = ceilDiv(amount * reserves[2], reserves[0]) =  6 400 000 000
          const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const amount = 100n * 10n ** 8n;
          await mintAndApprove(tokens, pool, other, amount);

          await viem.assertions.emitWithArgs(
            pool.write.addLiquidity([0n, amount, 0n], { account: other.account }),
            pool,
            "AddedLiquidity",
            [other.account.address, [10_000_000_000n, 8_000_000_000n, 6_400_000_000n], 24_000_000_000n],
          );
        });
      });

      describe("4) Arrondi (ceilDiv, G2) : la jambe non ancree grossit toujours au moins de la valeur tronquee, jamais moins", function () {
        it("un montant qui ne divise pas exactement force ceilDiv a arrondir vers le haut sur les deux jambes non ancrees", async function () {
          // Ancre = token1 (1000e8), amount = 333 (choisi expres pour ne
          // diviser exactement ni par 1250e8 ni par 800e8). Calcul a la main :
          //   amounts[0] = ceilDiv(333 * 1250e8, 1000e8)
          //              = ceilDiv(41 625 000 000 000, 100 000 000 000)
          //              = ceilDiv(416,25 ; ...) -> 417 (troncature aurait donne 416)
          //   amounts[2] = ceilDiv(333 * 800e8, 1000e8)
          //              = ceilDiv(26 640 000 000 000, 100 000 000 000)
          //              = ceilDiv(266,4 ; ...) -> 267 (troncature aurait donne 266)
          //   amounts[1] = 333 (l'ancre est toujours exacte, cf. Pool.sol:108)
          // C'est la meme regle que documente ailleurs dans la suite pour
          // removeLiquidity (troncature) et swap (troncature sur amountOut) :
          // l'arrondi va toujours vers le pool, jamais vers l'appelant. Ici,
          // le depositor PAIE l'arrondi (417 et 267, pas 416 et 266) : c'est
          // le pool qui en beneficie.
          const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const reservesBefore = await readReserves(pool);
          const amount = 333n;
          const headroom = 1000n; // marge large, largement suffisante pour des montants a trois chiffres
          await mintAndApprove(tokens, pool, other, headroom);
          const balancesBefore = await readBalances(tokens, other.account.address);

          await pool.write.addLiquidity([1n, amount, 0n], { account: other.account });

          const reservesAfter = await readReserves(pool);
          const balancesAfter = await readBalances(tokens, other.account.address);
          const growth = reservesAfter.map((after, i) => after - reservesBefore[i]);
          const spent = balancesBefore.map((before, i) => before - balancesAfter[i]);
          const expected = [417n, 333n, 267n];
          assert.deepEqual(
            growth,
            expected,
            `croissance des reserves=[${growth}], attendu=[${expected}] (calcul a la main : ceilDiv arrondit vers le haut)`,
          );
          assert.deepEqual(
            spent,
            expected,
            `montants preleves sur le deposant=[${spent}], attendu=[${expected}] : le depositor paie l'arrondi, pas le pool`,
          );
        });
      });
    });
  });
});
