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
  // manager etait nomme pour l'epoch courante (swapsUnderManager).
  //
  // Les deux compteurs avancent TOUJOURS ensemble, et ce n'est pas un
  // artefact de fixture : ce handler n'a pas de warpWrapper, donc rien
  // n'avance block.timestamp pendant la campagne. Le warp unique de setUp
  // fige l'horloge dans l'epoch 1 pour tout le run ; manager() y rend
  // MANAGER a chaque appel, si bien que CHAQUE swap execute l'est sous
  // manager. invariant_managerPathWasExercised exige cette egalite exacte :
  // elle ne se briserait que si un futur remaniement (warpWrapper ajoute,
  // fixture qui re-vide le chemin gestionnaire) faisait deriver l'horloge.
  uint256 public swapsExecuted;
  uint256 public swapsUnderManager;

  // Nombre total d'appels de wrapper recus par ce handler, incremente en
  // TETE de chacun des quatre (avant tout bound, tout revert eventuel).
  // Sert la garde de vacuite invariant_campaignDidSomething : un run qui
  // n'incremente presque rien est un run ou le handler revert-bloque des
  // le premier appel, et ne teste plus aucun invariant.
  uint256 public totalCalls;

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
    totalCalls++;
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
  // ceiling = 53 %, Pool.sol:20-21 et 388-389) : une bonne partie des tirages
  // pousse legitimement une jambe hors bande, et sans ce try/catch un seul de
  // ces swaps ferait echouer tout le run, invariants compris. Le catch n'avale
  // QUE FloorTouched et CeilingTouched ; tout autre revert (panic,
  // ReserveOverflow, BadSlippage, ZeroOutput...) est rebubble tel quel.
  //
  // Ce que cette liste etroite N'ACHETE PAS sous failOnRevert = false : elle
  // ne protege pas d'un "test vide". Sous ce mode le runner discarde de la
  // meme facon un revert avale par le catch ET un revert rebubble en
  // assembleur : dans les deux cas l'appel de wrapper est jete et la campagne
  // continue. La liste etroite ne DISTINGUE donc pas, en campagne, un vrai bug
  // (panic, overflow) d'une bande touchee legitimement — les deux finissent
  // discardes. Elle reste correcte par principe et deviendra discriminante si
  // l'on flippe `failOnRevert = true` (dette, cf. bloc de deviation en tete de
  // PoolInvariantTest), ou un revert non liste ferait alors echouer le run.
  // En l'etat, la garantie "swap() respecte les bandes" est portee par
  // invariant_bandsAlwaysRespected (evalue apres chaque appel, mord quelle que
  // soit la config) et par les tests deterministes, pas par ce catch.
  //
  // Domaine de `amount` : sur pool amorce (reserve d'entree non nulle), borne
  // dans [2000, reserves(indexIn)]. Avant le retune c'etait [1, 21_000_000e8] :
  // sur des reserves de ~1e8 a ~1e11 cette plage de 2,1e15 encadrait le tirage
  // entre deux zones mortes (bas : ZeroOutput ; haut : la quasi-totalite de la
  // plage pousse hors bande, `catch` -> retour 0), et la plupart des swaps
  // fuzzes ne s'executaient PAS. Le retune ramene la borne haute a la reserve
  // d'entree : les tirages y font desormais exercer le vrai chemin de swap()
  // (calcul du frais partage, ecriture des reserves, boucle de garde de bande)
  // au lieu de rebondir sur des montants absurdes.
  //   - borne basse 2000 : ecarte la troncature a zero d'amountAfterFee ;
  //   - borne haute = reserve d'entree : sur un pool a peu pres equilibre,
  //     entrer `a` sur une jambe la pousse a un ratio
  //     (1 + x)^2 / (x^2 + 3x + 3) avec x = a / reserve ; ce ratio franchit le
  //     plafond 53 % vers x ~= 0,77. Les tirages sous ce seuil executent
  //     jusqu'au bout, ceux au-dela (ou moins des que le pool penche deja cote
  //     jambe entrante) heurtent CeilingTouched et prennent le
  //     `catch Floor/CeilingTouched`. Les deux regimes coexistent, ce qui
  //     empeche invariant_bandsAlwaysRespected d'etre trivialement satisfait
  //     sur le chemin swap().
  // `reserves(indexIn) / 2` (x max = 0,5, ratio plafond 47,4 %) a ete essaye
  // et ecarte : sur un pool que la campagne garde proche de l'equilibre il ne
  // fait jamais toucher la bande, le `catch` n'est jamais pris et I3 n'est
  // plus eprouve sur swap() en campagne. `/ 4` a fortiori.
  //
  // NB : la couverture n'est PAS garantie au niveau run (le fuzzer EDR n'est
  // pas contraint d'appeler swapWrapper, et afterInvariant n'assert pas
  // swapsExecuted > 0 — voir son commentaire et le bloc de residu en tete de
  // PoolInvariantTest). Le retune garantit la QUALITE des swaps fuzzes, pas
  // leur frequence ; invariant_bandsAlwaysRespected (mord par appel) + le
  // deterministe portent la garantie.
  //
  // Sur pool NON amorce (reserve d'entree nulle, totalSupply() == 0), on garde
  // le domaine historique : swap() y revert ZeroOutput, rebubble puis
  // discarde, le run ne fait rien de ce cote — comportement d'avant le retune.
  function swapWrapper(uint256 _indexIn, uint256 _amount, uint256 _indexOut, uint256 _minOut) external returns (uint256 amountOut) {
    totalCalls++;
    uint256 indexIn = boundIndex(_indexIn);
    uint256 indexOut = boundIndex(_indexOut);
    uint256 reserveIn = pool.reserves(indexIn);
    uint256 amount = reserveIn == 0
      ? bound(_amount, 1, 21_000_000e8)
      : bound(_amount, 2000, reserveIn);
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
    totalCalls++;
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
    totalCalls++;
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

// DEVIATION ASSUMEE DE LA FICHE I.6 : ce harnais tourne en
// `failOnRevert = false`. C'est le defaut du runner d'invariants EDR de
// Hardhat 3, et aucun `/// forge-config:` n'est pose ici (contrairement a
// Auction.invariant.t.sol) pour le passer a `true`. La fiche I.6 exige
// `true` ; on ne le flippe pas, pour trois raisons :
//
//  (a) Les `invariant_` de haut niveau de PoolInvariantTest sont evalues
//      apres chaque appel du handler et mordent quelle que soit la config.
//      La mutation de mutation-testing le prouve : neutraliser la garde de
//      bande de swap() fait tomber invariant_bandsAlwaysRespected, et lui
//      seul. C'est cette couche qui porte la valeur de la campagne.
//
//  (b) Les assertions INTERNES aux wrappers (assertReservesTrackBalances,
//      la conservation avec terme de frais du swapWrapper,
//      assertGe(kAfter, kBefore)) sont, elles, decoratives sous ce mode :
//      un revert d'assertion a l'interieur d'un wrapper est simplement
//      discarde par le runner, jamais propage. Elles ne valent donc que
//      par le test DETERMINISTE qui les execute vraiment, appel de wrapper
//      par appel de wrapper (test_managerPathIsActiveAndConserves). Les
//      proprietes de conservation qui portent sur l'ETAT COURANT, elles,
//      sont promues en invariant_ de haut niveau ci-dessous
//      (invariant_reservesTrackBalancesExactly).
//
//  (c) Passer a `failOnRevert = true` demanderait de borner chaque depot
//      au solde restant du handler et d'elargir la liste des selecteurs
//      avales par swapWrapper (aujourd'hui FloorTouched / CeilingTouched
//      seulement). Bonne hygiene, mais 300+ lignes d'infra heritee hors du
//      mandat des deux invariants I.6. Le flip est porte en dette.
//
// Residu assume : la couverture de campagne de I3
// (`invariant_bandsAlwaysRespected`) sur la garde de bande de `swap()` n'est
// PAS garantie au niveau run. Le fuzzer EDR choisit les selecteurs librement
// et n'appelle pas forcement swapWrapper sur un run donne ; un
// `assertGt(swapsExecuted, 0)` par run est auto-defait par le reducteur de
// contre-exemple (verifie empiriquement). Le domaine retune de `swapWrapper`
// garantit que les swaps QUI SONT fuzzes exercent le vrai chemin de la garde
// de bande (au lieu de rebondir dessus sur des montants absurdes). Le cas
// d'une garde de bande cassee est epingle par `invariant_bandsAlwaysRespected`
// (mutation verifiee : les deux `require` de bande neutralises dans `swap()`
// -> cet invariant, et lui seul, tombe) et par le deterministe
// `test_managerPathIsActiveAndConserves` (30 swaps executes, tous sous
// manager).
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

  // Forme FORTE de I1 : la ligne ci-dessus n'affirme qu'un `<=`, celle-ci
  // affirme l'egalite exacte. Sur chaque jambe du panier BTC, le solde
  // ERC-20 du pool se repartit a l'unite pres entre la reserve active et
  // les deux registres de frais que swap() alimente sans jamais sortir les
  // fonds du pool :
  //   reserves(i) + protocolFeesOwed(i) + feesOwed(MANAGER, i)
  //     == balanceOf(pool) pour la jambe i.
  // addLiquidity / removeLiquidity bougent reserve et solde du meme
  // montant ; swap deplace protocolCut / managerCut de `reserves` vers les
  // registres feesOwed sans toucher au solde ; le MINIMUM_LIQUIDITY brule
  // l'est en PARTS LP, pas en jeton du panier, il ne pese pas ici ; le
  // loyer MRN est verse dans un AUTRE jeton et n'entre pas dans l'egalite.
  //
  // La somme sur les managers se reduit a feesOwed(MANAGER, i) tant que
  // setUp ne nomme qu'un seul manager. Si un jour il y en a plusieurs,
  // cette somme doit iterer sur eux.
  function invariant_reservesTrackBalancesExactly() view public {
    MockWrappedBTC[3] memory legs = [wbtc, cbbtc, lbtc];
    for (uint256 i; i < 3; i++) {
      assertEq(
        uint256(pool.reserves(i)) + pool.protocolFeesOwed(i) + pool.feesOwed(MANAGER, i),
        legs[i].balanceOf(address(pool))
      );
    }
  }

  // Garde de vacuite de campagne, versant PAR APPEL. Le runner EDR evalue
  // chaque invariant_ apres CHAQUE appel du handler, jamais seulement en
  // fin de run : un `assertGt(totalCalls, seuil)` pose ici mordrait a
  // l'appel numero `seuil`, quel que soit l'etat reel de la campagne. Ce
  // qu'on peut affirmer par appel sans faux positif : passe la montee en
  // charge (100 appels de wrapper comptes), le pool a ete amorce. C'est
  // solide, pas seulement probable : avant amorcage, seuls
  // addLiquidityWrapper et addThenRemoveRoundTrip n'annulent pas leur
  // increment de totalCalls (swapWrapper divise par une reserve nulle,
  // removeLiquidityWrapper divise burnedShares par un supply nul), et ces
  // deux-la amorcent le pool. Donc totalCalls > 0 => totalSupply() > 0, et
  // atteindre 100 sans amorcage est impossible. Un handler revert-bloque
  // des le depart reste a totalCalls == 0 et prend le early-return ; c'est
  // afterInvariant, en fin de run, qui exige alors le seuil haut.
  //
  // On ne peut PAS exiger ici assertGt(swapsExecuted, 0) : le fuzzer tire
  // les montants de swap sans connaitre les bandes 13 / 53, et un run
  // entier ou chaque swap tente touche une bande (catch -> retour 0, pas
  // d'increment) est un resultat de fuzz frequent, pas une pathologie. La
  // couverture "un swap mute vraiment les reserves, sous manager" est
  // pinnee par test_managerPathIsActiveAndConserves (30 swaps deterministes
  // a montant modeste, tous executes).
  // I.7 #12 : la tautologie est posee comme un filet, pas comme une
  // propriete. `totalCalls > 100` implique `totalSupply > 0` par
  // construction : avant amorcage, seuls `addLiquidityWrapper` et
  // `addThenRemoveRoundTrip` n'annulent pas leur increment de
  // `totalCalls` (les autres divisent par une reserve ou un supply
  // nuls et revert en tete), et ces deux-la amorcent le pool. Donc
  // `totalCalls > 100` -> `totalSupply > 0`, point. L'assertion tient
  // pour la forme — un futur changement qui briserait cette implication
  // (un `addLiquidityWrapper` qui n'amorce pas, par exemple) la ferait
  // tomber, et c'est exactement le signal qu'on cherche. On NE SUPPRIME
  // PAS l'assert, c'est l'assertion elle-meme qui est tautologique, pas
  // le filet.
  function invariant_campaignDidSomething() view public {
    if (handler.totalCalls() < 100) return;
    assertGt(pool.totalSupply(), 0);
  }

  // Garde de vacuite de campagne, versant FIN DE RUN. afterInvariant()
  // tourne une seule fois par run, apres le dernier appel : c'est le seul
  // point ou un seuil HAUT sur le compteur cumule a un sens. Sous la
  // profondeur EDR par defaut (aucun forge-config dans ce fichier), les
  // runs de calibrage terminent entre ~180 et ~360 appels de wrapper
  // comptes (le compteur est increment en tete de wrapper, donc annule par
  // les appels qui revert). Le plancher 100 est franchement sous ce
  // minimum observe et franchement au-dessus de zero : un run qui n'y
  // arrive pas est un run ou le handler a revert-bloque tot, campagne vide.
  //
  // PAS de early-return `if (totalCalls == 0) return;` : la pathologie visee
  // (handler revert-bloque des le premier appel -> totalCalls == 0) est
  // EXACTEMENT la condition sur laquelle ce early-return laissait passer le
  // run. Il n'existe pas de passe afterInvariant a zero appel sous le runner
  // EDR : Auction.invariant.t.sol le prouve, son afterInvariant assert
  // `placeBidsOk > 0` sans aucune garde et 64 runs restent verts. La passe
  // post-setUp que l'ancien commentaire invoquait n'execute pas
  // afterInvariant (elle evalue les invariant_, pas ce hook).
  //
  // On n'y assert PAS swapsExecuted > 0. Sous le runner EDR le fuzzer choisit
  // les selecteurs librement et n'est jamais contraint d'appeler swapWrapper
  // sur un run donne ; des qu'afterInvariant peut echouer pour une raison,
  // le reducteur de contre-exemple minimise vers une sequence sans swap
  // (add / remove / round-trip n'incrementent jamais swapsExecuted) et la
  // rapporte comme contre-exemple. L'assertion serait auto-defaitable.
  // Verifie empiriquement : elle rougissait les 7 invariants sur des
  // sequences shrinkees 100 % sans swap. Le retune du domaine de swapWrapper
  // (cf. son commentaire) garantit la QUALITE des swaps fuzzes, pas leur
  // FREQUENCE. La couverture de la garde de bande sur le chemin swap() est
  // portee par invariant_bandsAlwaysRespected (mutation verifiee : boucle de
  // bande neutralisee -> il tombe seul) et par le deterministe
  // test_managerPathIsActiveAndConserves (30 swaps).
  function afterInvariant() view public {
    assertGt(handler.totalCalls(), 100);
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
  // entrer l'horloge dans cette epoch ; ce handler n'a pas de warpWrapper,
  // l'horloge ne bouge plus, donc manager() rend MANAGER a chaque appel et
  // CHAQUE swap execute l'est sous manager. D'ou l'egalite exacte, plus
  // forte qu'un simple `> 0` : si un futur remaniement (warpWrapper ajoute,
  // fixture qui re-vide le chemin gestionnaire) faisait deriver l'horloge,
  // swapsUnderManager decrocherait de swapsExecuted et cet invariant
  // mordrait au lieu de passer en silence. Le early-return couvre la
  // fenetre d'avant le premier swap, ou il n'y a rien a exiger.
  //
  // I.7 #12 : ALARME DE HARN AIS. Cette invariant est plus utile comme
  // detecteur de regression du setUp que comme une propriete de l'AMM
  // elle-meme. Elle NE SERT PAS a prouver que le managerCut > 0 (la
  // tautologie tient), elle sert a prouver que le harnais reste
  // structurellement en mesure de l'exercer. Si un futur remaniement
  // ajoutait un warpWrapper ou re-vidait le chemin gestionnaire, le
  // compteur decrocherait et l'invariant tomberait. Le jour ou
  // quelqu'un ouvre ce fichier, c'est ce role qu'il faut voir — pas
  // une verification d'audit du swap.
  function invariant_managerPathWasExercised() view public {
    if (handler.swapsExecuted() == 0) return;
    assertEq(handler.swapsUnderManager(), handler.swapsExecuted());
  }

  // Verite de terrain du harnais elargi : setUp doit produire un manager
  // ACTIF (nomme + horloge dans son epoch + base de frais fixee), et un
  // swap qui accroit `feesOwed[MANAGER]` doit conserver l'actif du pool
  // sous la forme reserves + registres de frais. Verifie hors campagne de
  // fuzz, sur une sequence deterministe et bornee : les montants restent
  // modestes (un seul add a 1e8, trente swaps a ~1e6) pour garder une
  // trace lisible et rejouable a la main, pas pour eviter un debordement.
  // Le calcul de k dans swapWrapper est en uint256 depuis ac25bad, il ne
  // deborde plus. Sans ce test, une regression de fixture qui re-viderait
  // le chemin gestionnaire passerait les invariants (early-return sur
  // swapsExecuted == 0) sans bruit.
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
