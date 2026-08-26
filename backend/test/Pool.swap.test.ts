// Suite fonctionnelle TypeScript pour Pool.swap().
//
// Pourquoi TypeScript/viem plutot que Solidity ici : meme raison que pour
// addLiquidity et removeLiquidity (voir test/README.md). Sur swap, le
// parcours utilisateur est le plus court des trois : un compte qui possede
// deja le token d'entree l'approuve UNE SEULE fois (pas de triple approve
// comme pour addLiquidity), puis envoie l'appel ; le pool lui transfere le
// token de sortie en retour, dans la meme transaction. Ca reste de
// l'orchestration a travers l'ABI : deux ERC-20 differents (entree et
// sortie) bougent dans le meme appel, avec de vrais comptes et de vrais
// soldes, pas un contrat de test qui joue lui-meme le role du token holder.
//
// Voir test/README.md pour la demarche complete, la liste des cas limites
// groupee par fonction, et pourquoi les fixtures ci-dessous sont dupliquees
// depuis Pool.addLiquidity.test.ts / Pool.removeLiquidity.test.ts plutot que
// partagees.

import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContractFunctionRevertedError } from "viem";

const { viem, networkHelpers } = await network.create();

// ---------------------------------------------------------------------------
// Constantes du contrat (dupliquees ici en dur : Pool.sol est fige pour cette
// tache, on ne lit pas ces valeurs depuis le contrat).
// ---------------------------------------------------------------------------

const UINT72_MAX = 2n ** 72n - 1n;
const DEFAULT_FEE_NUM = 5n; // reprend la valeur du Pool.t.sol d'origine
const MIN_FEE_NUM = 1n; // _minFeeNum passe au constructeur, cf. PoolTestBase.sol
const ZERO_FEE_NUM = 0n;

// Codes de panic Solidity utilises dans cette suite (Panic(uint256)).
const PANIC_DIVISION_BY_ZERO = 18n; // 0x12
const PANIC_ARRAY_OUT_OF_BOUNDS_ACCESS = 50n; // 0x32

// ---------------------------------------------------------------------------
// Fixtures et helpers
//
// Dupliquees depuis Pool.removeLiquidity.test.ts, deliberement. Ce fichier
// ouvre sa propre connexion reseau via network.create() : la partager avec
// les autres fichiers de test reviendrait a partager l'etat blockchain et le
// cache de loadFixture entre des fichiers qui tournent independamment, ce
// qui est fragile (voir test/README.md pour la discussion complete).
// ---------------------------------------------------------------------------

async function deployTokensAndPool(feeNum: bigint) {
  const [deployer, depositor, other] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  const tokens = [wbtc, cbbtc, lbtc] as const;

  const pool = await viem.deployContract("Pool", [
    [wbtc.address, cbbtc.address, lbtc.address],
    feeNum,
    deployer.account.address,
    MIN_FEE_NUM,
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
// montant sur chacun. Utilise ici uniquement pour amorcer les fixtures
// (addLiquidity exige bien les trois approves) : un swap seul n'a jamais
// besoin de plus d'un token approuve, voir mintAndApproveSingleToken.
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

// Mint `amount` d'UN SEUL token (celui d'indice `tokenIndex`) vers `account`
// et approuve le pool pour ce meme montant sur ce seul token. C'est le
// parcours reel d'un swapper : swap() ne fait qu'un seul transferFrom
// entrant, sur le token d'indice _indexIn, il n'y a donc jamais lieu
// d'approuver les deux autres.
async function mintAndApproveSingleToken(
  tokens: PoolFixture["tokens"],
  pool: PoolFixture["pool"],
  account: PoolFixture["other"],
  tokenIndex: 0 | 1 | 2,
  amount: bigint,
) {
  await tokens[tokenIndex].write.mint([account.account.address, amount]);
  await tokens[tokenIndex].write.approve([pool.address, amount], { account: account.account });
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

// Rejette avec le panic Solidity `expectedCode`, et verifie que c'est bien
// celui-la. Voir Pool.addLiquidity.test.ts pour la justification complete de
// cette route (remonter la chaine `cause` jusqu'a un
// ContractFunctionRevertedError, plutot que chercher le code hex par regex
// dans le message d'erreur, qui peut matcher n'importe quoi d'autre).
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

// Meme amorcage que deploySeededPoolFixture, mais feeNum = 0 : necessaire au
// test qui compare a entree identique le montant rendu par un pool sans
// frais a celui d'un pool a feeNum = 5 (II.D), ce qu'un seul pool ne peut pas
// montrer a lui seul.
async function deployZeroFeeSeededPoolFixture() {
  const base = await deployZeroFeeTokensAndPoolFixture();
  const { depositor, tokens, pool } = base;

  const headroom = SEED_AMOUNT * 10n;
  await mintAndApprove(tokens, pool, depositor, headroom);

  await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

  return { ...base, seedAmount: SEED_AMOUNT };
}

// _amount du cas nominal (II.A) : 10% de SEED_AMOUNT, choisi comme dans
// removeLiquidity pour son calcul propre.
const NOMINAL_SWAP_AMOUNT_IN = SEED_AMOUNT / 10n; // 1 000 000 000
// Amorcage a montants egaux (Pool.sol:93) : reserves = [1e10, 1e10, 1e10].
// Calcul a la main (feeNum = 5, FEE_DEN = 10000, n'importe quelle paire,
// puisque les trois reserves sont identiques) :
//   amountAfterFee = 1e9 * (10000 - 5) / 10000 = 999 500 000
//   amountOut = 999 500 000 * 1e10 / (999 500 000 + 1e10)
//             = 9 995 000 000 000 000 000 / 10 999 500 000
//             = 908 677 667 (tronque vers le bas)
// Contrairement a l'amorcage pondere d'avant, cette valeur vaut desormais
// pour les SIX paires indistinctement : les trois reserves de depart sont
// identiques, donc reserveIn == reserveOut pour n'importe quel couple.
const NOMINAL_SWAP_AMOUNT_OUT = 908_677_667n;

// Fixture dediee au pool desequilibre (section II.E et II.F). feeNum = 0, par
// choix delibere, comme dans les deux autres fichiers de la suite : les
// montants poses en dur en II.E/II.F supposent des reserves exactes, qu'un
// feeNum non nul ne garantirait pas.
//
// Calcul a la main : amorcage a egalite, _amount = 1000e8 => reserves =
// [1000e8, 1000e8, 1000e8]. Swap de 250e8, token0 -> token2, feeNum = 0 :
//   amountOut = 250e8 * 1000e8 / (250e8 + 1000e8) = 200e8 (division exacte)
// Reserves apres le swap : [1250e8, 1000e8, 800e8]. token0 devient l'actif le
// plus ABONDANT (il a recu le swap), token2 le plus RARE (il en est sorti),
// token1 reste l'intermediaire, inchange par le swap.
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

// Effectue un swap de NOMINAL_SWAP_AMOUNT_IN entre les deux indices donnes,
// sur un pool amorce fraichement charge, et verifie en une seule assertion
// que le triplet des deltas de solde du swapper correspond exactement au
// sens du swap : -_amount sur indexIn, +expectedOut sur indexOut, 0 sur le
// troisieme token. Factorisee pour etre appelee depuis les six `it` de la
// section II.B : chaque paire est une transaction ABI distincte (_indexIn et
// _indexOut different a chaque fois), donc un comportement a verifier
// separement, avec sa propre fixture fraiche et sa propre assertion.
async function assertSwapYieldsExpectedDeltas(indexIn: 0 | 1 | 2, indexOut: 0 | 1 | 2) {
  const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
  await mintAndApproveSingleToken(tokens, pool, other, indexIn, NOMINAL_SWAP_AMOUNT_IN);
  const balancesBefore = await readBalances(tokens, other.account.address);

  await pool.write.swap([BigInt(indexIn), NOMINAL_SWAP_AMOUNT_IN, BigInt(indexOut), 0n], {
    account: other.account,
  });

  const balancesAfter = await readBalances(tokens, other.account.address);
  const delta = balancesBefore.map((before, i) => balancesAfter[i] - before) as [bigint, bigint, bigint];
  const expected: [bigint, bigint, bigint] = [0n, 0n, 0n];
  expected[indexIn] = -NOMINAL_SWAP_AMOUNT_IN;
  expected[indexOut] = NOMINAL_SWAP_AMOUNT_OUT;
  assert.deepEqual(
    delta,
    expected,
    `paire (${indexIn} -> ${indexOut}) : deltas de solde=[${delta}], attendu=[${expected}]`,
  );
}

describe("Pool.swap", async function () {

  // ---------------------------------------------------------------------------
  // I] Gardes structurelles
  // ---------------------------------------------------------------------------

  describe("I] Gardes structurelles", function () {
    describe("A) Pool vierge (aucun addLiquidity, les trois reserves a zero)", function () {
      it("_amount > 0 sur un pool vierge : ZeroOutput, faute de reserve de sortie", async function () {
        // Les trois reserves valent 0 : amountAfterFee est strictement
        // positif (95% de _amount, feeNum = 5), mais amountOut =
        // amountAfterFee * 0 / (amountAfterFee + 0) = 0 quel que soit
        // amountAfterFee, puisque cachedReserves[_indexOut] = 0.
        // Cette garde empeche ce qui se passait avant son ajout : le
        // transferFrom entrant (Pool.sol:161) s'executait quand meme, et le
        // swapper payait _amount pour ne rien recevoir en retour.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        const amount = 1_000_000_000n;
        await mintAndApproveSingleToken(tokens, pool, other, 0, amount);

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, amount, 2n, 0n], { account: other.account }),
          pool,
          "ZeroOutput",
        );
      });

      it("_amount == 0 sur un pool vierge : panic 0x12 (division par zero)", async function () {
        // Le denominateur de la division qui calcule amountOut (Pool.sol:140)
        // vaut amountAfterFee + cachedReserves[_indexIn] = 0 + 0 : cette
        // division precede tous les require de la fonction, donc cette
        // branche reste atteignable sur un contrat tout juste deploye, avant
        // meme que ZeroOutput ait la moindre chance de s'executer.
        const { pool, other } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await assertPanic(
          pool.write.swap([0n, 0n, 2n, 0n], { account: other.account }),
          PANIC_DIVISION_BY_ZERO,
        );
      });
    });

    // B) InsufficientReserve : garde non atteignable par l'ABI, donc aucun test ici.
    // La garde `cachedReserves[_indexOut] > amountOut` (Pool.sol:143) ne
    // peut se declencher que si la reserve d'ENTREE est nulle : des que
    // cachedReserves[_indexIn] > 0, amountOut = amountAfterFee *
    // reserveOut / (amountAfterFee + reserveIn) est strictement inferieur
    // a reserveOut par construction de la formule (le denominateur excede
    // toujours le numerateur d'au moins reserveIn > 0). Or, une fois
    // ZeroOutput en place (I.A ci-dessus), l'etat "reserve d'entree nulle,
    // reserve de sortie garnie" n'est plus atteignable par l'ABI :
    // addLiquidity garnit les trois reserves ensemble a l'amorcage,
    // removeLiquidity laisse toujours un residu (les parts mortes
    // MINIMUM_LIQUIDITY ne sont jamais brulees), et swap lui-meme ne peut
    // plus vider une reserve jusqu'a zero (c'est precisement ce
    // qu'empeche cette garde). Le seul moyen de l'exercer aujourd'hui est
    // de forger l'etat directement (vm.store sur le slot de reserves) dans
    // un test Solidity : voir test/Pool.invariant.t.sol,
    // test_InsufficientReserveReachedViaForgedState.
  });

  // ---------------------------------------------------------------------------
  // II] swap sur pool amorce, feeNum = 5
  // ---------------------------------------------------------------------------

  describe("II] swap sur pool amorce, feeNum = 5", function () {
    describe("A) Cas nominal", function () {
      it("le swapper recoit exactement 904 956 798 du token de sortie", async function () {
        // Calcul a la main : voir le commentaire de NOMINAL_SWAP_AMOUNT_OUT.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const balanceBefore = (await readBalances(tokens, other.account.address))[2];

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });

        const balanceAfter = (await readBalances(tokens, other.account.address))[2];
        const received = balanceAfter - balanceBefore;
        assert.equal(
          received,
          NOMINAL_SWAP_AMOUNT_OUT,
          `recu=${received}, attendu ${NOMINAL_SWAP_AMOUNT_OUT} (calcul a la main en commentaire)`,
        );
      });

      it("le solde du swapper en token d'entree baisse exactement de _amount", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const balanceBefore = (await readBalances(tokens, other.account.address))[0];

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });

        const balanceAfter = (await readBalances(tokens, other.account.address))[0];
        const spent = balanceBefore - balanceAfter;
        assert.equal(
          spent,
          NOMINAL_SWAP_AMOUNT_IN,
          `depense=${spent} (avant=${balanceBefore}, apres=${balanceAfter}), attendu exactement _amount=${NOMINAL_SWAP_AMOUNT_IN}`,
        );
      });

      it("reserves[0] (le token d'entree) augmente exactement de _amount, frais compris", async function () {
        // amountAfterFee (95% de _amount) est ce qui sert au calcul du prix,
        // mais c'est bien le montant PLEIN _amount qui entre en reserve
        // (Pool.sol:158 : reserves[_indexIn] += uint72(_amount), pas
        // uint72(amountAfterFee)). C'est precisement la que les frais
        // s'accumulent, au benefice des LP plutot que d'etre extraits du
        // pool.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const reserveBefore = (await readReserves(pool))[0];

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });

        const reserveAfter = (await readReserves(pool))[0];
        const gain = reserveAfter - reserveBefore;
        assert.equal(
          gain,
          NOMINAL_SWAP_AMOUNT_IN,
          `reserves[0] a augmente de ${gain}, attendu le montant PLEIN _amount=${NOMINAL_SWAP_AMOUNT_IN} (pas amountAfterFee)`,
        );
      });

      it("reserves[2] (le token de sortie) baisse exactement de ce que le swapper a recu", async function () {
        // Conservation : on compare deux lectures on-chain (le delta de la
        // reserve de sortie et ce que le swapper a effectivement recu) sans
        // reimplementer la formule interne (Pool.sol:140) en TS.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const reserveBefore = (await readReserves(pool))[2];
        const balanceBefore = (await readBalances(tokens, other.account.address))[2];

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });

        const reserveAfter = (await readReserves(pool))[2];
        const balanceAfter = (await readBalances(tokens, other.account.address))[2];
        const reserveDrop = reserveBefore - reserveAfter;
        const received = balanceAfter - balanceBefore;
        assert.equal(
          reserveDrop,
          received,
          `baisse de reserves[2]=${reserveDrop}, recu par le swapper=${received} : ces deux lectures on-chain devraient etre identiques`,
        );
      });

      it("reserves[1], le token non implique dans le swap, reste inchangee", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const reserveBefore = (await readReserves(pool))[1];

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });

        const reserveAfter = (await readReserves(pool))[1];
        assert.equal(
          reserveAfter,
          reserveBefore,
          `reserves[1] a bouge : avant=${reserveBefore}, apres=${reserveAfter}, attendu inchangee`,
        );
      });

      it("les soldes ERC-20 du pool sur les tokens 0 et 2 suivent exactement les deltas de reserves", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const reservesBefore = await readReserves(pool);
        const poolBalancesBefore = await readBalances(tokens, pool.address);

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });

        const reservesAfter = await readReserves(pool);
        const poolBalancesAfter = await readBalances(tokens, pool.address);
        const reserveDeltas: [bigint, bigint] = [
          reservesAfter[0] - reservesBefore[0],
          reservesAfter[2] - reservesBefore[2],
        ];
        const balanceDeltas: [bigint, bigint] = [
          poolBalancesAfter[0] - poolBalancesBefore[0],
          poolBalancesAfter[2] - poolBalancesBefore[2],
        ];
        assert.deepEqual(
          balanceDeltas,
          reserveDeltas,
          `deltas de solde du pool (0, 2)=[${balanceDeltas}], deltas de reserves (0, 2)=[${reserveDeltas}] : ces deux lectures on-chain devraient etre identiques`,
        );
      });

      it("la valeur de retour amountOut vaut 904 956 798", async function () {
        // Route retenue : pool.simulate.swap(...) execute un appel
        // (eth_call) sans envoyer de transaction, et renvoie { result,
        // request } ; result est la valeur de retour ABI-decodee de la
        // fonction, exactement ce que produirait le `write` correspondant
        // (voir Pool.removeLiquidity.test.ts pour la justification
        // detaillee de account: other.account.address plutot que
        // other.account, propre a `simulate`).
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);

        const { result: amountOut } = await pool.simulate.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], {
          account: other.account.address,
        });

        assert.equal(
          amountOut,
          NOMINAL_SWAP_AMOUNT_OUT,
          `amountOut simule=${amountOut}, attendu=${NOMINAL_SWAP_AMOUNT_OUT} (calcul a la main en commentaire)`,
        );
      });

      it("l'evenement Swapped est emis avec ses cinq arguments", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);

        await viem.assertions.emitWithArgs(
          pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account }),
          pool,
          "Swapped",
          [other.account.address, 0n, NOMINAL_SWAP_AMOUNT_IN, 2n, NOMINAL_SWAP_AMOUNT_OUT],
        );
      });

      it("totalSupply() du token LP reste inchange : un swap ne mint ni ne brule aucune part", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const supplyBefore = await pool.read.totalSupply();

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });

        const supplyAfter = await pool.read.totalSupply();
        assert.equal(
          supplyAfter,
          supplyBefore,
          `totalSupply a bouge : avant=${supplyBefore}, apres=${supplyAfter}, attendu inchange`,
        );
      });
    });

    describe("B) Balayage des six paires (indexIn, indexOut) distinctes", function () {
      // Sur ce pool amorce a montants egaux, les six paires rendent
      // desormais TOUTES le meme amountOut pour la meme entree : les trois
      // reserves de depart sont identiques (contrairement a l'amorcage
      // pondere d'avant, ou seule la symetrie cbBTC/lBTC survivait). On les
      // teste quand meme une par une, et non via une seule boucle englobee
      // dans un `it` : chaque paire est une transaction ABI distincte
      // (_indexIn et _indexOut different a chaque appel), donc un
      // comportement a verifier separement, avec sa propre fixture fraiche
      // et sa propre assertion.
      it("0 -> 1", async function () {
        await assertSwapYieldsExpectedDeltas(0, 1);
      });

      it("0 -> 2", async function () {
        await assertSwapYieldsExpectedDeltas(0, 2);
      });

      it("1 -> 0", async function () {
        await assertSwapYieldsExpectedDeltas(1, 0);
      });

      it("1 -> 2", async function () {
        await assertSwapYieldsExpectedDeltas(1, 2);
      });

      it("2 -> 0", async function () {
        await assertSwapYieldsExpectedDeltas(2, 0);
      });

      it("2 -> 1", async function () {
        await assertSwapYieldsExpectedDeltas(2, 1);
      });
    });

    describe("C) Reverts", function () {
      it("_minOut strictement superieur a amountOut : BadSlippage", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, NOMINAL_SWAP_AMOUNT_OUT + 1n], { account: other.account }),
          pool,
          "BadSlippage",
        );
      });

      it("_amount == 0 sur pool amorce : ZeroOutput", async function () {
        // C'est la fin de l'evenement fantome : avant cette garde, un appel
        // a montant nul executait quand meme swap() jusqu'au bout (les
        // transferts de 0 token ne font rien de visible, mais l'emit, lui,
        // avait bien lieu), et emettait un Swapped que le front peut lire
        // comme source de donnees (historique de trades, calcul de volume).
        const { pool, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, 0n, 2n, 0n], { account: other.account }),
          pool,
          "ZeroOutput",
        );
      });

      it("_amount = 1 avec feeNum = 5 : ZeroOutput, l'unite se perd dans la troncature des frais", async function () {
        // Calcul a la main : amountAfterFee = 1 * (10000 - 5) / 10000 = 0
        // (division entiere), donc amountOut = 0. Avant la garde, le
        // swapper perdait purement et simplement son unite : le
        // transferFrom entrant s'executait (Pool.sol:161), la reserve
        // d'entree encaissait l'unite (Pool.sol:158), et rien ne repartait
        // en face.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, 1n);

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, 1n, 2n, 0n], { account: other.account }),
          pool,
          "ZeroOutput",
        );
      });

      it("allowance insuffisante sur le token d'entree : ERC20InsufficientAllowance", async function () {
        // L'erreur est levee par le TOKEN d'entree, pas par le pool : c'est
        // donc son ABI qu'on donne a decoder, comme dans le test equivalent de
        // Pool.addLiquidity.test.ts. Passer `pool` fonctionnerait ici par
        // accident (Pool herite ERC20, il porte donc la meme erreur dans son
        // ABI), et masquerait d'ou vient reellement le revert.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await tokens[0].write.mint([other.account.address, NOMINAL_SWAP_AMOUNT_IN]);
        // Aucun approve : l'allowance du pool sur ce token reste a 0.

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account }),
          tokens[0],
          "ERC20InsufficientAllowance",
        );
      });

      it("solde insuffisant sur le token d'entree alors que l'allowance suffit : ERC20InsufficientBalance", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        // Allowance suffisante, mais `other` n'a jamais recu de mint : son
        // solde sur ce token reste a 0.
        await tokens[0].write.approve([pool.address, NOMINAL_SWAP_AMOUNT_IN], { account: other.account });

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account }),
          tokens[0],
          "ERC20InsufficientBalance",
        );
      });

      it("_indexIn hors bornes (valeur 3) : panic 0x32", async function () {
        // Aucun mint/approve necessaire : cachedReserves[_indexIn] est
        // indexe des Pool.sol:139-140, avant tout transferFrom (Pool.sol:161).
        // L'appel revert par un acces hors bornes d'un tableau MEMOIRE
        // (cachedReserves, la copie locale de `reserves`), pas storage.
        const { pool, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        await assertPanic(
          pool.write.swap([3n, NOMINAL_SWAP_AMOUNT_IN, 0n, 0n], { account: other.account }),
          PANIC_ARRAY_OUT_OF_BOUNDS_ACCESS,
        );
      });

      it("_indexOut hors bornes (valeur 3) : panic 0x32", async function () {
        const { pool, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        await assertPanic(
          pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 3n, 0n], { account: other.account }),
          PANIC_ARRAY_OUT_OF_BOUNDS_ACCESS,
        );
      });

      it("reserves[_indexIn] + _amount depasse uint72.max : ReserveOverflow", async function () {
        // UINT72_MAX a lui seul depasse deja largement reserves[0] (1e10) une
        // fois additionne : reserves[0] + UINT72_MAX > UINT72_MAX est vrai
        // pour n'importe quelle reserve non nulle, inutile de calculer le
        // seuil exact. Les gardes ZeroOutput et InsufficientReserve passent
        // avant d'atteindre celle-ci : avec un amount aussi grand,
        // amountAfterFee ecrase largement reserves[_indexIn] au denominateur,
        // donc amountOut tend vers reserves[_indexOut] sans jamais l'atteindre.
        const { pool, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, UINT72_MAX, 2n, 0n], { account: other.account }),
          pool,
          "ReserveOverflow",
        );
      });

      it("montant poussiere avec un _minOut inatteignable : ZeroOutput, jamais BadSlippage", async function () {
        // Ordre des gardes dans Pool.sol : ZeroOutput, InsufficientReserve,
        // ReserveOverflow, la boucle de bandes, puis BadSlippage en dernier.
        // _amount = 1 donne amountOut = 0 (voir le test voisin ci-dessus) :
        // meme avec un _minOut enorme et donc lui aussi insatisfaisable,
        // c'est ZeroOutput qui doit interrompre l'appel en premier, le
        // require de BadSlippage n'etant jamais atteint.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, 1n);

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, 1n, 2n, SEED_AMOUNT], { account: other.account }),
          pool,
          "ZeroOutput",
        );
      });

      it("montant qui deborde uint72 avec un _minOut inatteignable : ReserveOverflow, jamais BadSlippage", async function () {
        // Meme logique d'ordre des gardes que le test voisin, sur la garde
        // suivante : _amount = UINT72_MAX passe ZeroOutput et
        // InsufficientReserve (voir le test ReserveOverflow ci-dessus), puis
        // echoue par ReserveOverflow. Un _minOut insatisfaisable (UINT72_MAX,
        // superieur a n'importe quelle reserve du pool) ne doit jamais etre
        // atteint : ReserveOverflow est verifiee avant BadSlippage.
        const { pool, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, UINT72_MAX, 2n, UINT72_MAX], { account: other.account }),
          pool,
          "ReserveOverflow",
        );
      });
    });

    describe("D) Cas limites", function () {
      it("_minOut exactement egal a amountOut est accepte", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);

        await assert.doesNotReject(
          pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, NOMINAL_SWAP_AMOUNT_OUT], { account: other.account }),
          "un _minOut egal a amountOut ne devrait pas revert",
        );
      });

      it("indexIn == indexOut : le solde net du swapper baisse de _amount moins amountOut", async function () {
        // _indexIn == _indexOut est ACCEPTE par le contrat, deliberement non
        // garde : aucune ligne de swap() ne compare les deux indices. Le
        // swapper paie _amount et recupere amountOut du meme token, donc il
        // perd a la fois les frais et le slippage de la formule, sans que
        // le pool ne perde jamais rien : c'est l'appelant seul qui se
        // penalise, ce que ce test et le suivant verifient chacun par une
        // lecture on-chain (pas de recalcul de formule).
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const balanceBefore = (await readBalances(tokens, other.account.address))[0];

        const { result: amountOut } = await pool.simulate.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 0n, 0n], {
          account: other.account.address,
        });
        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 0n, 0n], { account: other.account });

        const balanceAfter = (await readBalances(tokens, other.account.address))[0];
        const netLoss = balanceBefore - balanceAfter;
        assert.equal(
          netLoss,
          NOMINAL_SWAP_AMOUNT_IN - amountOut,
          `perte nette=${netLoss}, attendu _amount - amountOut=${NOMINAL_SWAP_AMOUNT_IN - amountOut} (_amount=${NOMINAL_SWAP_AMOUNT_IN}, amountOut simule=${amountOut})`,
        );
      });

      it("indexIn == indexOut : la reserve concernee monte exactement de cette meme perte nette", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const reserveBefore = (await readReserves(pool))[0];
        const balanceBefore = (await readBalances(tokens, other.account.address))[0];

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 0n, 0n], { account: other.account });

        const reserveAfter = (await readReserves(pool))[0];
        const balanceAfter = (await readBalances(tokens, other.account.address))[0];
        const reserveGain = reserveAfter - reserveBefore;
        const netLoss = balanceBefore - balanceAfter;
        assert.equal(
          reserveGain,
          netLoss,
          `gain de reserves[0]=${reserveGain}, perte nette du swapper=${netLoss} : ces deux lectures on-chain devraient etre identiques (rien n'est draine du pool, seul l'appelant se penalise)`,
        );
      });

      it("a entree identique, un pool a feeNum = 0 rend strictement plus qu'un pool a feeNum = 5", async function () {
        // Seul test de la suite qui a besoin de DEUX pools vivants en meme
        // temps : la propriete comparee est le feeNum, qui est fixe a la
        // construction et ne peut pas etre change a la volee ici (setFee est
        // onlyOwner et impose un delai de 1 jour).
        //
        // Les deux loadFixture se font donc AVANT tout appel ecrivant, et cet
        // ordre n'est pas cosmetique : loadFixture restaure un instantane de
        // la chaine, ce qui detruit tout ce qui a ete deploye APRES la prise
        // de cet instantane. Charger la seconde fixture apres avoir mint sur
        // la premiere effacerait ce mint, et charger la plus ancienne des deux
        // en second effacerait carrement les contrats de l'autre.
        const seeded = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const zeroFee = await networkHelpers.loadFixture(deployZeroFeeSeededPoolFixture);

        await mintAndApproveSingleToken(seeded.tokens, seeded.pool, seeded.other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const { result: amountOutWithFee } = await seeded.pool.simulate.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], {
          account: seeded.other.account.address,
        });

        await mintAndApproveSingleToken(zeroFee.tokens, zeroFee.pool, zeroFee.other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const { result: amountOutNoFee } = await zeroFee.pool.simulate.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], {
          account: zeroFee.other.account.address,
        });

        assert.ok(
          amountOutNoFee > amountOutWithFee,
          `feeNum=0 devrait rendre plus : sans frais=${amountOutNoFee}, avec frais (feeNum=5)=${amountOutWithFee}`,
        );
      });

      it("une entree tres superieure aux reserves echoue par CeilingTouched, pas par un amountOut proche de la reserve de sortie", async function () {
        // La propriete "amountOut reste strictement sous reserves[_indexOut]"
        // tient toujours de la seule formule du produit constant
        // (Pool.sol:139-140 ne peut structurellement pas rendre amountOut >=
        // reserveOut), mais elle n'est plus atteignable par l'ABI : la
        // boucle de bandes (Pool.sol:151-154) bloque desormais bien avant.
        // _amount = 2 * SEED_AMOUNT (2e10), sur reserves = [1e10, 1e10, 1e10],
        // feeNum = 5, FEE_DEN = 10000. Calcul a la main :
        //   amountAfterFee = 2e10 * 9995 / 10000 = 19 990 000 000
        //   amountOut = 19 990 000 000 * 1e10 / (19 990 000 000 + 1e10)
        //             = 6 665 555 185 (tronque)
        //   afterSwapReserves = [3e10, 1e10, 3 334 444 815], sum = 43 334 444 815
        //   token0 (l'entrante) : 30e9 * 100 / 43 334 444 815 = 69,23 %,
        //   au-dessus de son plafond (53 %) : premier indice de la boucle
        //   (i = 0), le require y revert avant que token2 (7,69 % apres
        //   coup) ne soit lui-meme examine.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const hugeAmount = 2n * SEED_AMOUNT;
        await mintAndApproveSingleToken(tokens, pool, other, 0, hugeAmount);

        await viem.assertions.revertWithCustomErrorWithArgs(
          pool.write.swap([0n, hugeAmount, 2n, 0n], { account: other.account }),
          pool,
          "CeilingTouched",
          [0n],
        );
      });

      it("deux swaps identiques successifs : le second rend strictement moins que le premier", async function () {
        // Impact de prix : le premier swap consomme deja une partie de la
        // reserve de sortie et grossit la reserve d'entree, le second swap
        // identique s'execute donc sur un pool moins favorable. Comparaison
        // de deux deltas on-chain, sans recalcul de la formule.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN * 2n);

        const balanceBeforeFirst = (await readBalances(tokens, other.account.address))[2];
        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });
        const balanceAfterFirst = (await readBalances(tokens, other.account.address))[2];
        const receivedFirst = balanceAfterFirst - balanceBeforeFirst;

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });
        const balanceAfterSecond = (await readBalances(tokens, other.account.address))[2];
        const receivedSecond = balanceAfterSecond - balanceAfterFirst;

        assert.ok(
          receivedSecond < receivedFirst,
          `1er swap=${receivedFirst}, 2e swap=${receivedSecond} : le second devrait rendre strictement moins (impact de prix)`,
        );
      });
    });

    describe("E) Pool desequilibre", function () {
      // reserves = [1250e8, 1000e8, 800e8] : depuis le token0 (la jambe la
      // plus abondante), les deux destinations possibles sont token1
      // (l'intermediaire) et token2 (la plus rare des trois) — token0
      // lui-meme n'est evidemment pas une destination valide de son propre
      // swap. Calcul a la main (feeNum = 0, _amount = 10 000 000 000 depuis
      // le token0) :
      //   vers token1 (l'intermediaire) : 1e10 * 1000e8 / (1e10 + 1250e8) = 7 407 407 407 (tronque)
      //   vers token2 (le plus rare)    : 1e10 *  800e8 / (1e10 + 1250e8) = 5 925 925 925 (tronque)
      const IMBALANCED_SWAP_AMOUNT_IN = 10_000_000_000n;
      const AMOUNT_OUT_TOWARD_INTERMEDIATE = 7_407_407_407n;
      const AMOUNT_OUT_TOWARD_RARE = 5_925_925_925n;

      it("depuis le token0, acheter le token intermediaire (index 1) rend exactement 7 407 407 407", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, IMBALANCED_SWAP_AMOUNT_IN);

        const { result: amountOut } = await pool.simulate.swap([0n, IMBALANCED_SWAP_AMOUNT_IN, 1n, 0n], {
          account: other.account.address,
        });

        assert.equal(
          amountOut,
          AMOUNT_OUT_TOWARD_INTERMEDIATE,
          `amountOut=${amountOut}, attendu=${AMOUNT_OUT_TOWARD_INTERMEDIATE} (calcul a la main en commentaire)`,
        );
      });

      it("depuis le token0, acheter le token le plus rare (index 2) rend exactement 5 925 925 925", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, IMBALANCED_SWAP_AMOUNT_IN);

        const { result: amountOut } = await pool.simulate.swap([0n, IMBALANCED_SWAP_AMOUNT_IN, 2n, 0n], {
          account: other.account.address,
        });

        assert.equal(
          amountOut,
          AMOUNT_OUT_TOWARD_RARE,
          `amountOut=${amountOut}, attendu=${AMOUNT_OUT_TOWARD_RARE} (calcul a la main en commentaire)`,
        );
      });

      // Un troisieme `it` plutot que de laisser les deux valeurs en dur
      // ci-dessus porter seules la comparaison : la propriete qualitative
      // ("l'actif le plus rare coute plus cher") est ce qu'on veut garantir
      // dans le temps, independamment des deux montants exacts.
      //
      // Un SEUL chargement de fixture, et deux `simulate` sur le meme pool :
      // simulate n'ecrit rien (c'est un eth_call), les deux mesures sont donc
      // bien prises sur des reserves identiques.
      it("a entree identique, acheter le token le plus rare rend strictement moins qu'acheter l'intermediaire", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, IMBALANCED_SWAP_AMOUNT_IN);

        const { result: amountOutRare } = await pool.simulate.swap([0n, IMBALANCED_SWAP_AMOUNT_IN, 2n, 0n], {
          account: other.account.address,
        });
        const { result: amountOutIntermediate } = await pool.simulate.swap([0n, IMBALANCED_SWAP_AMOUNT_IN, 1n, 0n], {
          account: other.account.address,
        });

        assert.ok(
          amountOutRare < amountOutIntermediate,
          `vers le plus rare=${amountOutRare}, vers l'intermediaire=${amountOutIntermediate} : le plus rare devrait rendre strictement moins`,
        );
      });

      it("l'evenement Swapped porte les bons montants sur des reserves inegales", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, IMBALANCED_SWAP_AMOUNT_IN);

        await viem.assertions.emitWithArgs(
          pool.write.swap([0n, IMBALANCED_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account }),
          pool,
          "Swapped",
          [other.account.address, 0n, IMBALANCED_SWAP_AMOUNT_IN, 2n, AMOUNT_OUT_TOWARD_RARE],
        );
      });
    });

    describe("F) Bandes par actif (plancher/plafond, subtask C)", function () {
      // floor = 13, ceiling = 53 (Pool.sol:20-21), verifies en RATIOS (jamais
      // en valeur absolue de reserve) sur la somme des trois : pour chaque
      // indice i, la boucle exige afterSwapReserves[i] * 100 strictement
      // entre floor * sum et ceiling * sum (Pool.sol:151-154), APRES avoir
      // calcule amountOut et applique le swap, mais AVANT le require de
      // slippage. Les trois premiers cas ci-dessous utilisent
      // deployImbalancedPoolFixture (reserves = [1250e8, 1000e8, 800e8],
      // feeNum = 0).
      it("un swap qui pousse la jambe entrante au-dessus de son plafond : CeilingTouched(0)", async function () {
        // 0 -> 2, _amount = 800e8. Calcul a la main (feeNum = 0) :
        //   amountOut = 800e8 * 800e8 / (800e8 + 1250e8) = 31 219 512 195
        //   afterSwapReserves = [2050e8, 1000e8, 48 780 487 805], sum = 353 780 487 805
        //   token0 (l'entrante) : 205e9 * 100 / 353 780 487 805 = 57,94 %,
        //   au-dessus de son plafond (53 %). C'est le premier indice de la
        //   boucle (i = 0) : le require y revert avant que token1 (28,27 %,
        //   conforme) ou token2 (13,79 %, conforme lui aussi de justesse) ne
        //   soient meme examines.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
        const amount = 800n * 10n ** 8n;
        await mintAndApproveSingleToken(tokens, pool, other, 0, amount);

        await viem.assertions.revertWithCustomErrorWithArgs(
          pool.write.swap([0n, amount, 2n, 0n], { account: other.account }),
          pool,
          "CeilingTouched",
          [0n],
        );
      });

      it("un swap qui pousse la jambe sortante sous son plancher : FloorTouched(2)", async function () {
        // 1 -> 2, _amount = 800e8. Calcul a la main (feeNum = 0) :
        //   amountOut = 800e8 * 800e8 / (800e8 + 1000e8) = 35 555 555 555
        //   afterSwapReserves = [1250e8, 1800e8, 44 444 444 445], sum = 349 444 444 445
        //   token0 : 35,77 % (conforme), token1 (l'entrante) : 51,51 %
        //   (conforme, sous son plafond), token2 (la sortante) : 12,71 %,
        //   sous son plancher (13 %). Les indices 0 et 1 passent leurs deux
        //   controles avant que la boucle n'atteigne l'indice 2 en defaut.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
        const amount = 800n * 10n ** 8n;
        await mintAndApproveSingleToken(tokens, pool, other, 1, amount);

        await viem.assertions.revertWithCustomErrorWithArgs(
          pool.write.swap([1n, amount, 2n, 0n], { account: other.account }),
          pool,
          "FloorTouched",
          [2n],
        );
      });

      it("un swap nominal laisse les trois jambes dans leurs bandes", async function () {
        // 0 -> 2, _amount = 100e8. Calcul a la main (feeNum = 0) :
        //   amountOut = 100e8 * 800e8 / (100e8 + 1250e8) = 5 925 925 925
        //   afterSwapReserves = [1350e8, 1000e8, 74 074 074 075], sum = 309 074 074 075
        //   token0 = 43,68 % (13-53 OK), token1 = 32,35 % (OK),
        //   token2 = 23,96 % (OK) : les trois passent.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
        const amount = 100n * 10n ** 8n;
        await mintAndApproveSingleToken(tokens, pool, other, 0, amount);

        await pool.write.swap([0n, amount, 2n, 0n], { account: other.account });

        const reserves = await readReserves(pool);
        assert.deepEqual(
          reserves,
          [135_000_000_000n, 100_000_000_000n, 74_074_074_075n],
          `le swap a passe les bandes mais laisse des reserves inattendues : ${reserves}`,
        );
      });

      it("un swap qui ne fait sortir de bande QUE la jambe non impliquee : FloorTouched(0)", async function () {
        // LE cas qui justifie que la boucle de Pool.sol passe sur les TROIS
        // indices et pas seulement sur _indexIn et _indexOut. Pool a
        // feeNum = 0, amorcage a egalite, reserves de depart [100e8, 100e8,
        // 100e8] (deployZeroFeeSeededPoolFixture). Les deux preparations
        // touchent token0 pour le garer juste au-dessus de son plancher ;
        // c'est le TROISIEME swap, le 1 -> 2, qui porte la demonstration :
        // token0 n'y intervient pas, sa reserve ne bouge pas d'un satoshi,
        // et c'est pourtant le DENOMINATEUR (la somme des trois) qui l'a
        // sorti de sa bande, a mesure que les deux autres jambes
        // s'echangent entre elles.
        //
        // Preparation 1, swap 1 -> 0 de 50e8 :
        //   amountOut = 50e8 * 100e8 / (50e8 + 100e8) = 3 333 333 333
        //   reserves = [6 666 666 667, 15 000 000 000, 10 000 000 000]
        //   sum = 31 666 666 667
        //   parts : token0 21,05 %, token1 47,37 %, token2 31,58 % : passent
        // Preparation 2, swap 2 -> 0 de 47e8 :
        //   amountOut = 47e8 * 6 666 666 667 / (47e8 + 6 666 666 667) = 2 131 519 274
        //   reserves = [4 535 147 393, 15 000 000 000, 14 700 000 000]
        //   sum = 34 235 147 393
        //   parts : token0 13,247 % (attention : deja proche du plancher,
        //   mais encore au-dessus), token1 43,815 %, token2 42,938 % (toutes
        //   deux OK) : passe.
        // Swap final, 1 -> 2 de 35e8 :
        //   amountOut = 35e8 * 14 700 000 000 / (35e8 + 15 000 000 000) = 2 781 081 081
        //   reserves = [4 535 147 393, 18 500 000 000, 11 918 918 919]
        //   sum = 34 954 066 312
        //   token1 52,93 % (conforme, sous son plafond) et token2 34,10 %
        //   (conforme) : les deux jambes du swap restent chacune dans leur
        //   bande. token0, intouche, tombe a 12,97 % < 13 % : verifie en
        //   entiers, 453 514 739 300 <= 13 * 34 954 066 312 (454 402 862 056).
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployZeroFeeSeededPoolFixture);
        const prepare1 = 50n * 10n ** 8n;
        const prepare2 = 47n * 10n ** 8n;
        const dilute = 35n * 10n ** 8n;
        await mintAndApproveSingleToken(tokens, pool, other, 1, prepare1 + dilute);
        await mintAndApproveSingleToken(tokens, pool, other, 2, prepare2);

        await pool.write.swap([1n, prepare1, 0n, 0n], { account: other.account });
        await pool.write.swap([2n, prepare2, 0n, 0n], { account: other.account });

        await viem.assertions.revertWithCustomErrorWithArgs(
          pool.write.swap([1n, dilute, 2n, 0n], { account: other.account }),
          pool,
          "FloorTouched",
          [0n],
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // III] Proprietes de conservation
  // ---------------------------------------------------------------------------

  describe("III] Proprietes de conservation", function () {
    describe("A) Aucune valeur creee ex nihilo", function () {
      it("aller-retour 0 -> 1 puis 1 -> 0 (feeNum = 5) : le swapper recupere strictement moins qu'il n'a mis", async function () {
        // Deux passages par la formule a frais (Pool.sol:139-140) : le
        // swapper paie deux fois le prelevement de feeNum, plus le slippage de
        // chaque jambe (la reserve bouge entre les deux appels). Aucune valeur
        // n'est creee ex nihilo, ce qui se verifie ici en comparant le solde
        // final au solde initial, sans recalculer la formule.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const balanceBefore = (await readBalances(tokens, other.account.address))[0];

        const { result: amountOutLeg1 } = await pool.simulate.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 1n, 0n], {
          account: other.account.address,
        });
        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 1n, 0n], { account: other.account });
        await tokens[1].write.approve([pool.address, amountOutLeg1], { account: other.account });
        await pool.write.swap([1n, amountOutLeg1, 0n, 0n], { account: other.account });

        const balanceAfter = (await readBalances(tokens, other.account.address))[0];
        assert.ok(
          balanceAfter < balanceBefore,
          `solde token0 apres l'aller-retour=${balanceAfter}, devrait etre strictement inferieur au solde avant=${balanceBefore}`,
        );
      });

      it("meme aller-retour a feeNum = 0 : le swapper ne recupere jamais plus que son entree", async function () {
        // Sans frais, seule la troncature entiere joue encore (chaque division
        // de swap() arrondit vers le bas), ce qui suffit deja a empecher toute
        // creation de valeur mais ne garantit pas une perte stricte : sur un
        // aller-retour ideal, la perte peut se limiter a une poignee d'unites,
        // voire (selon les reserves) etre nulle. L'assertion reste donc un <=
        // et non un <, c'est la propriete generale (ne jamais rendre plus
        // qu'on a mis) qui est visee ici, pas la magnitude de la perte.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployZeroFeeSeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const balanceBefore = (await readBalances(tokens, other.account.address))[0];

        const { result: amountOutLeg1 } = await pool.simulate.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 1n, 0n], {
          account: other.account.address,
        });
        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 1n, 0n], { account: other.account });
        await tokens[1].write.approve([pool.address, amountOutLeg1], { account: other.account });
        await pool.write.swap([1n, amountOutLeg1, 0n, 0n], { account: other.account });

        const balanceAfter = (await readBalances(tokens, other.account.address))[0];
        assert.ok(
          balanceAfter <= balanceBefore,
          `solde token0 apres l'aller-retour=${balanceAfter}, ne devrait jamais depasser le solde avant=${balanceBefore}`,
        );
      });

      it("le produit reserves[_indexIn] * reserves[_indexOut] ne diminue jamais apres un swap", async function () {
        // L'invariant "k" du produit constant, restreint a la paire de
        // reserves concernee par le swap : il croit des frais preleves
        // (amountAfterFee < _amount, mais c'est _amount entier qui entre en
        // reserve) et de l'arrondi vers le bas d'amountOut. Comparaison de
        // deux lectures on-chain, sans recalcul de la formule.
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
        const reservesBefore = await readReserves(pool);
        const productBefore = reservesBefore[0] * reservesBefore[2];

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });

        const reservesAfter = await readReserves(pool);
        const productAfter = reservesAfter[0] * reservesAfter[2];
        assert.ok(
          productAfter >= productBefore,
          `produit avant=${productBefore}, apres=${productAfter} : ne devrait jamais diminuer`,
        );
      });
    });

    describe("B) Comptabilite LP intacte", function () {
      it("le solde LP du swapper reste nul apres un swap", async function () {
        // le swapper n'est pas fournisseur de liquidite : swap() ne touche a
        // aucun moment au token LP (Pool herite ERC20, mais ni _mint ni _burn
        // n'apparaissent dans swap()).
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);

        await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });

        const lpBalance = await pool.read.balanceOf([other.account.address]);
        assert.equal(
          lpBalance,
          0n,
          `solde LP du swapper apres swap=${lpBalance}, attendu 0 (un swap ne mint ni ne transfere jamais de part LP)`,
        );
      });
    });
  });
});
