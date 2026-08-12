// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Pool} from "./Pool.sol";
import {MockWrappedBTC} from "./MockWrappedBTC.sol";
import {Test} from "forge-std/Test.sol";

/// BANC DE MESURE DU GAZ — CE N'EST PAS UNE SUITE DE TESTS.
///
/// La correction du contrat est vérifiée ailleurs : `test/Pool.addLiquidity.test.ts`
/// pour le fonctionnel, le fuzz et les invariants à venir pour la sûreté. Ce
/// fichier mesure un coût, dans un scénario figé, pour qu'il soit comparable
/// d'une version du contrat à la suivante. Voir GAS.md.
///
/// PRINCIPE DE MESURE : un chiffre = un appel, jamais un appel plus sa mise en
/// situation. Toute la préparation vit donc dans `setUp()`, que l'instantané
/// exclut, et le corps de chaque fonction de test ne contient que l'appel
/// mesuré. C'est la raison des trois contrats ci-dessous : un état de pool par
/// contrat, plutôt qu'un `_seed()` en tête de test qui gonflerait la mesure.
///
/// L'assertion porte sur la valeur de retour, déjà en mémoire : elle garantit
/// que le scénario s'est réellement déroulé pour un coût négligeable et
/// constant. Aucune lecture externe dans un corps mesuré, un `totalSupply()`
/// ajouterait ~2 500 de gaz à chaque relevé.
///
/// RÈGLE D'OR : les montants ci-dessous ne se modifient JAMAIS. Les changer ne
/// casse aucun test, mais rend toutes les mesures antérieures incomparables, et
/// cette rupture est silencieuse. Ajouter un scénario est en revanche sans
/// danger, une entrée absente de la référence ne fait pas échouer le contrôle.

abstract contract PoolGasBase is Test {

  MockWrappedBTC public wbtc;
  MockWrappedBTC public cbbtc;
  MockWrappedBTC public lbtc;
  Pool public pool;

  // Montants figés du banc. NE PAS MODIFIER.
  uint256 constant SEED = 1000 * 10 ** 8;      // amorçage du pool
  uint256 constant DEPOSIT = 100 * 10 ** 8;    // dépôt de référence
  uint256 constant SWAP_IN = 250 * 10 ** 8;    // échange de référence
  uint256 constant FEE_NUM = 5;                // 0,5 %

  function setUp() public virtual {
    wbtc = new MockWrappedBTC("Wrapped BTC", "wBTC");
    cbbtc = new MockWrappedBTC("Coinbase BTC", "cbBTC");
    lbtc = new MockWrappedBTC("Lombard BTC", "lBTC");

    address[3] memory tokens = [address(wbtc), address(cbbtc), address(lbtc)];
    pool = new Pool(tokens, FEE_NUM, address(this));

    // Marge large : aucun approve manquant ne doit fausser une mesure.
    uint256 funding = SEED * 100;
    wbtc.mint(address(this), funding);
    cbbtc.mint(address(this), funding);
    lbtc.mint(address(this), funding);

    wbtc.approve(address(pool), funding);
    cbbtc.approve(address(pool), funding);
    lbtc.approve(address(pool), funding);
  }
}

/// Pool vierge. Le premier dépôt fait passer les trois emplacements de réserve
/// de zéro à une valeur non nulle : écriture au tarif plein, payée une seule
/// fois dans la vie du pool.
contract PoolGasEmptyPool is PoolGasBase {

  function test_gas_AddLiquidity() public {
    uint256 minted = pool.addLiquidity(0, SEED, 0);
    assertGt(minted, 0);
  }
}

/// Pool amorcé et équilibré. C'est l'état nominal du protocole, et donc la
/// série de chiffres qui représente l'usage réel.
contract PoolGasSeededPool is PoolGasBase {

  uint256 internal halfShares;
  uint256 internal allShares;

  function setUp() public virtual override {
    super.setUp();
    pool.addLiquidity(0, SEED, 0);
    allShares = pool.balanceOf(address(this));
    halfShares = allShares / 2;
    // Le délai de setFee court depuis le déploiement : on le purge ici pour
    // que la mesure de setFee ne dépende pas de l'ordre des tests.
    vm.warp(block.timestamp + 1 days);
  }

  function test_gas_AddLiquidity() public {
    uint256 minted = pool.addLiquidity(0, DEPOSIT, 0);
    assertGt(minted, 0);
  }

  /// Retrait partiel : les trois réserves restent non nulles après coup.
  function test_gas_RemoveLiquidity_Partial() public {
    uint256[3] memory out = pool.removeLiquidity(halfShares, [uint256(0), 0, 0]);
    assertGt(out[0], 0);
  }

  /// Retrait de la totalité des parts du déposant. Les réserves tombent au
  /// résidu correspondant aux parts brûlées vers l'adresse morte, sans jamais
  /// atteindre zéro : aucun remboursement de remise à zéro n'est déclenché.
  function test_gas_RemoveLiquidity_Full() public {
    uint256[3] memory out = pool.removeLiquidity(allShares, [uint256(0), 0, 0]);
    assertGt(out[0], 0);
  }

  function test_gas_Swap() public {
    uint256 out = pool.swap(0, SWAP_IN, 2, 0);
    assertGt(out, 0);
  }

  /// Seule fonction d'administration. Pas d'assertion : elle revert si elle
  /// échoue, le test échoue avec elle.
  function test_gas_SetFee() public {
    pool.setFee(3);
  }
}

/// Même pool, déséquilibré par un échange préalable : les trois réserves
/// diffèrent, la boucle de rééchelonnement d'addLiquidity travaille sur des
/// ratios non triviaux.
///
/// N'y figurent que les deux fonctions dont on pouvait croire que le
/// déséquilibre change le coût. Vérifié : il ne le change pas, le gaz dépend
/// des opérations effectuées, pas des valeurs manipulées, et les emplacements
/// de stockage sont déjà non nuls dans les deux états. Les autres scénarios ont
/// été retirés d'ici après avoir donné des chiffres identiques au pool
/// équilibré : deux entrées qui bougent toujours ensemble sont du bruit dans
/// une revue de différences.
contract PoolGasImbalancedPool is PoolGasBase {

  function setUp() public override {
    super.setUp();
    pool.addLiquidity(0, SEED, 0);
    pool.swap(0, SWAP_IN, 2, 0);
  }

  function test_gas_AddLiquidity() public {
    uint256 minted = pool.addLiquidity(0, DEPOSIT, 0);
    assertGt(minted, 0);
  }

  function test_gas_Swap() public {
    uint256 out = pool.swap(0, SWAP_IN, 2, 0);
    assertGt(out, 0);
  }
}
