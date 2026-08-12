// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Pool} from "./Pool.sol";
import {MockWrappedBTC} from "./MockWrappedBTC.sol";
import {Test} from "forge-std/Test.sol";

/// BANC DE MESURE DU GAZ — CE N'EST PAS UNE SUITE DE TESTS.
///
/// Ce fichier n'a pas pour but de vérifier que le contrat est correct : cette
/// question est traitée par `test/Pool.addLiquidity.test.ts` (fonctionnel) et
/// le sera par les tests de fuzz et d'invariants à venir. Il a un seul but,
/// mesurer ce que chaque fonction coûte, dans un scénario figé, pour que le
/// coût soit comparable d'une version du contrat à la suivante.
///
/// RÈGLE D'OR : les montants déclarés ci-dessous ne se modifient JAMAIS.
/// Les changer ne casse aucun test, mais rend toutes les mesures antérieures
/// incomparables, et cette rupture est silencieuse. Ajouter un nouveau
/// scénario est en revanche sans danger : chaque fonction a sa propre entrée
/// dans le rapport, une ligne neuve ne perturbe pas les anciennes.
///
/// Chaque fonction porte une assertion minimale. Elle ne sert pas à tester le
/// contrat, elle sert à garantir que le scénario s'est réellement déroulé :
/// une mesure de gaz sur un appel qui n'a rien fait ne vaut rien.
contract PoolGasBench is Test {

  MockWrappedBTC public wbtc;
  MockWrappedBTC public cbbtc;
  MockWrappedBTC public lbtc;
  Pool public pool;

  // ---------------------------------------------------------------------
  // Montants figés du banc. NE PAS MODIFIER.
  // ---------------------------------------------------------------------
  uint256 constant SEED = 1000 * 10 ** 8;      // amorçage du pool
  uint256 constant DEPOSIT = 100 * 10 ** 8;    // dépôt de référence
  uint256 constant SWAP_IN = 250 * 10 ** 8;    // échange de référence
  uint256 constant FEE_NUM = 5;                // 0,5 %

  function setUp() public {
    wbtc = new MockWrappedBTC("Wrapped BTC", "wBTC");
    cbbtc = new MockWrappedBTC("Coinbase BTC", "cbBTC");
    lbtc = new MockWrappedBTC("Lombard BTC", "lBTC");

    address[3] memory tokens = [address(wbtc), address(cbbtc), address(lbtc)];
    pool = new Pool(tokens, FEE_NUM, address(this));

    // Marge large : le banc doit pouvoir enchaîner amorçage, dépôts et
    // échanges sans qu'un approve manquant ne fausse une mesure.
    uint256 funding = SEED * 100;
    wbtc.mint(address(this), funding);
    cbbtc.mint(address(this), funding);
    lbtc.mint(address(this), funding);

    wbtc.approve(address(pool), funding);
    cbbtc.approve(address(pool), funding);
    lbtc.approve(address(pool), funding);
  }

  // Amorce le pool. Utilisé par tous les scénarios "pool amorcé".
  function _seed() internal {
    pool.addLiquidity(0, SEED, 0);
  }

  // Déséquilibre le pool par un échange, sans mesurer ce dernier.
  function _imbalance() internal {
    pool.swap(0, SWAP_IN, 2, 0);
  }

  // ---------------------------------------------------------------------
  // addLiquidity
  // ---------------------------------------------------------------------

  /// Premier dépôt : les trois emplacements de réserve passent de zéro à une
  /// valeur non nulle, l'écriture est au tarif plein. C'est le coût le plus
  /// élevé de la fonction, et il n'est payé qu'une fois dans la vie du pool.
  function test_gas_AddLiquidity_EmptyPool() public {
    pool.addLiquidity(0, SEED, 0);
    assertGt(pool.totalSupply(), 0);
  }

  /// Dépôt courant : les réserves existent déjà, l'écriture est au tarif
  /// réduit. C'est ce chiffre-là qui représente l'usage réel du protocole.
  function test_gas_AddLiquidity_SeededPool() public {
    _seed();
    pool.addLiquidity(0, DEPOSIT, 0);
    assertGt(pool.balanceOf(address(this)), 0);
  }

  /// Même dépôt sur un pool dont les trois réserves diffèrent : la boucle de
  /// rééchelonnement travaille sur des ratios non triviaux.
  function test_gas_AddLiquidity_ImbalancedPool() public {
    _seed();
    _imbalance();
    pool.addLiquidity(0, DEPOSIT, 0);
    assertGt(pool.balanceOf(address(this)), 0);
  }

  // ---------------------------------------------------------------------
  // removeLiquidity
  // ---------------------------------------------------------------------

  /// Retrait partiel : les trois réserves restent non nulles après coup.
  function test_gas_RemoveLiquidity_Partial() public {
    _seed();
    uint256 half = pool.balanceOf(address(this)) / 2;
    pool.removeLiquidity(half, [uint256(0), 0, 0]);
    assertGt(pool.balanceOf(address(this)), 0);
  }

  /// Retrait total du déposant. Les réserves tombent au résidu correspondant
  /// aux parts brûlées vers l'adresse morte, sans jamais atteindre zéro : le
  /// remboursement de gaz de la remise à zéro n'est donc pas déclenché ici.
  function test_gas_RemoveLiquidity_Full() public {
    _seed();
    uint256 all = pool.balanceOf(address(this));
    pool.removeLiquidity(all, [uint256(0), 0, 0]);
    assertEq(pool.balanceOf(address(this)), 0);
  }

  // ---------------------------------------------------------------------
  // swap
  // ---------------------------------------------------------------------

  /// Échange de référence sur pool équilibré, frais à 0,5 %.
  function test_gas_Swap_BalancedPool() public {
    _seed();
    uint256 before = lbtc.balanceOf(address(this));
    pool.swap(0, SWAP_IN, 2, 0);
    assertGt(lbtc.balanceOf(address(this)), before);
  }

  /// Le même échange sur un pool déjà déséquilibré : même chemin de code,
  /// mesuré séparément parce que les réserves en jeu ne sont plus les mêmes.
  function test_gas_Swap_ImbalancedPool() public {
    _seed();
    _imbalance();
    uint256 before = lbtc.balanceOf(address(this));
    pool.swap(0, SWAP_IN, 2, 0);
    assertGt(lbtc.balanceOf(address(this)), before);
  }

  // ---------------------------------------------------------------------
  // setFee
  // ---------------------------------------------------------------------

  /// Seule fonction d'administration. Le délai d'un jour impose un warp, qui
  /// ne coûte rien : la mesure porte bien sur l'appel seul.
  function test_gas_SetFee() public {
    vm.warp(block.timestamp + 1 days);
    pool.setFee(3);
    assertEq(pool.feeNum(), 3);
  }
}
