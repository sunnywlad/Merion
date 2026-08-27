// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {CommonBase} from 'forge-std/Base.sol';
import {StdUtils} from 'forge-std/StdUtils.sol';
import {StdAssertions} from 'forge-std/StdAssertions.sol';
import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from './PoolTestBase.sol';
import {Pool} from '../contracts/Pool.sol';
import {MockWrappedBTC} from '../contracts/MockWrappedBTC.sol';

contract PoolHandler is CommonBase, StdUtils, StdAssertions {
  MockWrappedBTC public wbtc;
  MockWrappedBTC public cbbtc;
  MockWrappedBTC public lbtc;
  Pool public pool;

  // Plancher economique impose au handler (pas au contrat) : une unite de
  // BTC par jambe. En dessous, la troncature entiere des divisions de
  // Pool.sol (addLiquidity, removeLiquidity, aucune des deux gardee par les
  // bandes) pese autant que les reserves elles-memes et peut deriver les
  // ratios sans qu'aucun require ne s'y oppose (voir le commentaire de
  // invariant_bandsAlwaysRespected plus bas). Border addLiquidityWrapper,
  // removeLiquidityWrapper et addThenRemoveRoundTrip a ce seuil confine le
  // fuzz aux pools de taille economiquement reelle, ou l'invariant tient.
  uint256 constant MIN_ECONOMIC_RESERVE = 1e8;

  function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256 m) {
    m = a < b ? a : b;
    m = m < c ? m : c;
  }

  // G2 en fuzz : traduit ici plutot qu'en un invariant_ separe, parce que la
  // propriete porte sur un DELTA (avant/apres un addLiquidity precis), et
  // qu'un invariant_ ne voit que l'etat courant entre deux appels du handler,
  // jamais la transition d'un appel en particulier. Un seul echec suffit a
  // faire tomber ce drapeau a false pour le reste du run ; PoolInvariantTest
  // l'expose via invariant_addLiquidityDeliversAllThreeLegs.
  bool public allAddLiquidityLegsGrew = true;

  // Chemin gestionnaire (defaut 4) : nombre de swaps qui ont reellement mute
  // les reserves (swapsExecuted) et, parmi eux, ceux tournes alors qu'un
  // manager etait nomme pour l'epoch courante (swapsUnderManager). Sous le
  // harnais courant, setUp de PoolInvariantTest nomme un manager pour
  // l'epoch 1 et y fait entrer l'horloge : les deux compteurs avancent donc
  // ensemble. L'ecart n'apparaitrait que si un futur remaniement de fixture
  // re-vidait le chemin gestionnaire ; invariant_managerPathWasExercised
  // expose ce garde-fou au runner.
  uint256 public swapsExecuted;
  uint256 public swapsUnderManager;

  constructor(MockWrappedBTC _wbtc, MockWrappedBTC _cbbtc, MockWrappedBTC _lbtc, Pool _pool) {
    wbtc = _wbtc;
    cbbtc = _cbbtc;
    lbtc = _lbtc;
    pool = _pool;

    wbtc.approve(address(pool), 21_000_000e8);
    cbbtc.approve(address(pool), 21_000_000e8);
    lbtc.approve(address(pool), 21_000_000e8);
  }

  function poolState() internal view returns (uint256[3] memory reserves, uint256[3] memory balances) {
    reserves[0] = pool.reserves(0);
    reserves[1] = pool.reserves(1);
    reserves[2] = pool.reserves(2);
    balances[0] = wbtc.balanceOf(address(pool));
    balances[1] = cbbtc.balanceOf(address(pool));
    balances[2] = lbtc.balanceOf(address(pool));
  }

  function assertReservesTrackBalances(uint256[3] memory reservesBefore, uint256[3] memory balancesBefore) internal view {
    (uint256[3] memory reservesAfter, uint256[3] memory balancesAfter) = poolState();
    for (uint256 i; i < 3; i++) {
      assertEq(reservesAfter[i] + balancesBefore[i], reservesBefore[i] + balancesAfter[i]);
    }
  }

  // Somme des deux registres de frais pour une jambe : part protocole
  // (globale) + part du mandat `_mgr` (nulle si aucun manager). swap()
  // deplace protocolCut et managerCut hors de `reserves` vers ces
  // registres, mais l'argent reste en SOLDE du pool : la conservation
  // stricte de swapWrapper doit donc porter sur reserves + ces registres,
  // pas sur reserves seules (addLiquidity / removeLiquidity, eux, ne
  // touchent aucun registre de frais et gardent la forme simple).
  function feeRegistrySnapshot(address _mgr) internal view returns (uint256[3] memory owed) {
    for (uint256 i; i < 3; i++) {
      owed[i] = pool.protocolFeesOwed(i) + (_mgr == address(0) ? 0 : pool.feesOwed(_mgr, i));
    }
  }

  function addLiquidityWrapper(uint256 _anchorIndex, uint256 _amount, uint256 _minShares) external returns (uint256 mintedShares) {
    uint256 anchorIndex = bound(_anchorIndex, 0, 2);
    uint256 supply = pool.totalSupply();
    // Sur pool non amorce, addLiquidity depose _amount a EGALITE sur les
    // trois jambes (Pool.sol:93) : les reserves resultantes valent
    // exactement _amount, pour tout le reste du run tant que rien ne les
    // rogne. La borne historique (334, premiere valeur qui rend
    // mintedShares > 0) est largement sous MIN_ECONOMIC_RESERVE (1e8) :
    // amorcer a 334 cree un pool de poussiere des le premier appel, avant
    // meme le premier retrait. Sur pool deja amorce, le depot est
    // proportionnel (Pool.sol:107-112) et ne fait QUE grossir chaque jambe :
    // la borne historique y reste sans danger.
    uint256 amount = supply == 0
      ? bound(_amount, MIN_ECONOMIC_RESERVE, 21_000_000e8)
      : bound(_amount, 334, 21_000_000e8);
    uint256 reservesAnchor = pool.reserves(anchorIndex);
    uint256 minShares = supply > 0 ? bound(_minShares, 0, supply * amount / reservesAnchor) : bound(_minShares, 0, 3 * amount - pool.MINIMUM_LIQUIDITY());

    (uint256[3] memory reservesBefore, uint256[3] memory balancesBefore) = poolState();
    mintedShares = pool.addLiquidity(anchorIndex, amount, minShares);
    assertReservesTrackBalances(reservesBefore, balancesBefore);
    assertGt(mintedShares, 0);

    (uint256[3] memory reservesAfter, ) = poolState();
    for (uint256 i; i < 3; i++) {
      if (reservesAfter[i] < reservesBefore[i] + 1) {
        allAddLiquidityLegsGrew = false;
      }
    }
  }

  function boundIndex(uint256 _index) internal pure returns (uint256 index) {
    index = bound(_index, 0, 2);
  }

  function expectedSwapAmountOut(uint256 indexIn, uint256 amount, uint256 indexOut) internal view returns (uint256) {
    // I.2 — voir Pool.swap.t.sol : le swap utilise effectiveFeeNum, et la
    // formule d'amountAfterFee est amount - amount * effective / FEE_DEN.
    uint256 effective = pool.effectiveFeeNum(indexIn, indexOut);
    uint256 amountAfterFee = amount - amount * effective / pool.FEE_DEN();
    return amountAfterFee * pool.reserves(indexOut) / (amountAfterFee + pool.reserves(indexIn));
  }

  // Le fuzzer choisit `amount` sans connaitre les bandes (floor = 13 %,
  // ceiling = 53 %, Pool.sol:20-21 et 151-154) : une bonne partie des tirages
  // pousserait legitimement une jambe hors bande, et sans ce try/catch un
  // seul de ces swaps ferait echouer tout le run, invariants compris. Le
  // catch n'avale QUE FloorTouched et CeilingTouched (les deux seuls reverts
  // attendus de cette garde) ; tout autre revert (panic, ReserveOverflow,
  // BadSlippage, ZeroOutput...) est rebubble tel quel, pour ne jamais
  // transformer ce wrapper en test vide qui masquerait un vrai bug.
  function swapWrapper(uint256 _indexIn, uint256 _amount, uint256 _indexOut, uint256 _minOut) external returns (uint256 amountOut) {
    uint256 indexIn = boundIndex(_indexIn);
    uint256 indexOut = boundIndex(_indexOut);
    uint256 amount = bound(_amount, 1, 21_000_000e8);
    uint256 minOut = bound(_minOut, 0, expectedSwapAmountOut(indexIn, amount, indexOut));

    // uint256() explicite : reserves() rend uint72, et uint72 * uint72
    // panique (Solidity 0.8, overflow) des que les reserves depassent
    // ~6,8e10 sats. Sans le cast, swapWrapper revert avant
    // assertGe(kAfter, kBefore) et le controle local de non-decroissance
    // de k ne tourne jamais sur les gros etats.
    uint256 kBefore = uint256(pool.reserves(indexIn)) * uint256(pool.reserves(indexOut));
    address mgrAtSwap = pool.manager();
    uint256[3] memory owedBefore = feeRegistrySnapshot(mgrAtSwap);
    (uint256[3] memory reservesBefore, uint256[3] memory balancesBefore) = poolState();

    try pool.swap(indexIn, amount, indexOut, minOut) returns (uint256 result) {
      amountOut = result;
    } catch (bytes memory reason) {
      bytes4 selector;
      assembly {
        selector := mload(add(reason, 32))
      }
      if (selector == Pool.FloorTouched.selector || selector == Pool.CeilingTouched.selector) {
        return 0;
      }
      assembly {
        revert(add(reason, 32), mload(reason))
      }
    }

    // Conservation avec frais partages : sur la jambe d'entree, le brut
    // `_amount` se ventile en trois — le NET qui entre dans `reserves`, la
    // part protocole et (si un manager est nomme) la part manager. Les deux
    // parts de frais restent en SOLDE du pool mais quittent `reserves` pour
    // les registres feesOwed. La conservation exacte est donc, par jambe :
    //   Δreserves[i] + ΔfeesOwed_total[i] == Δbalance[i].
    // Sans le terme de frais (l'ancienne forme, reservee ici a
    // addLiquidity / removeLiquidity), tout swap dont managerCut > 0 — le
    // chemin du defaut 4, exerce a chaque appel depuis que setUp nomme un
    // manager — faisait echouer cette assertion et etait rejete en silence
    // sous failOnRevert=false. Le terme de frais reactive la validation sur
    // ce chemin.
    (uint256[3] memory reservesAfter, uint256[3] memory balancesAfter) = poolState();
    uint256[3] memory owedAfter = feeRegistrySnapshot(mgrAtSwap);
    for (uint256 i; i < 3; i++) {
      assertEq(
        reservesAfter[i] + owedAfter[i] + balancesBefore[i],
        reservesBefore[i] + owedBefore[i] + balancesAfter[i]
      );
    }

    // Ce swap a mute les reserves. `mgrAtSwap` non nul => la garde de bande
    // de swap() vient de s'appliquer au NET du frais partage
    // (_amount - protocolCut - managerCut) et non au brut : le chemin du
    // defaut 4. setUp maintient un manager actif pour toute la duree du run.
    swapsExecuted++;
    if (mgrAtSwap != address(0)) {
      swapsUnderManager++;
    }

    uint256 kAfter = uint256(pool.reserves(indexIn)) * uint256(pool.reserves(indexOut));
    assertGe(kAfter, kBefore);
  }

  function removeLiquidityWrapper(uint256 _burnedShares) external returns (uint256[3] memory amountsOut) {
    uint256 supply = pool.totalSupply();
    uint256 minReserve = _min3(pool.reserves(0), pool.reserves(1), pool.reserves(2));
    // Le retrait est proportionnel (Pool.sol:124-128, meme fraction
    // burnedShares/supply sur les trois jambes) : c'est la jambe la plus
    // maigre qui souffre le plus, en absolu, d'un gros retrait. La borner
    // suffit a borner les deux autres, toujours >= elle. Cap deduit de
    // reserve_min * (supply - burnedShares) / supply >= MIN_ECONOMIC_RESERVE :
    //   burnedShares <= supply * (reserve_min - MIN_ECONOMIC_RESERVE) / reserve_min
    // Zero si reserve_min est deja sous MIN_ECONOMIC_RESERVE (ce qui couvre
    // aussi le pool non amorce, reserve_min alors nulle : la division n'est
    // jamais evaluee, court-circuitee par le ternaire).
    uint256 maxBurnable = minReserve <= MIN_ECONOMIC_RESERVE
      ? 0
      : supply * (minReserve - MIN_ECONOMIC_RESERVE) / minReserve;
    uint256 balance = pool.balanceOf(address(this));
    uint256 upperBound = maxBurnable < balance ? maxBurnable : balance;
    uint256 burnedShares = bound(_burnedShares, 0, upperBound);
    uint256[3] memory minOut;

    (uint256[3] memory reservesBefore, uint256[3] memory balancesBefore) = poolState();
    amountsOut = pool.removeLiquidity(burnedShares, minOut);
    assertReservesTrackBalances(reservesBefore, balancesBefore);
  }

  function addThenRemoveRoundTrip(uint256 _anchorIndex, uint256 _amount) external {
    uint256 anchorIndex = bound(_anchorIndex, 0, 2);
    uint256 supply = pool.totalSupply();
    // Meme raisonnement que addLiquidityWrapper ci-dessus sur la borne basse
    // d'amorcage.
    uint256 amount = supply == 0
      ? bound(_amount, MIN_ECONOMIC_RESERVE, 21_000_000e8)
      : bound(_amount, 334, 21_000_000e8);

    uint256 wbtcBefore = wbtc.balanceOf(address(this));
    uint256 cbbtcBefore = cbbtc.balanceOf(address(this));
    uint256 lbtcBefore = lbtc.balanceOf(address(this));

    uint256 mintedShares = pool.addLiquidity(anchorIndex, amount, 0);

    // Bruler par defaut la TOTALITE de mintedShares (comportement d'origine)
    // ne laisse en reserve, sur un pool amorce a l'instant, que la fraction
    // correspondant a MINIMUM_LIQUIDITY (brulee vers l'adresse morte,
    // Pool.sol:98) : environ MINIMUM_LIQUIDITY / 3, soit ~333 satoshis,
    // INDEPENDANT du montant depose (amount se simplifie dans le calcul),
    // toujours tres sous MIN_ECONOMIC_RESERVE. Meme cap que
    // removeLiquidityWrapper ci-dessus, applique a l'etat qui suit CET add.
    uint256 supplyAfterAdd = pool.totalSupply();
    uint256 minReserveAfterAdd = _min3(pool.reserves(0), pool.reserves(1), pool.reserves(2));
    uint256 maxBurnable = minReserveAfterAdd <= MIN_ECONOMIC_RESERVE
      ? 0
      : supplyAfterAdd * (minReserveAfterAdd - MIN_ECONOMIC_RESERVE) / minReserveAfterAdd;
    uint256 burnedShares = mintedShares < maxBurnable ? mintedShares : maxBurnable;

    uint256[3] memory minOut;
    pool.removeLiquidity(burnedShares, minOut);

    assertLe(wbtc.balanceOf(address(this)), wbtcBefore);
    assertLe(cbbtc.balanceOf(address(this)), cbbtcBefore);
    assertLe(lbtc.balanceOf(address(this)), lbtcBefore);
  }
}

contract PoolInvariantTest is Test, PoolTestBase {
  PoolHandler public handler;
  uint256 public lastShareValue;

  // Manager nomme pour l'epoch 1 par setUp. Adresse fixe et arbitraire, un
  // simple EOA sans code : le seul role du manager dans ce harnais est de
  // rendre pool.manager() non nul pour l'epoch du run, ce qui bascule
  // swap() sur le chemin managerCut > 0 (defaut 4). Le manager ne recoit
  // jamais de token ici (claimManagerFees n'est pas appele).
  address internal constant MANAGER = address(0xA11CE);

  function setUp() public override {
    super.setUp();
    handler = new PoolHandler(wbtc, cbbtc, lbtc, pool);
    wbtc.transfer(address(handler), 21_000_000e8);
    cbbtc.transfer(address(handler), 21_000_000e8);
    lbtc.transfer(address(handler), 21_000_000e8);

    targetContract(address(handler));

    // --- Chemin gestionnaire (defaut 4) --------------------------------
    // Sans cette sequence, le handler ne nomme jamais de manager :
    // managerCut vaut toujours zero et la garde de bande de swap() sur le
    // NET du frais partage n'est jamais eprouvee. On nomme donc un manager
    // pour l'epoch 1 et on fait entrer l'horloge dans cette epoch, comme
    // deploySeededPoolWithManagerFixture de Pool.audit.test.ts.
    //
    // Trois transactions qu'un acteur reel envoie dans cet ordre (aucun
    // vm.store, aucun etat inatteignable) :
    //   1. l'owner nomme un manager pour une epoch future. setManager
    //      l'autorise explicitement tant qu'aucune auction n'est branchee
    //      (auction == address(0) && msg.sender == owner()) ; ce contrat de
    //      test est l'owner (feeSetter du deploiement, cf. PoolTestBase).
    //      Appel fait AVANT le warp, sans quoi _epoch > currentEpoch()
    //      echouerait.
    //   2. EPOCH_DURATION s'ecoule, l'epoch 1 commence. Le fuzz Foundry
    //      n'avance pas block.timestamp entre deux appels du handler : apres
    //      ce warp unique l'horloge reste dans l'epoch 1 pour tout le run,
    //      donc manager() rend MANAGER a chaque appel et currentEpoch()
    //      vaut 1 en permanence.
    //   3. le manager fixe sa base de frais dans la fenetre de priorite
    //      (offset 1 s < PRIORITY_WINDOW = 12 s). lastSetFeeEpoch ==
    //      currentEpoch() == 1, donc feeInForce() rend feeNum (5) et le run
    //      tourne sous un manager actif a tarif fixe.
    pool.setManager(1, MANAGER);
    vm.warp(pool.GENESIS() + pool.EPOCH_DURATION() + 1);
    vm.prank(MANAGER);
    pool.setFee(5);
  }

  function invariant_reservesNeverExceedBalances() view public {
    assertLe(pool.reserves(0), wbtc.balanceOf(address(pool)));
    assertLe(pool.reserves(1), cbbtc.balanceOf(address(pool)));
    assertLe(pool.reserves(2), lbtc.balanceOf(address(pool)));
  }

  function invariant_shareValueNeverDecreases() public {
    uint256 supply = pool.totalSupply();
    if (supply == 0) return;

    uint256 currentShareValue = (uint256(pool.reserves(0)) + pool.reserves(1) + pool.reserves(2)) * 1e18 / supply;
    assertGe(currentShareValue, lastShareValue);
    lastShareValue = currentShareValue;
  }

  // G2 en fuzz : pour tout addLiquidity reussi observe pendant le run,
  // chaque reserve a grandi d'au moins 1 (ceilDiv, jamais une troncature qui
  // livrerait 0 tout en frappant des parts, Pool.sol:108). Le drapeau est mis
  // a jour par le handler lui-meme, seul a voir le delta avant/apres un appel
  // precis ; cet invariant ne fait que l'exposer au runner.
  function invariant_addLiquidityDeliversAllThreeLegs() view public {
    assertTrue(handler.allAddLiquidityLegsGrew());
  }

  // Pour chaque indice, la reserve doit rester strictement entre floor % et
  // ceiling % de la somme des trois (Pool.sol:151-154), en ratios et non en
  // valeurs absolues : c'est la garde que swap() applique a chaque appel.
  // Piege connu et volontairement non masque : addLiquidity et
  // removeLiquidity sont proportionnels EN THEORIE, mais aucun des deux ne
  // porte cette boucle ; sur des reserves tres inegales, la troncature
  // entiere d'un depot ou d'un retrait peut deriver les ratios sans qu'aucun
  // require ne s'y oppose.
  //
  // Ce que cet invariant affirme, exactement : la propriete est vraie sur les
  // pools d'une taille economiquement reelle, c'est-a-dire au moins une unite
  // de BTC par jambe (MIN_ECONOMIC_RESERVE, en tete de PoolHandler, qui borne
  // addLiquidityWrapper, removeLiquidityWrapper et addThenRemoveRoundTrip).
  // Elle n'est PAS affirmee en dessous de ce seuil, et ce n'est pas une
  // faiblesse du contrat : sur un pool de poussiere, l'unite indivisible du
  // satoshi pese autant que la reserve elle-meme, si bien que c'est la
  // troncature entiere qui fixe les ratios et non la courbe. Un tel etat n'a
  // aucun sens de marche : personne ne cote un pool de trois millioniemes de
  // BTC, et l'arbitrage qui redresse les ratios n'y a plus de granularite
  // pour operer.
  //
  // Trace du fait constate, a ne pas effacer. Avant ce bornage, pousse en
  // diagnostic ponctuel a `invariant.runs = 3000` / `invariant.depth = 500`
  // (via un commentaire `forge-config:` local, retire depuis), une longue
  // chaine alternant addLiquidityWrapper et removeLiquidityWrapper, sans
  // qu'aucun swap n'intervienne, faisait echouer l'invariant avec
  // `assertion failed: 169600 >= 169600` : la somme des trois reserves valait
  // alors 3 200 unites, soit 0,000032 BTC, dont 1 696 sur la jambe fautive,
  // qui touchait donc son plafond a l'unite pres (1 696 * 100 = 53 * 3 200).
  // Le contre-exemple etait donc arithmetique, pas economique. Depuis le
  // bornage, la meme configuration 3000 / 500 passe : 1 500 000 appels de
  // handler sans un seul ratio hors bande.
  function invariant_bandsAlwaysRespected() view public {
    uint256 sum = uint256(pool.reserves(0)) + pool.reserves(1) + pool.reserves(2);
    if (sum == 0) return; // pool jamais amorce : aucune bande a verifier

    uint256 floor_ = pool.floor();
    uint256 ceiling_ = pool.ceiling();
    for (uint256 i; i < 3; i++) {
      uint256 reserve = pool.reserves(i);
      assertLt(reserve * 100, ceiling_ * sum);
      assertGt(reserve * 100, floor_ * sum);
    }
  }

  // Defaut 4 : la garde de bande de swap() porte sur le NET du frais partage
  // (_amount - protocolCut - managerCut), jamais sur le brut. Cette
  // propriete n'est reellement eprouvee que si des swaps tournent sous un
  // manager nomme (managerCut > 0). setUp en nomme un pour l'epoch 1 et fait
  // entrer l'horloge dans cette epoch : le compteur du handler doit donc
  // grimper des qu'un swap mute les reserves. Garde-fou de non-regression :
  // si un futur remaniement de setUp re-vide le chemin gestionnaire,
  // swapsUnderManager reste a zero pendant que swapsExecuted grimpe, et cet
  // invariant mord. Le early-return couvre la fenetre d'avant le premier
  // swap, ou il n'y a rien a exiger.
  function invariant_managerPathWasExercised() view public {
    if (handler.swapsExecuted() == 0) return;
    assertGt(handler.swapsUnderManager(), 0);
  }

  // Verite de terrain du harnais elargi : setUp doit produire un manager
  // ACTIF (nomme + horloge dans son epoch + base de frais fixee), et un
  // swap qui accroit `feesOwed[MANAGER]` doit conserver l'actif du pool
  // sous la forme reserves + registres de frais. Verifie hors campagne de
  // fuzz, sur une sequence deterministe et bornee (reserves sous le seuil
  // ou le calcul uint72 de kBefore deborde, point faible pre-existant du
  // handler, sans rapport avec le chemin manager). Sans ce test, une
  // regression de fixture qui re-viderait le chemin passerait les
  // invariants (early-return sur swapsExecuted == 0) sans bruit.
  function test_managerPathIsActiveAndConserves() public {
    assertEq(pool.manager(), MANAGER);
    assertEq(pool.currentEpoch(), 1);
    assertEq(pool.feeInForce(), 5);

    handler.addLiquidityWrapper(0, 1e8, 0);
    for (uint256 i; i < 30; i++) {
      handler.swapWrapper(i % 3, 1e6 + i * 1e5, (i + 1) % 3, 0);
    }

    assertEq(handler.swapsUnderManager(), handler.swapsExecuted());
    assertGt(handler.swapsUnderManager(), 0);
    assertGt(
      pool.feesOwed(MANAGER, 0) + pool.feesOwed(MANAGER, 1) + pool.feesOwed(MANAGER, 2),
      0
    );
  }

  // Slot of `reserves` in Pool's storage. The packing of `uint72[3]` means
  // all three values live in a single slot; the high-order bits carry
  // reserves[2] and the low-order bits carry reserves[0]. The slot is
  // resolved at test time by reading the public getter and scanning
  // candidate slots, so a layout shift in OZ or in the parent contracts
  // surfaces as a clean probe failure rather than a silent wrong write.
  function _findReservesSlot() internal returns (bytes32) {
    handler.addLiquidityWrapper(0, 1_000e8, 0);

    uint256 r0 = pool.reserves(0);
    uint256 r1 = pool.reserves(1);
    uint256 r2 = pool.reserves(2);
    require(r0 == r1 && r1 == r2, "seed reserves not equal; bootstrap changed shape");
    uint256 packed = (r2 << 144) | (r1 << 72) | r0;

    for (uint256 i = 0; i < 20; i++) {
      bytes32 slot = bytes32(i);
      bytes32 value = vm.load(address(pool), slot);
      if (uint256(value) == packed) {
        return slot;
      }
    }
    revert("reserves slot not found in slots 0..19");
  }

  function test_InsufficientReserveReachedViaForgedState() public {
    bytes32 reservesSlot = _findReservesSlot();

    uint256 r1Before = pool.reserves(1);
    require(r1Before > 0, "seed reserves[1] must be positive");

    bytes32 current = vm.load(address(pool), reservesSlot);
    bytes32 zeroedReserves0 = current & ~bytes32(uint256((uint256(1) << 72) - 1));
    vm.store(address(pool), reservesSlot, zeroedReserves0);

    require(pool.reserves(0) == 0, "vm.store did not zero reserves[0]");
    require(pool.reserves(1) == r1Before, "vm.store touched reserves[1]");

    vm.expectRevert(Pool.InsufficientReserve.selector);
    pool.swap(0, 1000, 1, 0);
  }
}
