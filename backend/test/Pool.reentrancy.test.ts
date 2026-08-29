// Suite de non-regression de la faille d'audit F4 : reentrance en
// add-liquidity.
//
// Ce que la suite interroge. `Pool.addLiquidity` frappe les parts LP et
// ecrit les trois reserves AVANT la boucle des trois `safeTransferFrom`.
// Entre ces deux moments, le pool a credite trois reserves et n'a encaisse
// au plus qu'un jeton. Un jeton du panier dote d'un hook cote PAYEUR
// permettait de rentrer dans `removeLiquidity` a cet instant precis, et
// `removeLiquidity` ne portait alors ni `nonReentrant` ni
// `whenNotPaused` : le reentrant se servait sur des reserves qu'il n'avait
// pas financees. Le correctif pose `nonReentrant` sur `addLiquidity`,
// `removeLiquidity` et `swap`, SANS toucher a l'ordre des operations, qui
// est delibere et couvert par les suites existantes.
//
// Pourquoi TypeScript et pas Solidity, ici. Les autres failles de l'audit
// se formulent en temps et en etat interne, et vivent en Solidity. F4, non :
// elle se formule en ORCHESTRATION MULTI-CONTRATS. Il faut un panier de
// trois ERC-20 distincts dont UN SEUL est piege, un compte qui approuve
// les trois puis envoie la transaction, et une re-entree qui traverse la
// frontiere jeton -> pool a l'interieur d'un `transferFrom`. C'est
// exactement la raison pour laquelle test/README.md loge `addLiquidity` en
// TypeScript : le contrat de test Solidity serait a la fois l'appelant, le
// porteur de parts et le declencheur, et la re-entree n'aurait plus rien a
// franchir. On deploie donc un vrai mock (`MockReentrantBTC`), on lui
// donne de vraies parts LP, et on regarde le hook partir depuis l'ABI.
//
// Chaque `it` est en deux temps : le commentaire decrit l'attaque telle
// qu'elle reussissait, l'assertion epingle le revert exact que la garde
// produit desormais. Le revert attendu est verifie par son selecteur
// d'erreur custom (`ReentrancyGuardReentrantCall`, d'OpenZeppelin, exposee
// par l'ABI du Pool qui en herite), jamais par une correspondance de
// chaine.

import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";

const { viem, networkHelpers } = await network.create();

// ---------------------------------------------------------------------------
// Constantes du contrat, dupliquees en dur comme dans Pool.swap.test.ts.
// ---------------------------------------------------------------------------

const EPOCH_DURATION = 14400n; // 4 h
const PRIORITY_WINDOW = 12n;
const MIN_FEE_NUM = 1n;
const NOMINAL_FEE_NUM = 5n;

// Amorce par jambe : 100 unites a 8 decimales. Reserves 1:1:1, au centre
// des bandes (13 %, 53 %).
const SEED = 100n * 10n ** 8n;
// Depot de l'attaquant, celui pendant lequel le hook part.
const ATTACK_AMOUNT = 10n * 10n ** 8n;
// Parts LP confiees au jeton piege, pour que la re-entree qu'il tente soit
// une re-entree QUI AURAIT REUSSI, et non un appel voue a echouer sur un
// solde vide. Sans elles, le test verifierait la garde sur un chemin que
// `_burn` aurait de toute facon referme, et ne prouverait rien.
// Le supply total apres amorcage vaut `3 * SEED` (3e10) ; 1e9 en est une
// fraction confortable que le deployeur peut ceder sans se vider.
const HOOK_SHARES = 10n * 10n ** 8n;

// ---------------------------------------------------------------------------
// Fixture
//
// Trois `MockReentrantBTC` distincts : le constructeur du Pool exige trois
// adresses non nulles, deux a deux distinctes, a 8 decimales, et distinctes
// de MRN. Le mock satisfait les quatre gardes. Un seul des trois sera arme ;
// les deux autres se comportent en ERC-20 ordinaires pendant tout le test,
// ce qui est le point : la faille tient a UN jeton du panier, pas au panier
// entier.
//
// Le jeton arme est celui d'INDEX 0, parce que la boucle de transfert
// d'`addLiquidity` part de l'index 0 : le hook part donc au tout premier
// `safeTransferFrom`, quand les trois reserves sont ecrites et qu'aucun
// jeton n'est encore entre. C'est l'instant le plus incoherent de la
// fonction, et donc le pire cas.
// ---------------------------------------------------------------------------

async function deployReentrantFixture() {
  const [deployer, attacker, treasury] = await viem.getWalletClients();

  const t0 = await viem.deployContract("MockReentrantBTC", ["Hooked BTC", "hBTC"]);
  const t1 = await viem.deployContract("MockReentrantBTC", ["Plain BTC 1", "pBTC1"]);
  const t2 = await viem.deployContract("MockReentrantBTC", ["Plain BTC 2", "pBTC2"]);
  const mrn = await viem.deployContract("MRN", []);

  const pool = await viem.deployContract("Pool", [
    [t0.address, t1.address, t2.address],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    NOMINAL_FEE_NUM,
    treasury.account.address,
    mrn.address,
    deployer.account.address,
  ]);

  const tokens = [t0, t1, t2];

  // Amorcage par le deployeur, hooks au repos (`armed` vaut false a la
  // construction, donc `transferFrom` se comporte en ERC-20 standard).
  for (const token of tokens) {
    await token.write.mint([deployer.account.address, SEED]);
    await token.write.approve([pool.address, SEED]);
  }
  await pool.write.addLiquidity([0n, SEED, 0n]);

  // L'attaquant se finance et approuve les trois jambes.
  for (const token of tokens) {
    await token.write.mint([attacker.account.address, ATTACK_AMOUNT * 2n]);
    await token.write.approve([pool.address, ATTACK_AMOUNT * 2n], {
      account: attacker.account,
    });
  }

  // Le jeton piege recoit de vraies parts LP : la re-entree qu'il tente
  // est alors une sortie parfaitement legitime, que seule la garde de
  // reentrance refuse.
  await pool.write.transfer([t0.address, HOOK_SHARES]);

  return { deployer, attacker, t0, t1, t2, tokens, mrn, pool };
}

// Calldata de la sortie que le hook tente : le jeton piege brule ses
// propres parts et encaisse sa quote-part des trois reserves. `_minOut` a
// zero sur les trois jambes : on ne veut surtout pas qu'un garde-fou de
// slippage vienne masquer le revert que le test cherche.
// `poolAbi` est volontairement typé `any` : le handle rendu par
// `viem.deployContract` porte l'ABI générée par Hardhat, dont le type exact
// n'est pas nommable ici sans dupliquer le code généré. C'est la même
// convention que scripts/attack/_harness.ts sur les handles de contrats.
// L'ancien `as never` ne compilait pas : il effondrait l'ABI à `never`, donc
// `functionName` n'avait plus aucun littéral valide à satisfaire.
function removeLiquidityCalldata(poolAbi: any, shares: bigint) {
  return encodeFunctionData({
    abi: poolAbi,
    functionName: "removeLiquidity",
    args: [shares, [0n, 0n, 0n]],
  });
}

describe("Pool — F4 reentrance en add-liquidity", async function () {

  // ---------------------------------------------------------------------------
  // I] Le mock fait bien ce qu'on lui demande
  //
  // Deux `it` de mise en place, avant l'attaque. Sans eux, un mock muet
  // rendrait le test principal vert pour la mauvaise raison : une garde
  // qui n'a jamais ete sollicitee ne prouve rien.
  // ---------------------------------------------------------------------------

  describe("I] Le hook du jeton piege part reellement", function () {

    it("un hook arme sur un appel inoffensif se declenche et laisse addLiquidity passer", async function () {
      // Controle. Le hook vise `totalSupply()`, une lecture qui ne
      // re-entre sur rien. Si `addLiquidity` passe ici et echoue dans le
      // test d'attaque, la difference vient de la CIBLE du hook, donc de
      // la garde de reentrance, et non du mecanisme du mock.
      const { pool, t0, attacker } = await networkHelpers.loadFixture(deployReentrantFixture);

      const benign = encodeFunctionData({
        abi: pool.abi as any,
        functionName: "totalSupply",
        args: [],
      });
      await t0.write.armReentrancy([pool.address, benign]);

      await pool.write.addLiquidity([0n, ATTACK_AMOUNT, 0n], { account: attacker.account });

      assert.equal(
        await t0.read.armed(),
        false,
        "le hook doit s'etre declenche pendant addLiquidity : `armed` est un verrou a un coup, il retombe a false quand il part",
      );
    });

    it("le jeton piege detient bien les parts LP qui rendraient sa sortie legitime", async function () {
      // Prealable rendu explicite. Si le jeton n'avait aucune part, la
      // re-entree du test suivant echouerait sur `_burn` meme sans garde,
      // et l'assertion sur `ReentrancyGuardReentrantCall` ne dirait rien
      // de la garde.
      const { pool, t0 } = await networkHelpers.loadFixture(deployReentrantFixture);

      const shares = await pool.read.balanceOf([t0.address]);
      assert.equal(
        shares,
        HOOK_SHARES,
        `le jeton piege detient ${shares} parts LP, attendu ${HOOK_SHARES} : sans elles, la re-entree echouerait pour une raison etrangere a la garde`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // II] L'attaque F4
  // ---------------------------------------------------------------------------

  describe("II] La re-entree sur removeLiquidity depuis addLiquidity", function () {

    it("la re-entree reverte avec ReentrancyGuardReentrantCall", async function () {
      // L'attaque, jouee telle quelle. L'attaquant depose ; au premier
      // `safeTransferFrom`, le jeton piege rappelle `removeLiquidity`
      // alors que le pool a deja credite ses trois reserves et n'a
      // encaisse aucun jeton. Avant le correctif, cette sortie
      // reussissait et le jeton repartait avec une quote-part de
      // reserves gonflees par un depot pas encore paye. Le hook du mock
      // fait remonter les donnees de revert telles quelles, donc c'est
      // bien le selecteur de la garde qui atteint la transaction
      // exterieure.
      const { pool, t0, attacker } = await networkHelpers.loadFixture(deployReentrantFixture);

      await t0.write.armReentrancy([
        pool.address,
        removeLiquidityCalldata(pool.abi, HOOK_SHARES),
      ]);

      await viem.assertions.revertWithCustomError(
        pool.write.addLiquidity([0n, ATTACK_AMOUNT, 0n], { account: attacker.account }),
        pool,
        "ReentrancyGuardReentrantCall",
      );
    });

    it("le depot entier est annule : le jeton piege ne garde aucune part supplementaire", async function () {
      // La consequence comptable de la garde. Le revert remonte jusqu'a
      // la transaction exterieure, donc RIEN n'est engage : ni les parts
      // frappees a l'attaquant, ni les reserves ecrites, ni la sortie du
      // jeton piege. C'est ce que l'atomicite doit garantir, et c'est ce
      // que la faille cassait.
      const { pool, t0, attacker } = await networkHelpers.loadFixture(deployReentrantFixture);

      await t0.write.armReentrancy([
        pool.address,
        removeLiquidityCalldata(pool.abi, HOOK_SHARES),
      ]);
      await assert.rejects(
        pool.write.addLiquidity([0n, ATTACK_AMOUNT, 0n], { account: attacker.account }),
      );

      const shares = await pool.read.balanceOf([t0.address]);
      assert.equal(
        shares,
        HOOK_SHARES,
        `le jeton piege detient ${shares} parts apres l'attaque annulee, attendu ${HOOK_SHARES} inchangees : le revert doit avoir tout defait`,
      );
    });

    it("une sortie ordinaire, hors re-entree, reste possible", async function () {
      // La contrepartie indispensable : `nonReentrant` sur
      // `removeLiquidity` ne doit pas fermer la porte de sortie, qui
      // reste ouverte meme en pause. Le verrou ne mord que pendant
      // l'appel d'un AUTRE point d'entree du pool.
      const { pool, t0, deployer } = await networkHelpers.loadFixture(deployReentrantFixture);

      const before = await t0.read.balanceOf([deployer.account.address]);
      await pool.write.removeLiquidity([HOOK_SHARES, [0n, 0n, 0n]]);
      const after = await t0.read.balanceOf([deployer.account.address]);

      assert.ok(
        after > before,
        `le solde du sortant vaut ${after} apres removeLiquidity contre ${before} avant : une sortie autonome doit toujours rendre des jetons, la garde ne verrouille que la re-entree`,
      );
    });
  });
});
