// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from "./PoolTestBase.sol";
import {Pool} from "../contracts/Pool.sol";
import {MRN} from "../contracts/MRN.sol";
import {MockReentrantBTC} from "../contracts/MockReentrantBTC.sol";

// Suite de non-regression des quatre failles d'audit portees par
// Pool.sol qui ne demandent pas d'orchestration multi-comptes : F5 (la
// rente en cours brulee dans l'adresse morte), F6 (l'owner preempte tous
// les mandats), F7 (`setFee` inaccessible pendant l'epoch 0), F8
// (amorcage sans garde d'overflow uint72).
//
// Pourquoi du Solidity et pas du TypeScript, ici. Les quatre se
// formulent en TEMPS et en ETAT INTERNE, jamais en parcours utilisateur.
// F5 exige de vider le pool AU MILIEU d'un flux de rente et de tenir
// l'horloge a la seconde pour comparer un report au wei pres. F7 exige
// d'atteindre un etat que le contrat rend structurellement inatteignable
// par ses propres entrees — `managerOf[0]` ne peut PAS etre ecrit par
// `setManager`, dont la garde est `_epoch > currentEpoch()` — et seul
// `vm.store` y donne acces. F8 exige un depot au-dela de 2^72 - 1, hors
// de portee du plafond 21M de `MockWrappedBTC`. F6 est le seul des
// quatre qui aurait pu vivre en TypeScript ; il reste ici pour tenir les
// quatre gardes dans un seul fichier lisible d'affilee. Le parcours
// reseau de la rente et des frais reste couvert par
// test/Pool.rent.test.ts et test/Pool.setFee.test.ts, conformement au
// partage decrit dans test/README.md.
//
// Chaque test est en deux temps : le commentaire decrit l'attaque TELLE
// QU'ELLE REUSSISSAIT avant le correctif, et l'assertion epingle ce que
// le contrat fait desormais.

// ---------------------------------------------------------------------------
// F5 — La rente en cours brulee dans l'adresse morte
//
// L'attaque telle qu'elle reussissait : si tous les LP sortent pendant un
// flux, `totalSupply()` retombe a `MINIMUM_LIQUIDITY`, les 1000 parts de
// l'adresse morte, qui ne reclamera jamais rien. Le temps passait.
// `_updateRent` avancait quand meme `accPerShare` de `dt * rentRate /
// totalSupply` : toute la queue du flux etait attribuee a l'adresse
// morte, donc perdue pour de bon. Le garde-fou `rentLeftOver` ne
// couvrait que le cas ou `notifyRent` arrive sur un pool DEJA vide, pas
// celui ou le pool se vide PENDANT le flux. Aucune malveillance n'etait
// requise : il suffisait que les LP sortent tous, ce que le protocole
// leur garantit de pouvoir faire a tout instant, meme en pause.
// ---------------------------------------------------------------------------

contract PoolRentLeftOverOnEmptyPoolTest is Test, PoolTestBase {

  uint256 internal constant SEED = 100e8;
  uint256 internal constant EPOCH = 14400;
  uint256 internal constant RENT = 14400e18; // rentRate tombe sur 1e36 pile
  uint256 internal constant SCALE = 1e18;

  address internal constant LP2 = address(0xB0B2);

  // Instant de la sortie totale des LP, et instant du reveil. La tranche
  // [exitTs, wakeTs] est celle qui etait perdue.
  uint256 internal exitTs;
  uint256 internal wakeTs;

  function setUp() public override {
    super.setUp();
    pool.setAuction(address(this)); // le test joue l'enchere
    pool.addLiquidity(0, SEED, 0);  // address(this) devient l'unique LP
  }

  function _notify(uint256 amount) internal {
    mrn.approve(address(pool), amount);
    pool.notifyRent(amount);
  }

  // Touche minimale qui declenche `_updateRent` sans bouger totalSupply :
  // un transfert de zero vers soi-meme. C'est la meme convention que
  // test/Pool.rent.t.sol.
  function _touch() internal {
    pool.transfer(address(this), 0);
  }

  // Amorce le flux, laisse courir un quart d'epoch, fait sortir l'unique
  // LP, puis laisse courir un quart d'epoch de plus sur un pool ou seule
  // l'adresse morte detient des parts.
  function _emptyThePoolMidStream() internal {
    _notify(RENT);
    uint256 start = pool.rentLastUpdate();

    exitTs = start + EPOCH / 4;
    vm.warp(exitTs);
    uint256[3] memory minOut;
    pool.removeLiquidity(pool.balanceOf(address(this)), minOut);

    wakeTs = start + EPOCH / 2;
    vm.warp(wakeTs);
  }

  function test_FixtureLeavesOnlyTheDeadAddressHoldingShares() public {
    // Prealable rendu explicite : sans lui, les tests suivants
    // passeraient sur un pool encore peuple et n'etabliraient rien.
    _emptyThePoolMidStream();

    assertEq(
      pool.totalSupply(),
      pool.MINIMUM_LIQUIDITY(),
      "fixture : apres la sortie totale, seules les 1000 parts de l'adresse morte doivent rester"
    );
  }

  function test_AccPerShareDoesNotAdvanceWhileOnlyTheDeadAddressHoldsShares() public {
    // LA verite de F5. Avant, cette valeur montait de `dt * rentRate /
    // 1000`, et chaque unite gagnee etait une unite due a une adresse
    // qui ne reclamera jamais.
    _emptyThePoolMidStream();
    uint256 accAtExit = pool.accPerShare();

    _touch(); // declenche `_updateRent` sur le pool vide

    assertEq(
      pool.accPerShare(),
      accAtExit,
      "F5 : l'accumulateur ne doit pas avancer quand seule l'adresse morte detient des parts"
    );
  }

  function test_TheRentOfTheEmptyPeriodIsParkedInRentLeftOver() public {
    // L'autre moitie de F5 : la rente n'est pas seulement soustraite a
    // l'adresse morte, elle est CONSERVEE. Un correctif qui se
    // contenterait de figer `accPerShare` sans reporter la tranche
    // perdrait exactement le meme MRN, plus discretement.
    _emptyThePoolMidStream();
    uint256 rate = pool.rentRate();

    _touch();

    assertEq(
      pool.rentLeftOver(),
      (wakeTs - exitTs) * rate / SCALE,
      "F5 : la tranche ecoulee sur un pool vide doit etre reportee dans rentLeftOver, au wei pres"
    );
  }

  function test_RentLastUpdateIsRecalibratedSoTheTrancheIsCountedOnce() public {
    // Le piege du report : si `rentLastUpdate` n'avancait pas, la meme
    // tranche serait re-reportee a chaque touche et `rentLeftOver`
    // gonflerait sans contrepartie.
    _emptyThePoolMidStream();
    _touch();
    uint256 parkedOnce = pool.rentLeftOver();

    _touch(); // seconde touche, au MEME instant

    assertEq(
      pool.rentLeftOver(),
      parkedOnce,
      "F5 : une seconde touche au meme instant ne doit rien reporter de plus"
    );
  }

  function test_ClaimableAgreesWithTheWritingPathOnAnEmptyPool() public {
    // Le piege signale par l'audit : `_accProjected` est partagee entre
    // `claimable()` et le chemin ecrivain. Si la condition F5 n'etait
    // posee que du cote ecrivain, la vue promettrait a l'adresse morte
    // une rente que `claimRent` ne payerait jamais. On interroge donc
    // la vue sur l'adresse morte elle-meme, le seul porteur restant.
    //
    // L'assertion se prend sur l'accumulateur ECRIT, pas sur une seconde
    // lecture de la vue. Comparer `claimable()` avant et apres une touche
    // ne discriminerait RIEN : sur le contrat non corrige, la touche fait
    // avancer `accPerShare` jusqu'a la valeur que la vue projetait deja,
    // et les deux lectures coincideraient tout autant. Ce qui separe les
    // deux contrats, c'est l'ecart entre la PROJECTION et l'etat ecrit
    // apres un quart d'epoch ecoule a vide : nul ici, strictement positif
    // avant le correctif.
    _emptyThePoolMidStream();
    address dead = 0x000000000000000000000000000000000000dEaD;

    assertEq(
      pool.claimable(dead),
      pool.balanceOf(dead) * pool.accPerShare() / SCALE,
      "F5 : claimable() ne doit rien projeter au-dela de l'accumulateur ecrit quand seule l'adresse morte detient des parts"
    );
  }

  function test_TheParkedRentIsFoldedIntoTheNextStream() public {
    // La finalite du report : la rente rejoint le flux suivant et
    // retombe sur de vrais LP. Sans cette derniere marche, `rentLeftOver`
    // serait un cimetiere plutot qu'une salle d'attente.
    _emptyThePoolMidStream();
    _touch();
    uint256 parked = pool.rentLeftOver();
    assertGt(parked, 0, "fixture : la tranche reportee doit etre non nulle");

    // Un LP revient, puis l'enchere notifie un nouveau flux.
    wbtc.transfer(LP2, SEED);
    cbbtc.transfer(LP2, SEED);
    lbtc.transfer(LP2, SEED);
    vm.startPrank(LP2);
    wbtc.approve(address(pool), SEED);
    cbbtc.approve(address(pool), SEED);
    lbtc.approve(address(pool), SEED);
    pool.addLiquidity(0, SEED, 0);
    vm.stopPrank();

    uint256 leftOverBeforeNotify = pool.rentLeftOver();
    uint256 tailBeforeNotify = pool.rentRate() * (pool.rentEnd() - block.timestamp) / SCALE;
    _notify(RENT);

    assertEq(
      pool.rentRate(),
      (RENT + leftOverBeforeNotify + tailBeforeNotify) * SCALE / EPOCH,
      "F5 : le nouveau taux doit inclure la tranche reportee, sinon le report ne sert a rien"
    );
  }
}

// ---------------------------------------------------------------------------
// F6 — L'owner peut preempter tous les mandats
//
// L'attaque telle qu'elle reussissait : tant que `auction` vaut
// `address(0)`, l'owner pouvait nommer un gestionnaire pour N'IMPORTE
// QUELLE epoch future, autant de fois qu'il voulait, et `managerOf` n'est
// jamais reecrivable. Un owner malveillant reservait les N prochains
// mandats avant de brancher l'enchere ; chaque reglement de ces epochs
// heurtait ensuite `ManagerAlreadySet` a l'interieur de `_settle`, ce qui
// rejouait exactement la brique de F1 avec un autre declencheur.
// ---------------------------------------------------------------------------

contract PoolOwnerEpochBoundTest is Test, PoolTestBase {

  address internal constant SQUATTER = address(uint160(0x5A11));

  function test_OwnerCannotNominateBeyondTheNextEpoch() public {
    // Le squat, joue tel quel : l'owner vise l'epoch 2 alors que
    // l'epoch courante est 0. L'erreur porte le plafond, pour que
    // l'appelant sache ou s'arreter sans relire le contrat.
    vm.expectRevert(abi.encodeWithSelector(Pool.OwnerEpochTooFar.selector, uint256(1)));
    pool.setManager(2, SQUATTER);
  }

  function test_OwnerCannotReserveAFarAwayMandate() public {
    // La forme longue de la meme attaque, celle du script d'attaque :
    // dix mandats d'avance. La garde ne depend pas de la distance.
    vm.expectRevert(abi.encodeWithSelector(Pool.OwnerEpochTooFar.selector, uint256(1)));
    pool.setManager(10, SQUATTER);
  }

  function test_OwnerCanStillNominateTheNextEpoch() public {
    // La contrepartie, sans laquelle la garde fermerait l'amorcage : la
    // voie owner reste ouverte sur l'epoch suivante, la seule dont
    // l'enchere n'a pas encore eu le temps de s'occuper.
    pool.setManager(1, SQUATTER);

    assertEq(
      pool.managerOf(1),
      SQUATTER,
      "F6 : la voie d'amorcage doit rester ouverte sur currentEpoch() + 1"
    );
  }

  function test_TheOwnerBoundMovesWithTheClockNotWithTheCaller() public {
    // Ce que la garde coute reellement a l'owner : une epoch de temps
    // reel par mandat. Le plafond suit l'horloge, il ne se negocie pas.
    vm.warp(pool.GENESIS() + 9 * pool.EPOCH_DURATION());
    pool.setManager(10, SQUATTER);

    assertEq(
      pool.managerOf(10),
      SQUATTER,
      "F6 : l'epoch 10 devient nommable une fois l'epoch 9 commencee, pas avant"
    );
  }

  function test_TheAuctionPathIsNotBoundByF6() public {
    // La garde ne vise QUE la voie d'amorcage. L'enchere, elle, ne
    // derive `pendingEpoch` que de son propre `sellingEpoch`, toujours
    // egal a `currentEpoch() + 1` : lui imposer un second plafond
    // creerait une deuxieme horloge a garder synchronisee. Ici
    // `address(this)` est branche comme enchere et vise l'epoch 5.
    pool.setAuction(address(this));
    pool.setManager(5, SQUATTER);

    assertEq(
      pool.managerOf(5),
      SQUATTER,
      "F6 : la voie enchere n'est pas bornee, la garde ne vise que l'amorcage owner"
    );
  }
}

// ---------------------------------------------------------------------------
// F7 — `setFee` inaccessible pendant l'epoch 0
//
// L'attaque telle qu'elle reussissait — ce n'en est pas une, c'est un
// deni de service contre le protocole lui-meme : `lastSetFeeEpoch` valait
// 0 a l'initialisation et `currentEpoch()` vaut 0 pendant la premiere
// epoch. La garde `require(lastSetFeeEpoch != epoch,
// FeeAlreadySetThisEpoch())` etait donc FAUSSE d'emblee, et le
// gestionnaire de l'epoch 0 recevait `FeeAlreadySetThisEpoch` sans avoir
// rien ecrit. Symetriquement, `feeInForce()` prenait la branche du
// mandat pendant toute l'epoch 0, sur une valeur que personne n'avait
// choisie.
//
// L'etat teste ici — `managerOf[0]` non nul — est STRUCTURELLEMENT
// inatteignable par les entrees du contrat : `setManager` exige `_epoch >
// currentEpoch()`, donc l'epoch 0 n'aura jamais de gestionnaire elu. Il
// est pose par `vm.store`, et le slot est trouve par balayage plutot
// qu'en codant en dur un numero que le moindre reordonnancement de
// champs invaliderait en silence. C'est la meme demarche que le
// `_findFeeSlot()` de test/Pool.feeInForce.t.sol.
// ---------------------------------------------------------------------------

contract PoolFirstEpochFeeTest is Test, PoolTestBase {

  address internal constant MANAGER = address(uint160(0xA11CE));
  uint256 internal constant MANDATE_FEE_NUM = 3; // dans la bande, != nominal (5)

  // Balaye les trente premiers slots a la recherche du mapping
  // `managerOf`, et y ecrit MANAGER pour l'epoch 0. Un mapping declare au
  // slot `s` range sa cle `k` en `keccak256(abi.encode(k, s))`. Chaque
  // slot visite est restaure avant de passer au suivant, sauf le bon.
  function _forgeManagerOfEpochZero() internal {
    for (uint256 s = 0; s < 30; s++) {
      bytes32 entry = keccak256(abi.encode(uint256(0), s));
      bytes32 original = vm.load(address(pool), entry);
      vm.store(address(pool), entry, bytes32(uint256(uint160(MANAGER))));
      if (pool.managerOf(0) == MANAGER) return;
      vm.store(address(pool), entry, original);
    }
    revert("sonde: mapping managerOf introuvable dans les slots 0..29");
  }

  function test_LastSetFeeEpochIsSeededToTheNeverSetSentinel() public view {
    // La correction, lue directement. Le zero par defaut etait un numero
    // d'epoch REEL, et c'est tout le probleme : une sentinelle doit etre
    // hors du domaine qu'elle sentinelle.
    assertEq(
      uint256(pool.lastSetFeeEpoch()),
      uint256(type(uint32).max),
      "F7 : le constructeur doit poser la sentinelle 'aucun tarif de mandat jamais pose'"
    );
  }

  function test_TheSentinelDoesNotCollideWithTheFirstEpoch() public view {
    // La propriete qui compte, dite sans reference a la valeur choisie :
    // un contrat qui remplacerait la sentinelle par une autre valeur
    // hors domaine passerait encore ici, et c'est voulu.
    assertTrue(
      uint256(pool.lastSetFeeEpoch()) != pool.currentEpoch(),
      "F7 : la sentinelle ne doit pas coincider avec l'epoch courante au deploiement"
    );
  }

  function test_TheFirstEpochManagerCanSetTheFee() public {
    // LA verite de F7, jouee sur l'etat que le contrat ne sait pas
    // produire lui-meme. Avant, cet appel revertait
    // `FeeAlreadySetThisEpoch` sans qu'aucun tarif n'ait ete ecrit.
    _forgeManagerOfEpochZero();
    vm.warp(pool.GENESIS() + 1); // offset 1 s, sous PRIORITY_WINDOW (12 s)

    vm.prank(MANAGER);
    pool.setFee(MANDATE_FEE_NUM);

    assertEq(
      pool.feeInForce(),
      MANDATE_FEE_NUM,
      "F7 : le gestionnaire de l'epoch 0 doit pouvoir poser son tarif une fois"
    );
  }

  function test_TheUnicityGuardStillClosesAfterTheFirstWrite() public {
    // La contrepartie : la sentinelle ouvre la porte UNE fois, elle ne
    // la desactive pas. Un correctif qui aurait simplement retire la
    // garde passerait le test precedent et echouerait celui-ci.
    _forgeManagerOfEpochZero();
    vm.warp(pool.GENESIS() + 1);
    vm.prank(MANAGER);
    pool.setFee(MANDATE_FEE_NUM);

    vm.warp(pool.GENESIS() + 2);
    vm.expectRevert(Pool.FeeAlreadySetThisEpoch.selector);
    vm.prank(MANAGER);
    pool.setFee(MANDATE_FEE_NUM + 1);
  }

  function test_FeeInForceIsNominalDuringTheFirstEpochBeforeAnySetFee() public view {
    // L'autre lecteur de `lastSetFeeEpoch`. Avant, la comparaison etait
    // vraie a l'epoch 0 et la vue prenait la branche du mandat ; le
    // chiffre coincidait par accident, parce que le constructeur pose
    // `feeNum = NOMINAL_FEE_NUM`. La sentinelle rend le repli explicite.
    assertEq(
      pool.feeInForce(),
      pool.NOMINAL_FEE_NUM(),
      "F7 : sans tarif de mandat, la vue doit prendre la branche nominale des l'epoch 0"
    );
  }
}

// ---------------------------------------------------------------------------
// F8 — Amorcage sans garde d'overflow uint72
//
// L'attaque telle qu'elle reussissait — inatteignable avec le panier
// actuel, et c'est precisement le point : la branche `supply == 0`
// d'`addLiquidity` faisait `_setReserves(uint72(amounts[0]), ...)` sans
// le `require(... <= type(uint72).max, ReserveOverflow())` que la branche
// normale applique. Un depot au-dela de 2^72 - 1 aurait donc ete tronque
// EN SILENCE : le deposant recevait `3 * _amount - MINIMUM_LIQUIDITY`
// parts sur un pool dont les reserves n'enregistraient que le reste
// modulo 2^72. Le plafond de 21M de WBTC/cbBTC/LBTC le rendait
// inatteignable, mais c'etait une dependance implicite au JETON, pas une
// invariante du POOL.
//
// La demonstration exige un jeton 8 decimales SANS plafond :
// `MockWrappedBTC` s'arrete a 21M (2,1e15), tres en dessous de 2^72
// (4,7e21). `MockReentrantBTC` n'a pas de cap et satisfait les gardes du
// constructeur du Pool (trois adresses distinctes, non nulles, 8
// decimales, distinctes de MRN).
// ---------------------------------------------------------------------------

contract PoolBootstrapOverflowTest is Test {

  MockReentrantBTC internal t0;
  MockReentrantBTC internal t1;
  MockReentrantBTC internal t2;
  MRN internal mrn;
  Pool internal pool;

  uint256 internal constant OVER_UINT72 = uint256(type(uint72).max) + 1;

  function setUp() public {
    t0 = new MockReentrantBTC("Uncapped BTC 0", "uBTC0");
    t1 = new MockReentrantBTC("Uncapped BTC 1", "uBTC1");
    t2 = new MockReentrantBTC("Uncapped BTC 2", "uBTC2");
    mrn = new MRN();

    address[3] memory tokens = [address(t0), address(t1), address(t2)];
    pool = new Pool(tokens, 14400, 12, 1, 5, address(0xBEEF), address(mrn), address(this));

    t0.mint(address(this), OVER_UINT72);
    t1.mint(address(this), OVER_UINT72);
    t2.mint(address(this), OVER_UINT72);
    t0.approve(address(pool), type(uint256).max);
    t1.approve(address(pool), type(uint256).max);
    t2.approve(address(pool), type(uint256).max);
  }

  function test_BootstrapAboveTheUint72CeilingRevertsReserveOverflow() public {
    // Le depot qui debordait en silence. La garde parle desormais, avec
    // la MEME erreur que la branche normale : un appelant n'a pas a
    // savoir par quelle branche il est passe.
    vm.expectRevert(Pool.ReserveOverflow.selector);
    pool.addLiquidity(0, OVER_UINT72, 0);
  }

  function test_BootstrapAtTheUint72CeilingIsStillAccepted() public {
    // La frontiere, cote ouvert. Une garde ecrite en `<` au lieu de
    // `<=` passerait le test precedent et fermerait a tort le plus gros
    // depot representable.
    pool.addLiquidity(0, uint256(type(uint72).max), 0);

    assertEq(
      uint256(pool.reserves(0)),
      uint256(type(uint72).max),
      "F8 : le plafond exact doit rester deposable, la garde borne, elle n'ampute pas"
    );
  }
}
