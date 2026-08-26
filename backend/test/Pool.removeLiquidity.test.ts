// Suite fonctionnelle TypeScript pour Pool.removeLiquidity().
//
// Pourquoi TypeScript/viem plutot que Solidity ici : meme raison que pour
// addLiquidity (voir Pool.addLiquidity.test.ts), avec un parcours utilisateur
// plus court. Retirer de la liquidite ne demande aucun `approve` prealable :
// le pool transfere VERS l'utilisateur (pas de transferFrom entrant a
// autoriser), et le porteur de parts LP brule ses propres parts (l'ERC-20 LP,
// c'est Pool lui-meme, `_burn` ne verifie qu'un solde, pas une allowance).
// C'est quand meme de l'orchestration multi-contrats a travers l'ABI : trois
// ERC-20 sortants dans la meme transaction, plus le token LP.
//
// Voir test/README.md pour la demarche complete, la liste des cas limites
// groupee par fonction, et pourquoi les fixtures ci-dessous sont dupliquees
// depuis Pool.addLiquidity.test.ts plutot que partagees.

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
// Sur les fixtures de cette suite, les reserves valent au plus 1,25e11 : aucun
// amountsOut ne peut donc jamais atteindre UINT72_MAX, ce qui en fait un
// _minOut insatisfaisable par construction.
const UINT72_MAX = 2n ** 72n - 1n;
const DEFAULT_FEE_NUM = 5n; // reprend la valeur du Pool.t.sol d'origine
const ZERO_FEE_NUM = 0n;

// Codes de panic Solidity utilises dans cette suite (Panic(uint256)).
const PANIC_ARITHMETIC_OVERFLOW = 17n; // 0x11 (couvre aussi bien un depassement qu'un sous-flow)

// ---------------------------------------------------------------------------
// Fixtures et helpers
//
// Dupliquees depuis Pool.addLiquidity.test.ts, deliberement. Ce fichier ouvre
// sa propre connexion reseau via network.create() : la partager
// avec l'autre fichier de test reviendrait a partager l'etat blockchain et le
// cache de loadFixture entre deux fichiers qui tournent independamment, ce
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
// montant sur chacun. Utilise ici uniquement pour amorcer les fixtures et
// pour le depot du III.A (un aller-retour addLiquidity + removeLiquidity) :
// removeLiquidity seul n'a besoin d'aucun approve, voir le commentaire d'en-tete.
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

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

// Mint et approuve, jambe par jambe, exactement ce qu'un depot ancre sur
// `anchor` va reellement tirer sur chacun des trois tokens : amounts[i] =
// ceilDiv(_amount * reservesBefore[i], reservesBefore[anchor]) (Pool.sol:108).
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

// Amorcage a montants egaux (Pool.sol:93) : reserves = [1e10, 1e10, 1e10],
// totalSupply = 3e10 (somme des trois jambes, part brulee vers l'adresse
// morte incluse).
//
// 10% du totalSupply du pool amorce (3e10 / 10 = 3e9). Choisi parce qu'il
// divise proprement les trois reserves : chaque amountsOut[i] vaut alors
// exactement reserves[i] / 10 = 1e9, sans troncature qui polluerait les
// assertions du cas nominal (section II.A).
const BURN_AMOUNT = 3n * 10n ** 9n; // 3 000 000 000
const EXPECTED_NOMINAL_AMOUNTS_OUT: [bigint, bigint, bigint] = [
  SEED_AMOUNT / 10n,
  SEED_AMOUNT / 10n,
  SEED_AMOUNT / 10n,
];

// Fixture dediee au pool desequilibre (section II.D). feeNum = 0, par choix
// delibere : voir Pool.addLiquidity.test.ts pour la justification complete
// (les depots/retraits "10% du pool" de cette section exigent des reserves
// qui se divisent proprement, ce qu'un feeNum non nul ne garantirait pas).
//
// Calcul a la main : amorcage a egalite, _amount = 1000e8 => reserves =
// [1000e8, 1000e8, 1000e8]. Swap de 250e8, token0 -> token2, feeNum = 0 :
//   amountOut = 250e8 * 1000e8 / (250e8 + 1000e8) = 200e8 (division exacte)
// Reserves apres le swap : [1250e8, 1000e8, 800e8]. token0 devient l'actif le
// plus ABONDANT (il a recu le swap), token2 le plus RARE (il en est sorti).
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

// Verifie qu'un compte qui depose (ancre sur token0) puis retire aussitot la
// totalite des parts obtenues ne recupere jamais plus de `tokenIndex` qu'il
// n'en a depense pour ce depot. Factorisee ici pour etre appelee depuis trois
// `it` distincts, un par token : chaque token est une comparaison de solde
// independante, donc un test et une assertion chacun (meme raisonnement que
// assertCompositionPreservedWhenAnchoredOn dans le fichier addLiquidity).
//
// Sur ce pool precis (fraichement amorce, reserves egales), l'aller-retour se
// revele en pratique exactement sans perte : totalSupply vaut alors
// exactement reserves[0] + reserves[1] + reserves[2], ce qui annule la
// troncature entiere dans les deux sens (au depot comme au retrait), quel que
// soit le montant depose. L'assertion ci-dessous reste un <= et non un == :
// c'est la propriete generale qu'on veut garantir (ne jamais creer de
// valeur), et l'egalite observee ici est un accident de cette configuration
// precise.
async function assertRoundTripNeverExceedsDeposit(tokenIndex: 0 | 1 | 2) {
  const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
  const reservesBefore = await readReserves(pool);
  const depositAmount = SEED_AMOUNT / 4n; // depot ancre sur token0

  await mintAndApproveForAnchoredDeposit(tokens, pool, other, 0n, depositAmount, reservesBefore);
  const mintedBalanceBeforeDeposit = await tokens[tokenIndex].read.balanceOf([other.account.address]);

  await pool.write.addLiquidity([0n, depositAmount, 0n], { account: other.account });
  const mintedShares = await pool.read.balanceOf([other.account.address]);
  await pool.write.removeLiquidity([mintedShares, [0n, 0n, 0n]], { account: other.account });

  const balanceAfterRoundTrip = await tokens[tokenIndex].read.balanceOf([other.account.address]);
  assert.ok(
    balanceAfterRoundTrip <= mintedBalanceBeforeDeposit,
    `token ${tokenIndex} : solde apres aller-retour=${balanceAfterRoundTrip}, ne devrait jamais depasser le depot initial=${mintedBalanceBeforeDeposit}`,
  );
}

describe("Pool.removeLiquidity", async function () {

  // ---------------------------------------------------------------------------
  // I] removeLiquidity sur pool vierge
  // ---------------------------------------------------------------------------

  describe("I] removeLiquidity sur pool vierge", function () {
    describe("A) Reverts", function () {
      it("totalSupply() vaut 0 sur un pool jamais amorce : NotBootstrapped, garde avant la division", async function () {
        // Garde explicite sur totalSupply() == 0 dans removeLiquidity :
        // le seul etat qui produit cette condition est un pool qui n'a
        // jamais recu de depot (MINIMUM_LIQUIDITY est brulee vers
        // l'adresse morte au premier depot, donc totalSupply() ne peut
        // plus retomber a zero une fois le pool amorce). La garde
        // remplace le panic 0x12 de division par zero qui se declenchait
        // avant, pour aligner avec les autres chemins d'echec nommes.
        const { pool, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.removeLiquidity([SEED_AMOUNT / 10n, [0n, 0n, 0n]], { account: depositor.account }),
          pool,
          "NotBootstrapped",
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // II] removeLiquidity sur pool amorce
  // ---------------------------------------------------------------------------

  describe("II] removeLiquidity sur pool amorce", function () {
    describe("A) Cas nominal", function () {
      it("le retirant recoit 10% de chaque reserve sur les trois tokens", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const balancesBefore = await readBalances(tokens, depositor.account.address);

        await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account });

        const balancesAfter = await readBalances(tokens, depositor.account.address);
        const received = balancesBefore.map((before, i) => balancesAfter[i] - before);
        assert.deepEqual(
          received,
          EXPECTED_NOMINAL_AMOUNTS_OUT,
          `recu=[${received}], attendu=[${EXPECTED_NOMINAL_AMOUNTS_OUT}] (10% de chaque reserve)`,
        );
      });

      it("chaque reserve diminue exactement de ce que le retirant a recu", async function () {
        // Conservation : on compare deux lectures on-chain (le delta des
        // reserves et le delta du solde du retirant) sans reimplementer la
        // formule interne (Pool.sol:125) en TS.
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const reservesBefore = await readReserves(pool);
        const balancesBefore = await readBalances(tokens, depositor.account.address);

        await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account });

        const reservesAfter = await readReserves(pool);
        const balancesAfter = await readBalances(tokens, depositor.account.address);
        const reserveDrop = reservesBefore.map((before, i) => before - reservesAfter[i]);
        const received = balancesBefore.map((before, i) => balancesAfter[i] - before);
        assert.deepEqual(
          reserveDrop,
          received,
          `baisse des reserves=[${reserveDrop}], recu par le retirant=[${received}] : ces deux lectures on-chain devraient etre identiques`,
        );
      });

      it("le solde du pool en chacun des trois tokens diminue des memes montants", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const poolBalancesBefore = await readBalances(tokens, pool.address);
        const depositorBalancesBefore = await readBalances(tokens, depositor.account.address);

        await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account });

        const poolBalancesAfter = await readBalances(tokens, pool.address);
        const depositorBalancesAfter = await readBalances(tokens, depositor.account.address);
        const poolDrop = poolBalancesBefore.map((before, i) => before - poolBalancesAfter[i]);
        const received = depositorBalancesBefore.map((before, i) => depositorBalancesAfter[i] - before);
        assert.deepEqual(
          poolDrop,
          received,
          `baisse du solde du pool=[${poolDrop}], recu par le retirant=[${received}] : ces deux lectures on-chain devraient etre identiques`,
        );
      });

      it("les parts LP du retirant diminuent de _burnedShares", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const sharesBefore = await pool.read.balanceOf([depositor.account.address]);

        await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account });

        const sharesAfter = await pool.read.balanceOf([depositor.account.address]);
        const burned = sharesBefore - sharesAfter;
        assert.equal(
          burned,
          BURN_AMOUNT,
          `parts brulees=${burned} (avant=${sharesBefore}, apres=${sharesAfter}), attendu ${BURN_AMOUNT}`,
        );
      });

      it("totalSupply() diminue de _burnedShares", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const supplyBefore = await pool.read.totalSupply();

        await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account });

        const supplyAfter = await pool.read.totalSupply();
        const burned = supplyBefore - supplyAfter;
        assert.equal(
          burned,
          BURN_AMOUNT,
          `totalSupply a diminue de ${burned} (avant=${supplyBefore}, apres=${supplyAfter}), attendu ${BURN_AMOUNT}`,
        );
      });

      it("la valeur de retour amountsOut vaut les trois montants transferes", async function () {
        // Route retenue : pool.simulate.removeLiquidity(...) execute un appel
        // (eth_call) sans envoyer de transaction, et renvoie { result,
        // request } ; result est la valeur de retour ABI-decodee de la
        // fonction, exactement ce que produirait le `write` correspondant.
        //
        // Valeurs posees en dur (calcul a la main) : cachedReserves =
        // [1e10, 1e10, 1e10], supply = 3e10, _burnedShares = BURN_AMOUNT
        // (3e9, 10% de supply) => amountsOut[i] = reserves[i] * 3e9 / 3e10
        // = reserves[i] / 10, soit [1e9, 1e9, 1e9].
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        const { result: amountsOut } = await pool.simulate.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], {
          account: depositor.account.address,
        });

        assert.deepEqual(
          amountsOut,
          EXPECTED_NOMINAL_AMOUNTS_OUT,
          `amountsOut simule=[${amountsOut}], attendu=[${EXPECTED_NOMINAL_AMOUNTS_OUT}] (calcul a la main en commentaire)`,
        );
      });

      it("l'evenement RemovedLiquidity est emis avec les bons arguments", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        await viem.assertions.emitWithArgs(
          pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account }),
          pool,
          "RemovedLiquidity",
          [depositor.account.address, EXPECTED_NOMINAL_AMOUNTS_OUT, BURN_AMOUNT],
        );
      });

      it("l'adresse morte conserve ses MINIMUM_LIQUIDITY parts apres un retrait", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account });

        const deadBalance = await pool.read.balanceOf([DEAD_ADDRESS]);
        assert.equal(
          deadBalance,
          MINIMUM_LIQUIDITY,
          `solde LP de l'adresse morte=${deadBalance}, attendu ${MINIMUM_LIQUIDITY} (removeLiquidity ne touche qu'au solde du retirant)`,
        );
      });
    });

    describe("B) Reverts", function () {
      it("_burnedShares superieur au solde LP du retirant : ERC20InsufficientBalance", async function () {
        // L'erreur vient de Pool lui-meme : Pool EST le token LP (il herite
        // ERC20), _burn revert avec l'erreur ERC20 standard.
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const balance = await pool.read.balanceOf([depositor.account.address]);

        await viem.assertions.revertWithCustomError(
          pool.write.removeLiquidity([balance + 1n, [0n, 0n, 0n]], { account: depositor.account }),
          pool,
          "ERC20InsufficientBalance",
        );
      });

      it("un compte sans aucune part ne peut pas retirer : ERC20InsufficientBalance", async function () {
        const { pool, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.removeLiquidity([1n, [0n, 0n, 0n]], { account: other.account }),
          pool,
          "ERC20InsufficientBalance",
        );
      });

      it("_minOut[0] strictement superieur au montant sortant : BadSlippage", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const tooHighMinOut = EXPECTED_NOMINAL_AMOUNTS_OUT[0] + 1n;

        await viem.assertions.revertWithCustomError(
          pool.write.removeLiquidity([BURN_AMOUNT, [tooHighMinOut, 0n, 0n]], { account: depositor.account }),
          pool,
          "BadSlippage",
        );
      });

      it("_minOut[1] strictement superieur au montant sortant : BadSlippage", async function () {
        // Le require vit dans la boucle (Pool.sol:124-127) : l'indice 1
        // n'est atteint qu'apres que l'indice 0 a deja passe son propre
        // require, donc _minOut[0] doit rester satisfaisable ici.
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const tooHighMinOut = EXPECTED_NOMINAL_AMOUNTS_OUT[1] + 1n;

        await viem.assertions.revertWithCustomError(
          pool.write.removeLiquidity([BURN_AMOUNT, [0n, tooHighMinOut, 0n]], { account: depositor.account }),
          pool,
          "BadSlippage",
        );
      });

      it("_minOut[2] strictement superieur au montant sortant : BadSlippage", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const tooHighMinOut = EXPECTED_NOMINAL_AMOUNTS_OUT[2] + 1n;

        await viem.assertions.revertWithCustomError(
          pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, tooHighMinOut]], { account: depositor.account }),
          pool,
          "BadSlippage",
        );
      });

      it("retrait trop grand ET _minOut trop exigeant : BadSlippage avant ERC20InsufficientBalance", async function () {
        // La boucle de slippage (Pool.sol:124-127) s'execute entierement
        // avant le _burn (Pool.sol:129) : un appel qui viole les deux gardes
        // doit echouer par BadSlippage, jamais par ERC20InsufficientBalance.
        // UINT72_MAX en _minOut[0] est impossible a satisfaire quel que soit
        // _burnedShares, puisque les reserves sont des uint72 : amountsOut[0]
        // ne peut jamais l'atteindre.
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const balance = await pool.read.balanceOf([depositor.account.address]);

        await viem.assertions.revertWithCustomError(
          pool.write.removeLiquidity([balance + 1n, [UINT72_MAX, 0n, 0n]], { account: depositor.account }),
          pool,
          "BadSlippage",
        );
      });

      it("_burnedShares superieur au totalSupply : panic 0x11, le decrement des reserves sous-flow avant le _burn", async function () {
        // La boucle de decrement des reserves (Pool.sol:124-127) s'execute
        // avant le _burn (Pool.sol:129). Si _burnedShares depasse
        // totalSupply(), amountsOut[i] = reserves[i] * _burnedShares / supply
        // depasse reserves[i] lui-meme, et reserves[i] -= uint72(amountsOut[i])
        // sous-flow avant que _burn n'ait la moindre chance de lever
        // ERC20InsufficientBalance. L'appel echoue donc par un panic
        // arithmetique (0x11), pas par l'erreur ERC-20 qu'on attendrait
        // intuitivement d'un solde insuffisant.
        // Calcul a la main : reserves = [1e10, 1e10, 1e10], supply = 3e10,
        // burned = 2 * supply = 6e10
        //   amountsOut[0] = 1e10 * 6e10 / 3e10 = 2e10, superieur a
        //   reserves[0] = 1e10 : le decrement sous-flow des le premier indice.
        //
        // Pourquoi les deux tests voisins ne l'atteignent pas : le test
        // "_burnedShares superieur au solde LP" (II.B, ci-dessus) utilise
        // `balance + 1n`, qui reste strictement sous totalSupply() (le
        // depositor ne detient jamais la totalite de l'offre, l'adresse
        // morte en garde MINIMUM_LIQUIDITY) ; et bruler exactement
        // totalSupply() (II.C.3, "personne ne peut bruler...") donne
        // amountsOut[i] == reserves[i], un decrement a zero sans sous-flow,
        // qui echoue donc par ERC20InsufficientBalance au _burn suivant.
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const totalSupply = await pool.read.totalSupply();
        const burned = 2n * totalSupply;

        await assertPanic(
          pool.write.removeLiquidity([burned, [0n, 0n, 0n]], { account: depositor.account }),
          PANIC_ARITHMETIC_OVERFLOW,
        );
      });
    });

    describe("C) Cas limites", function () {
      it("_minOut exactement egal aux montants sortants est accepte", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        await assert.doesNotReject(
          pool.write.removeLiquidity([BURN_AMOUNT, EXPECTED_NOMINAL_AMOUNTS_OUT], { account: depositor.account }),
          "un _minOut egal aux montants sortants ne devrait pas revert",
        );
      });

      describe("1) _burnedShares == 0", function () {
        it("ne transfere aucun token (soldes du retirant inchanges)", async function () {
          const { pool, tokens, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
          const balancesBefore = await readBalances(tokens, depositor.account.address);

          await pool.write.removeLiquidity([0n, [0n, 0n, 0n]], { account: depositor.account });

          const balancesAfter = await readBalances(tokens, depositor.account.address);
          assert.deepEqual(
            balancesAfter,
            balancesBefore,
            `les soldes du retirant ne devraient pas varier : avant=[${balancesBefore}], apres=[${balancesAfter}]`,
          );
        });

        it("laisse les trois reserves inchangees", async function () {
          const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
          const reservesBefore = await readReserves(pool);

          await pool.write.removeLiquidity([0n, [0n, 0n, 0n]], { account: depositor.account });

          const reservesAfter = await readReserves(pool);
          assert.deepEqual(
            reservesAfter,
            reservesBefore,
            `les reserves ne devraient pas varier : avant=[${reservesBefore}], apres=[${reservesAfter}]`,
          );
        });

        it("laisse totalSupply() inchange", async function () {
          const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
          const supplyBefore = await pool.read.totalSupply();

          await pool.write.removeLiquidity([0n, [0n, 0n, 0n]], { account: depositor.account });

          const supplyAfter = await pool.read.totalSupply();
          assert.equal(
            supplyAfter,
            supplyBefore,
            `totalSupply ne devrait pas varier : avant=${supplyBefore}, apres=${supplyAfter}`,
          );
        });

        it("emet quand meme RemovedLiquidity, avec trois montants nuls", async function () {
          const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);

          await viem.assertions.emitWithArgs(
            pool.write.removeLiquidity([0n, [0n, 0n, 0n]], { account: depositor.account }),
            pool,
            "RemovedLiquidity",
            [depositor.account.address, [0n, 0n, 0n], 0n],
          );
        });
      });

      describe("2) Arrondi entier, toujours en faveur du pool", function () {
        it("bruler 1 seule part ne rend aucun token", async function () {
          // C'est la rounding rule du projet : ce que le pool verse est
          // toujours tronque vers le bas (division entiere Solidity), la
          // valeur residuelle reste acquise aux autres LP plutot que d'etre
          // arrondie au benefice du retirant.
          // Calcul a la main : reserves[i] * _burnedShares / supply, avec
          // reserves = [1e10, 1e10, 1e10] et supply = 3e10 :
          //   chaque jambe : 1e10 * 1 / 3e10 = 0,333... -> 0
          // Les trois tronquent a 0.
          const { pool, tokens, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
          const balancesBefore = await readBalances(tokens, depositor.account.address);

          await pool.write.removeLiquidity([1n, [0n, 0n, 0n]], { account: depositor.account });

          const balancesAfter = await readBalances(tokens, depositor.account.address);
          assert.deepEqual(
            balancesAfter,
            balancesBefore,
            `bruler 1 part ne devrait rendre aucun token : avant=[${balancesBefore}], apres=[${balancesAfter}]`,
          );
        });

        it("la part brulee disparait quand meme du totalSupply", async function () {
          const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
          const supplyBefore = await pool.read.totalSupply();

          await pool.write.removeLiquidity([1n, [0n, 0n, 0n]], { account: depositor.account });

          const supplyAfter = await pool.read.totalSupply();
          const burned = supplyBefore - supplyAfter;
          assert.equal(
            burned,
            1n,
            `le retirant paie 1 part et ne recoit rien en retour : totalSupply devrait quand meme baisser de 1 (avant=${supplyBefore}, apres=${supplyAfter})`,
          );
        });
      });

      describe("3) Retrait total et propriete des parts", function () {
        it("retirer la totalite de ses parts laisse un residu non nul dans chaque reserve", async function () {
          // C'est la protection anti-inflation du premier depot, observable
          // ici : le pool ne se vide jamais completement, meme quand son
          // unique detenteur de parts "libres" (hors adresse morte) retire
          // tout ce qu'il possede.
          // Calcul a la main : reserves = [1e10, 1e10, 1e10], totalSupply = 3e10
          //   burned = totalSupply - MINIMUM_LIQUIDITY
          //          = 30 000 000 000 - 1000 = 29 999 999 000
          //   amountsOut[i] = reserves[i] * burned / totalSupply
          //     chaque jambe : 1e10 * 29 999 999 000 / 3e10 = 9 999 999 666 (tronque)
          //   residu[i] = reserves[i] - amountsOut[i]
          //     chaque jambe : 1e10 - 9 999 999 666 = 334
          const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
          const fullBalance = await pool.read.balanceOf([depositor.account.address]);

          await pool.write.removeLiquidity([fullBalance, [0n, 0n, 0n]], { account: depositor.account });

          const reservesAfter = await readReserves(pool);
          const expectedResidual: [bigint, bigint, bigint] = [334n, 334n, 334n];
          assert.deepEqual(
            reservesAfter,
            expectedResidual,
            `reserves apres retrait total du solde libre=[${reservesAfter}], attendu=[${expectedResidual}] (calcul a la main en commentaire)`,
          );
        });

        it("personne ne peut bruler les parts detenues par l'adresse morte", async function () {
          // L'adresse morte n'a pas de cle : ces MINIMUM_LIQUIDITY parts sont
          // perdues par construction. Aucun compte ne possede a lui seul
          // totalSupply() (le depositor en detient totalSupply() -
          // MINIMUM_LIQUIDITY au maximum), donc tenter de bruler la totalite
          // de l'offre echoue par un manque de solde ordinaire.
          const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
          const totalSupply = await pool.read.totalSupply();

          await viem.assertions.revertWithCustomError(
            pool.write.removeLiquidity([totalSupply, [0n, 0n, 0n]], { account: depositor.account }),
            pool,
            "ERC20InsufficientBalance",
          );
        });

        it("un porteur ayant recu ses parts par simple transfer ERC-20 peut retirer", async function () {
          // Le token LP est une part transferable ordinaire : removeLiquidity
          // n'a aucun controle d'acces, il verifie uniquement le solde LP de
          // msg.sender au moment de l'appel, peu importe comment ce solde a
          // ete obtenu (mint via addLiquidity, ou simple transfer).
          //
          // Assertion sur ce qu'il recoit reellement, pas seulement sur
          // l'absence de revert : `other` brule BURN_AMOUNT sur le pool
          // amorce, donc les memes montants qu'au cas nominal (II.A).
          const { pool, tokens, depositor, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
          await pool.write.transfer([other.account.address, BURN_AMOUNT], { account: depositor.account });
          const balancesBefore = await readBalances(tokens, other.account.address);

          await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: other.account });

          const balancesAfter = await readBalances(tokens, other.account.address);
          const received = balancesBefore.map((before, i) => balancesAfter[i] - before);
          assert.deepEqual(
            received,
            EXPECTED_NOMINAL_AMOUNTS_OUT,
            `recu par le porteur transfere=[${received}], attendu=[${EXPECTED_NOMINAL_AMOUNTS_OUT}] (memes montants qu'au cas nominal, meme _burnedShares)`,
          );
        });
      });

      describe("4) Retraits successifs", function () {
        it("deux retraits successifs de la meme quantite de parts rendent exactement les memes montants", async function () {
          // C'est le rapport reserves[i] / totalSupply qui est invariant sous
          // un retrait : les deux baissent de la meme fraction (celle que
          // representent les parts brulees dans l'offre totale), donc la
          // valeur d'une part ne bouge pas. Un retrait ne dilue ni n'enrichit
          // les porteurs restants ; deux retraits identiques doivent donc
          // rendre exactement les memes montants.
          // Calcul a la main : reserves = [1e10, 1e10, 1e10], supply = 3e10.
          //   1er retrait (BURN_AMOUNT = 3e9) :
          //     amountsOut = [1e10 * 3e9/3e10, ...] = [1e9, 1e9, 1e9]
          //   apres : reserves = [9e9, 9e9, 9e9], supply = 2,7e10
          //   2e retrait : amountsOut[i] = reserves[i] * 3e9 / 2,7e10 = reserves[i] / 9
          //              = [1e9, 1e9, 1e9] (identique)
          const { pool, tokens, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);

          const balancesBeforeFirst = await readBalances(tokens, depositor.account.address);
          await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account });
          const balancesAfterFirst = await readBalances(tokens, depositor.account.address);
          const receivedFirst = balancesBeforeFirst.map((before, i) => balancesAfterFirst[i] - before);

          await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account });
          const balancesAfterSecond = await readBalances(tokens, depositor.account.address);
          const receivedSecond = balancesAfterFirst.map((before, i) => balancesAfterSecond[i] - before);

          // On compare le second retrait a la constante du cas nominal plutot
          // qu'au premier retrait : comparer les deux retraits entre eux
          // passerait aussi bien si les deux rendaient zero, alors que la
          // constante epingle en plus la valeur attendue. Le message reporte
          // quand meme les deux triplets, c'est leur egalite qui est la
          // propriete testee.
          assert.deepEqual(
            receivedSecond,
            EXPECTED_NOMINAL_AMOUNTS_OUT,
            `2e retrait=[${receivedSecond}], 1er retrait=[${receivedFirst}] : deux retraits de la meme quantite de parts devraient rendre exactement les memes montants, ici [${EXPECTED_NOMINAL_AMOUNTS_OUT}]`,
          );
        });
      });
    });

    describe("D) Pool desequilibre", function () {
      describe("1) Composition et proportionnalite", function () {
        it("un retrait de 10% du totalSupply rend 10% de chaque reserve", async function () {
          const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const supplyBefore = await pool.read.totalSupply();
          const balancesBefore = await readBalances(tokens, depositor.account.address);
          const burnedShares = supplyBefore / 10n;

          await pool.write.removeLiquidity([burnedShares, [0n, 0n, 0n]], { account: depositor.account });

          const balancesAfter = await readBalances(tokens, depositor.account.address);
          const received = balancesBefore.map((before, i) => balancesAfter[i] - before);
          assert.deepEqual(
            received,
            [12_500_000_000n, 10_000_000_000n, 8_000_000_000n],
            `recu=[${received}], attendu 10% des reserves [1250e8, 1000e8, 800e8]`,
          );
        });

        it("un retrait ne modifie pas la composition du pool", async function () {
          // Propriete d'AMM independante de la formule interne : retirer 10%
          // du totalSupply doit faire baisser chaque reserve d'exactement
          // 10%, donc laisser le rapport entre les trois reserves inchange.
          // On compare deux lectures on-chain (reserves avant et apres),
          // sans reimplementer Pool.sol:125.
          const { pool, depositor } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const supplyBefore = await pool.read.totalSupply();
          const reservesBefore = await readReserves(pool);
          const burnedShares = supplyBefore / 10n;

          await pool.write.removeLiquidity([burnedShares, [0n, 0n, 0n]], { account: depositor.account });

          const reservesAfter = await readReserves(pool);
          const expectedReservesAfter = reservesBefore.map((r) => r - r / 10n) as [bigint, bigint, bigint];
          assert.deepEqual(
            reservesAfter,
            expectedReservesAfter,
            `composition modifiee par le retrait : avant=[${reservesBefore}], apres=[${reservesAfter}], attendu=[${expectedReservesAfter}]`,
          );
        });

        it("un retrait rend strictement plus du token abondant que du token rare", async function () {
          const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const supplyBefore = await pool.read.totalSupply();
          const balancesBefore = await readBalances(tokens, depositor.account.address);
          const burnedShares = supplyBefore / 10n;

          await pool.write.removeLiquidity([burnedShares, [0n, 0n, 0n]], { account: depositor.account });

          const balancesAfter = await readBalances(tokens, depositor.account.address);
          const receivedAbundant = balancesAfter[0] - balancesBefore[0]; // token0 = actif abondant (1250e8)
          const receivedRare = balancesAfter[2] - balancesBefore[2]; // token2 = actif rare (800e8)
          assert.ok(
            receivedAbundant > receivedRare,
            `token abondant devrait rendre plus : abondant=${receivedAbundant}, rare=${receivedRare}`,
          );
        });
      });

      describe("2) Consequence chiffree du desequilibre (calcul a la main)", function () {
        it("bruler 7 000 000 003 parts rend trois montants tronques vers le bas", async function () {
          // reserves = [1250e8, 1000e8, 800e8] (cf. fixture)
          // totalSupply = 300 000 000 000 (= 3 * seedAmount, fixe depuis
          // l'amorcage : le swap qui desequilibre la fixture ne mint ni ne
          // brule aucune part LP)
          // amountsOut[i] = reserves[i] * 7 000 000 003 / 300 000 000 000
          //   token0 : 125 000 000 000 * 7 000 000 003 / 300 000 000 000 = 2 916 666 667 (tronque)
          //   token1 : 100 000 000 000 * 7 000 000 003 / 300 000 000 000 = 2 333 333 334 (tronque)
          //   token2 :  80 000 000 000 * 7 000 000 003 / 300 000 000 000 = 1 866 666 667 (tronque)
          const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const balancesBefore = await readBalances(tokens, depositor.account.address);
          const burnedShares = 7_000_000_003n;

          await pool.write.removeLiquidity([burnedShares, [0n, 0n, 0n]], { account: depositor.account });

          const balancesAfter = await readBalances(tokens, depositor.account.address);
          const received = balancesBefore.map((before, i) => balancesAfter[i] - before);
          assert.deepEqual(
            received,
            [2_916_666_667n, 2_333_333_334n, 1_866_666_667n],
            `recu=[${received}], attendu=[2916666667n, 2333333334n, 1866666667n] (calcul a la main en commentaire)`,
          );
        });
      });

      describe("3) Evenement avec des montants distincts", function () {
        it("RemovedLiquidity porte trois amountsOut distincts sur un pool desequilibre", async function () {
          // Memes valeurs que le test hardcode ci-dessus.
          const { pool, depositor } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const burnedShares = 7_000_000_003n;

          await viem.assertions.emitWithArgs(
            pool.write.removeLiquidity([burnedShares, [0n, 0n, 0n]], { account: depositor.account }),
            pool,
            "RemovedLiquidity",
            [depositor.account.address, [2_916_666_667n, 2_333_333_334n, 1_866_666_667n], burnedShares],
          );
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // III] Proprietes de conservation
  // ---------------------------------------------------------------------------

  describe("III] Proprietes de conservation", function () {
    describe("A) Aller-retour addLiquidity puis removeLiquidity", function () {
      it("token0 : ne recupere jamais plus que ce qui a ete depose", async function () {
        await assertRoundTripNeverExceedsDeposit(0);
      });

      it("token1 : ne recupere jamais plus que ce qui a ete depose", async function () {
        await assertRoundTripNeverExceedsDeposit(1);
      });

      it("token2 : ne recupere jamais plus que ce qui a ete depose", async function () {
        await assertRoundTripNeverExceedsDeposit(2);
      });
    });

    describe("B) Les frais reviennent aux LP", function () {
      it("apres un aller-retour de swaps d'un tiers, le depositor retire plus que son depot initial", async function () {
        // En v1 les trois BTC enveloppes sont traites 1:1 (aucune conversion
        // de prix entre wBTC/cbBTC/lBTC dans le contrat) : c'est une
        // hypothese assumee du projet, qui rend la somme des trois montants
        // comparable a un total de BTC, et donc comparable au total depose.
        const { pool, tokens, depositor, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);

        // `other` fait un aller-retour de swaps (token0 -> token1 puis
        // token1 -> token0). feeNum = 5 (0.5%) sur chaque swap : la portion
        // non convertie du montant en entree (voir Pool.sol:139-140) reste
        // dans les reserves, au benefice des LP.
        const swapAmount = SEED_AMOUNT / 10n;
        await tokens[0].write.mint([other.account.address, swapAmount]);
        await tokens[0].write.approve([pool.address, swapAmount], { account: other.account });
        await pool.write.swap([0n, swapAmount, 1n, 0n], { account: other.account });

        const otherToken1Balance = await tokens[1].read.balanceOf([other.account.address]);
        await tokens[1].write.approve([pool.address, otherToken1Balance], { account: other.account });
        await pool.write.swap([1n, otherToken1Balance, 0n, 0n], { account: other.account });

        // `depositor` retire tout son solde libre. Il ne peut pas recuperer
        // la fraction detenue par l'adresse morte (MINIMUM_LIQUIDITY), donc
        // la comparaison porte sur le delta de son solde autour de CET appel
        // uniquement (pas son solde absolu, qui inclut encore la marge
        // "headroom" mintee par la fixture et jamais depensee).
        const depositorShares = await pool.read.balanceOf([depositor.account.address]);
        const balancesBeforeWithdraw = await readBalances(tokens, depositor.account.address);

        await pool.write.removeLiquidity([depositorShares, [0n, 0n, 0n]], { account: depositor.account });

        const balancesAfterWithdraw = await readBalances(tokens, depositor.account.address);
        const received = balancesBeforeWithdraw.map((before, i) => balancesAfterWithdraw[i] - before);
        const totalReceived = received[0] + received[1] + received[2];
        // Somme des trois jambes deposees a l'amorcage (montants egaux) :
        // 3 * SEED_AMOUNT.
        const totalDeposited = 3n * SEED_AMOUNT;
        assert.ok(
          totalReceived > totalDeposited,
          `total recu=${totalReceived} (somme des 3 tokens), devrait depasser le total depose=${totalDeposited} grace aux frais accumules par l'aller-retour de swaps`,
        );
      });
    });
  });
});
