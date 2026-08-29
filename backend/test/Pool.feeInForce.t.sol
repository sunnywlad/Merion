// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from "./PoolTestBase.sol";
import {Pool} from "../contracts/Pool.sol";

// Couche Solidity de feeInForce(), et LA couche qui porte la preuve.
//
// Le probleme, pose franchement. A travers l'ABI seule, aujourd'hui,
// feeInForce() (Pool.sol:134-136) est INDISTINGUABLE d'un
// `return NOMINAL_FEE_NUM` :
//
//   - le seul organe qui ecrive lastSetFeeEpoch APRES le deploiement est
//     setFee, qu'aucun test de ce fichier n'appelle ;
//   - AUDIT F7 : le constructeur pose desormais la sentinelle
//     type(uint32).max, une epoch que l'horloge n'atteindra jamais, donc
//     la comparaison du ternaire est fausse a TOUTES les epochs tant que
//     setFee n'a pas parle. Avant F7, lastSetFeeEpoch valait 0 et la
//     comparaison etait vraie pendant l'epoch 0 — sans rien distinguer
//     pour autant, feeNum y valant exactement NOMINAL_FEE_NUM, pose par
//     le constructeur.
//
// Autrement dit, la branche "mandat courant" du ternaire n'est jamais prise
// avec une valeur qui la distingue de l'autre branche. Une suite qui
// n'appellerait que l'ABI passerait a l'identique sur un contrat dont
// feeInForce() serait une constante gravee : elle ne prouverait rien. C'est
// exactement ce que dit l'entete de test/Pool.feeInForce.test.ts, qui renvoie
// ici.
//
// La route retenue est le forcage d'etat par vm.store, comme dans
// test/Pool.forgedState.t.sol, et pour la meme raison de fond : un etat reel
// du contrat, mais qu'aucune sequence d'appels legitime ne produit encore.
// La route alternative — passer par setFee pour deplacer feeNum — a ete
// refusee deliberement : le setFee onlyOwner d'alors etait condamne, et tout
// test bati dessus serait mort avec lui. Il l'est aujourd'hui, et ce fichier a
// survecu sans une ligne a changer. vm.store ne depend d'aucun organe
// condamne, et cette independance-la reste vraie du setFee gestionnaire.
//
// La technique de recherche du slot est dupliquee depuis
// test/Pool.forgedState.t.sol plutot que partagee (convention du projet, voir
// test/README.md), mais elle est retournee : forgedState RECOMPOSE la valeur
// attendue depuis les getters puis balaye a la recherche de ce mot, ce qui
// suppose la valeur distinctive. Ici elle ne le serait pas — au deploiement le
// mot vaut 5, un entier qu'un autre slot pourrait porter par hasard. On
// balaye donc en ECRIVANT un mot distinctif dans chaque slot candidat, en
// regardant si les DEUX getters basculent ensemble, puis en restaurant. Ce
// balayage-la est deja, en lui-meme, la preuve du packing : si un jour le
// compilateur separait les deux champs, aucune ecriture d'un slot unique ne
// pourrait plus faire basculer les deux a la fois, et _findFeeSlot() sortirait
// en revert au lieu de laisser la regression passer en silence.

abstract contract FeeInForceTestBase is Test, PoolTestBase {

  // Le mot distinctif du balayage. feeNum de sonde deliberement HORS de la
  // bande legitime (37 > MAX_FEE_NUM / UNBALANCE_FACTOR) et different du
  // nominal, epoch de sonde tres au-dela de tout ce que les autres slots
  // peuvent porter : la conjonction des deux rend une collision fortuite avec
  // un autre slot impossible en pratique.
  uint16 internal constant PROBE_FEE_NUM = 37;
  uint32 internal constant PROBE_EPOCH = 123_456;

  // L'encodage annonce par le commentaire de Pool.sol:23-28 : feeNum sur les
  // 16 bits bas, lastSetFeeEpoch sur les 32 bits suivants. C'est la SEULE
  // ligne de ce fichier qui affirme quelque chose sur le layout ; tout le
  // reste s'en deduit, et c'est elle que les tests du contrat
  // FeeInForcePackingTest mettent a l'epreuve. On ne se fie pas au commentaire
  // de Pool.sol : c'est precisement lui qu'on verifie.
  function _pack(uint16 rawFeeNum, uint32 epoch) internal pure returns (bytes32) {
    return bytes32(uint256(rawFeeNum) | (uint256(epoch) << 16));
  }

  // Balaye les vingt premiers slots en ecrivant le mot de sonde dans chacun,
  // et retient celui — s'il existe — pour lequel feeNum() ET
  // lastSetFeeEpoch() basculent TOUS LES DEUX sur les valeurs de sonde. Chaque
  // slot visite est restaure avant de passer au suivant, y compris le bon :
  // cette fonction ne laisse aucune trace dans l'etat du pool.
  function _findFeeSlot() internal returns (bytes32) {
    bytes32 probe = _pack(PROBE_FEE_NUM, PROBE_EPOCH);

    for (uint256 i = 0; i < 20; i++) {
      bytes32 slot = bytes32(i);
      bytes32 original = vm.load(address(pool), slot);

      vm.store(address(pool), slot, probe);
      bool bothMoved = pool.feeNum() == PROBE_FEE_NUM && pool.lastSetFeeEpoch() == PROBE_EPOCH;
      vm.store(address(pool), slot, original);

      if (bothMoved) {
        // AUDIT F7 : au deploiement, `lastSetFeeEpoch` ne vaut plus 0
        // mais la sentinelle `type(uint32).max` ("aucun tarif de mandat
        // jamais pose"). Le zero par defaut etait un numero d'epoch
        // REEL, qui coincidait avec l'epoch 0 et fermait `setFee` a son
        // gestionnaire.
        require(
          pool.feeNum() == uint16(pool.NOMINAL_FEE_NUM()) && pool.lastSetFeeEpoch() == type(uint32).max,
          "sonde: l'etat n'a pas ete restaure apres le balayage"
        );
        return slot;
      }
    }
    revert("slot partage feeNum/lastSetFeeEpoch introuvable dans les slots 0..19");
  }

  // Ecrit le couple (feeNum, lastSetFeeEpoch) d'un seul mot, puis verifie par
  // les getters que l'ecriture a bien atterri. Les require sont des gardes de
  // mise en place, pas des assertions de test : ils font echouer proprement un
  // deplacement de layout au lieu de laisser un test vert sur un etat qui
  // n'est pas celui qu'il croit avoir pose.
  function _forgeFee(bytes32 slot, uint16 rawFeeNum, uint32 epoch) internal {
    vm.store(address(pool), slot, _pack(rawFeeNum, epoch));
    require(pool.feeNum() == rawFeeNum, "forge: feeNum non ecrit");
    require(pool.lastSetFeeEpoch() == epoch, "forge: lastSetFeeEpoch non ecrit");
  }

  // Place block.timestamp au premier instant de l'epoch demandee.
  function _warpToEpoch(uint256 epoch) internal {
    vm.warp(pool.GENESIS() + epoch * pool.EPOCH_DURATION());
  }
}

// ---------------------------------------------------------------------------
// I] Le packing est reel
//
// Trois angles sur une meme affirmation : les deux champs vivent dans le MEME
// slot, feeNum sur les bits bas, lastSetFeeEpoch decale de 16.
// ---------------------------------------------------------------------------

contract FeeInForcePackingTest is FeeInForceTestBase {

  function setUp() public override {
    super.setUp();
  }

  function test_OneSingleSlotWriteMovesFeeNum() public {
    // A) Une seule ecriture, les deux champs bougent
    //
    // _findFeeSlot() a deja restaure le slot : on le re-force ici pour que
    // l'assertion porte sur un etat pose par CE test.
    bytes32 slot = _findFeeSlot();
    _forgeFee(slot, PROBE_FEE_NUM, PROBE_EPOCH);

    assertEq(
      uint256(pool.feeNum()),
      uint256(PROBE_FEE_NUM),
      "une ecriture unique du slot partage doit poser feeNum"
    );
  }

  function test_OneSingleSlotWriteMovesLastSetFeeEpoch() public {
    // Le jumeau du precedent, et c'est la PAIRE qui prouve le partage : la
    // meme et unique ecriture de mot deplace l'autre champ. Si le compilateur
    // separait un jour les deux variables, cette ecriture ne pourrait plus en
    // toucher qu'une.
    bytes32 slot = _findFeeSlot();
    _forgeFee(slot, PROBE_FEE_NUM, PROBE_EPOCH);

    assertEq(
      uint256(pool.lastSetFeeEpoch()),
      uint256(PROBE_EPOCH),
      "la MEME ecriture de mot doit poser lastSetFeeEpoch : c'est le partage de slot"
    );
  }

  function test_BitLayoutIsFeeNumLowAndLastSetFeeEpochShiftedBySixteen() public {
    // B) L'ordre des bits
    //
    // Le test precedent prouverait encore le partage si l'ordre etait inverse,
    // puisque _pack() et les getters se liraient alors de travers ensemble.
    // Ce test-ci lit le mot BRUT au deploiement, sans rien forger : le
    // constructeur pose feeNum = NOMINAL_FEE_NUM et lastSetFeeEpoch =
    // type(uint32).max (sentinelle F7), donc le slot doit valoir
    // exactement `NOMINAL_FEE_NUM | (type(uint32).max << 16)`, et non
    // l'inverse ni rien d'autre. Il fixe du meme coup que RIEN d'autre
    // ne partage ce slot : les 208 bits hauts sont nuls.
    //
    // AUDIT F7 : avant le correctif, `lastSetFeeEpoch` restait a sa
    // valeur par defaut et le mot valait exactement NOMINAL_FEE_NUM. La
    // sentinelle occupe desormais les 32 bits qui suivent, ce qui rend
    // ce test encore plus discriminant sur l'ORDRE des deux champs.
    bytes32 slot = _findFeeSlot();

    uint256 raw = uint256(vm.load(address(pool), slot));

    assertEq(
      raw,
      pool.NOMINAL_FEE_NUM() | (uint256(type(uint32).max) << 16),
      "au deploiement le slot partage doit valoir NOMINAL_FEE_NUM en bits bas et la sentinelle F7 sur les 32 bits suivants, rien d'autre dans le mot"
    );
  }

  function test_ForgedWordReadsBackIdenticalThroughVmLoad() public {
    // C) Aller-retour
    //
    // Ce que vm.store ecrit, vm.load le relit a l'identique : le mot n'est pas
    // recompose ni tronque au passage. C'est ce qui autorise la section III a
    // affirmer que le contenu du slot n'a PAS bouge pendant le rollover, en
    // comparant deux lectures brutes.
    bytes32 slot = _findFeeSlot();
    _forgeFee(slot, PROBE_FEE_NUM, PROBE_EPOCH);

    assertEq(
      vm.load(address(pool), slot),
      _pack(PROBE_FEE_NUM, PROBE_EPOCH),
      "le mot relu doit etre exactement celui qui a ete ecrit"
    );
  }
}

// ---------------------------------------------------------------------------
// II] La branche "mandat courant" rend bien feeNum, et pas le nominal
//
// LE test du fichier. S'il n'y en avait qu'un, ce serait celui-la : il est le
// seul a exhiber un etat ou les deux branches du ternaire de Pool.sol:135
// rendent des valeurs DIFFERENTES, et il montre que c'est la premiere qui est
// prise. Un contrat dont feeInForce() serait `return NOMINAL_FEE_NUM` echoue
// ici, et nulle part ailleurs dans la suite.
// ---------------------------------------------------------------------------

contract FeeInForceCurrentMandateTest is FeeInForceTestBase {

  // Un feeNum de mandat volontairement different du nominal (5) : c'est cet
  // ecart, et lui seul, qui rend l'assertion capable de distinguer les deux
  // branches.
  uint16 internal constant MANDATE_FEE_NUM = 21;
  uint256 internal constant MANDATE_EPOCH = 3;

  bytes32 internal feeSlot;

  function setUp() public override {
    super.setUp();
    feeSlot = _findFeeSlot();

    // A) L'epoch est NON NULLE, deliberement
    //
    // L'epoch 3 est choisie pour que la comparaison ne puisse etre vraie
    // QUE parce que le slot porte reellement 3, et pour rester
    // independante de la valeur initiale de lastSetFeeEpoch. Avant
    // l'AUDIT F7 cette precaution etait indispensable : lastSetFeeEpoch
    // valait 0 au deploiement, donc a l'epoch 0 la comparaison etait vraie
    // sans rien forger et le test serait passe sur un contrat ou
    // lastSetFeeEpoch n'aurait jamais ete ecrit. Depuis F7 la sentinelle
    // type(uint32).max ferme ce faux positif a la source ; on garde
    // l'epoch 3, qui prouve la meme chose sans dependre de la sentinelle.
    _warpToEpoch(MANDATE_EPOCH);
    _forgeFee(feeSlot, MANDATE_FEE_NUM, uint32(MANDATE_EPOCH));
  }

  function test_ForgedEpochMatchesCurrentEpoch() public view {
    // Prealable rendu explicite : la mise en place a bien produit l'egalite
    // dont depend le test suivant. Sans lui, un decalage de _warpToEpoch
    // ferait passer le test principal par la MAUVAISE branche, en vert.
    assertEq(
      uint256(pool.lastSetFeeEpoch()),
      pool.currentEpoch(),
      "la mise en place doit poser lastSetFeeEpoch egal a currentEpoch()"
    );
  }

  function test_FeeInForceReturnsTheForgedFeeNumDuringItsOwnEpoch() public view {
    assertEq(
      pool.feeInForce(),
      uint256(MANDATE_FEE_NUM),
      "feeInForce() doit rendre le feeNum du mandat courant, pas le nominal"
    );
  }

  function test_FeeInForceDiffersFromNominalDuringItsOwnEpoch() public view {
    // Le meme fait dit par la negative, et c'est celui qui a une valeur de
    // preuve : la vue rend AUTRE CHOSE que NOMINAL_FEE_NUM. Aucune constante
    // gravee ne peut satisfaire a la fois cette assertion et celles des
    // sections III a VI.
    assertNotEq(
      pool.feeInForce(),
      pool.NOMINAL_FEE_NUM(),
      "feeInForce() ne peut pas etre une constante : ici elle doit differer de NOMINAL_FEE_NUM"
    );
  }
}

// ---------------------------------------------------------------------------
// III] Le rollover est gratuit
//
// Depuis l'etat de la section II, le temps avance d'exactement une epoch et
// AUCUNE transaction n'est envoyee : vm.warp est un cheatcode, pas un appel.
// La vue rebascule seule sur le nominal, alors que le slot n'a pas bouge d'un
// bit. C'est toute la raison d'etre du reset paresseux : personne n'a a payer
// le gas d'une remise a zero au passage d'epoch.
// ---------------------------------------------------------------------------

contract FeeInForceRolloverTest is FeeInForceTestBase {

  uint16 internal constant MANDATE_FEE_NUM = 21;
  uint256 internal constant MANDATE_EPOCH = 3;

  bytes32 internal feeSlot;

  function setUp() public override {
    super.setUp();
    feeSlot = _findFeeSlot();
    _warpToEpoch(MANDATE_EPOCH);
    _forgeFee(feeSlot, MANDATE_FEE_NUM, uint32(MANDATE_EPOCH));

    // Une epoch pleine plus tard, sans le moindre appel entre les deux.
    vm.warp(block.timestamp + pool.EPOCH_DURATION());
  }

  function test_FeeInForceFallsBackToNominalAfterTheRollover() public view {
    assertEq(
      pool.feeInForce(),
      pool.NOMINAL_FEE_NUM(),
      "une epoch plus tard, sans aucune transaction, feeInForce() doit rendre NOMINAL_FEE_NUM"
    );
  }

  function test_RawFeeNumIsUnchangedByTheRollover() public view {
    assertEq(
      uint256(pool.feeNum()),
      uint256(MANDATE_FEE_NUM),
      "le feeNum BRUT ne bouge pas au passage d'epoch : rien ne l'a reecrit"
    );
  }

  function test_LastSetFeeEpochIsUnchangedByTheRollover() public view {
    assertEq(
      uint256(pool.lastSetFeeEpoch()),
      MANDATE_EPOCH,
      "lastSetFeeEpoch reste sur l'epoch perimee : c'est la comparaison qui bascule, pas le stockage"
    );
  }

  function test_TheWholeSlotIsUntouchedByTheRollover() public view {
    // Les deux tests precedents, dits en un seul mot de 32 octets. Il ajoute
    // ceci : ce ne sont pas seulement les deux champs qui sont intacts, c'est
    // le SLOT entier, donc aucune ecriture clandestine n'a eu lieu la. C'est
    // la formulation exacte de "le rollover est gratuit" : zero SSTORE.
    assertEq(
      vm.load(address(pool), feeSlot),
      _pack(MANDATE_FEE_NUM, uint32(MANDATE_EPOCH)),
      "le slot partage doit etre bit pour bit identique apres le passage d'epoch"
    );
  }
}

// ---------------------------------------------------------------------------
// IV] La frontiere a la seconde
//
// Meme logique que la section II de test/Pool.currentEpoch.test.ts, mais sur
// la vue plutot que sur l'horloge : le mandat de frais expire a la SECONDE ou
// currentEpoch() change, ni avant ni apres. Le mandat est forge sur l'epoch 3,
// et la frontiere observee est celle qui ouvre l'epoch 4.
// ---------------------------------------------------------------------------

contract FeeInForceBoundaryTest is FeeInForceTestBase {

  uint16 internal constant MANDATE_FEE_NUM = 21;
  uint256 internal constant MANDATE_EPOCH = 3;

  bytes32 internal feeSlot;

  function setUp() public override {
    super.setUp();
    feeSlot = _findFeeSlot();
    _warpToEpoch(MANDATE_EPOCH);
    _forgeFee(feeSlot, MANDATE_FEE_NUM, uint32(MANDATE_EPOCH));
  }

  function test_FeeInForceStillReturnsFeeNumOnTheLastSecondOfItsEpoch() public {
    // GENESIS + 4 * EPOCH_DURATION - 1 : la toute derniere seconde du mandat.
    // currentEpoch() y vaut encore 3 (division entiere, (4 * 14400 - 1) /
    // 14400 = 3), donc la comparaison tient encore.
    vm.warp(pool.GENESIS() + (MANDATE_EPOCH + 1) * pool.EPOCH_DURATION() - 1);

    assertEq(
      pool.feeInForce(),
      uint256(MANDATE_FEE_NUM),
      "a la derniere seconde de son epoch, le mandat de frais est encore en vigueur"
    );
  }

  function test_FeeInForceReturnsNominalOnTheFirstSecondOfTheNextEpoch() public {
    // Une seconde plus tard, et rien d'autre n'a change. La borne est donc
    // inclusive cote epoch suivante, exactement comme celle de currentEpoch().
    vm.warp(pool.GENESIS() + (MANDATE_EPOCH + 1) * pool.EPOCH_DURATION());

    assertEq(
      pool.feeInForce(),
      pool.NOMINAL_FEE_NUM(),
      "a la premiere seconde de l'epoch suivante, le mandat est perime et la vue rend le nominal"
    );
  }
}

// ---------------------------------------------------------------------------
// V] Fuzz
//
// Les sections precedentes epinglent des points choisis ; celle-ci balaye le
// domaine. Deux moities, ecrites separement parce qu'elles repondent a deux
// questions : hors de son epoch un mandat n'existe pas, quel que soit son
// contenu ; dans son epoch il s'impose, quel que soit son contenu.
// ---------------------------------------------------------------------------

contract FeeInForceFuzzTest is FeeInForceTestBase {

  // Borne haute des sauts de temps fuzzes : mille epochs, soit environ 166
  // jours a 4 h l'epoch. Assez large pour que currentEpoch() prenne beaucoup
  // de valeurs distinctes, assez etroit pour que la borne uint32 de
  // lastSetFeeEpoch reste hors de portee, ce qui est le sujet de la section VI
  // et pas de celle-ci.
  uint256 internal constant MAX_FUZZED_EPOCHS = 1000;

  bytes32 internal feeSlot;

  function setUp() public override {
    super.setUp();
    feeSlot = _findFeeSlot();
  }

  function test_FuzzFeeInForceIsNominalWheneverTheForgedEpochHasPassed(
    uint256 rawFeeNum,
    uint256 forgedEpoch,
    uint256 elapsedEpochs
  ) public {
    rawFeeNum = bound(rawFeeNum, 0, pool.MAX_FEE_NUM());
    // Le mandat forge doit DIRE quelque chose : s'il portait deja le nominal,
    // l'assertion serait vraie par les deux branches a la fois et ne
    // distinguerait rien.
    vm.assume(rawFeeNum != pool.NOMINAL_FEE_NUM());

    elapsedEpochs = bound(elapsedEpochs, 0, MAX_FUZZED_EPOCHS);
    _warpToEpoch(elapsedEpochs);

    forgedEpoch = bound(forgedEpoch, 0, type(uint32).max);
    vm.assume(forgedEpoch != pool.currentEpoch());

    _forgeFee(feeSlot, uint16(rawFeeNum), uint32(forgedEpoch));

    assertEq(
      pool.feeInForce(),
      pool.NOMINAL_FEE_NUM(),
      "hors de son epoch, un mandat de frais ne vaut rien : la vue rend le nominal"
    );
  }

  function test_FuzzFeeInForceIsTheForgedFeeNumWheneverTheEpochMatches(
    uint256 rawFeeNum,
    uint256 elapsedEpochs
  ) public {
    rawFeeNum = bound(rawFeeNum, 0, pool.MAX_FEE_NUM());
    vm.assume(rawFeeNum != pool.NOMINAL_FEE_NUM());

    elapsedEpochs = bound(elapsedEpochs, 0, MAX_FUZZED_EPOCHS);
    _warpToEpoch(elapsedEpochs);
    _forgeFee(feeSlot, uint16(rawFeeNum), uint32(elapsedEpochs));

    assertEq(
      pool.feeInForce(),
      rawFeeNum,
      "dans son epoch, le mandat s'impose quel que soit son contenu"
    );
  }
}

// ---------------------------------------------------------------------------
// VI] Les bornes du typage
//
// lastSetFeeEpoch est un uint32 (Pool.sol:33). Deux questions distinctes se
// posent a son plafond, et une seule est testable.
//
// Testee ici : forge a type(uint32).max, la vue reste coherente des deux
// cotes. Elle rend le nominal tant que currentEpoch() est en dessous, et rend
// bien feeNum quand les deux coincident, ce dernier cas etant atteignable par
// vm.warp puisque GENESIS + 4 294 967 295 * 14 400 tient tres largement dans
// un uint256.
//
// NON testee, deliberement : le cas ou currentEpoch() DEPASSE type(uint32).max.
// Il exigerait un block.timestamp au-dela de 6,18e13 secondes depuis GENESIS,
// soit environ 1,96 million d'annees ; aucun vm.warp raisonnable ne l'atteint,
// et surtout il ne changerait rien. La comparaison de Pool.sol:135 promeut le
// uint32 en uint256 avant de comparer : au-dela du plafond, lastSetFeeEpoch ne
// peut simplement plus jamais egaler currentEpoch(), la vue se fige sur
// NOMINAL_FEE_NUM et il n'y a ni repli ni collision d'epochs. Aucun test
// n'existe donc ici, ce commentaire tient sa place.
// ---------------------------------------------------------------------------

contract FeeInForceUint32BoundTest is FeeInForceTestBase {

  uint16 internal constant MANDATE_FEE_NUM = 21;

  bytes32 internal feeSlot;

  function setUp() public override {
    super.setUp();
    feeSlot = _findFeeSlot();
    _forgeFee(feeSlot, MANDATE_FEE_NUM, type(uint32).max);
  }

  function test_FeeInForceIsNominalWhileCurrentEpochIsBelowTheUint32Ceiling() public {
    // Deuxieme epoch, donc tres loin sous le plafond : le mandat forge est
    // dans un futur inatteignable, la vue l'ignore.
    _warpToEpoch(2);

    assertEq(
      pool.feeInForce(),
      pool.NOMINAL_FEE_NUM(),
      "un mandat forge au plafond uint32 reste sans effet tant que currentEpoch() ne l'a pas rejoint"
    );
  }

  function test_FeeInForceReturnsFeeNumWhenCurrentEpochReachesTheUint32Ceiling() public {
    // currentEpoch() amene exactement sur type(uint32).max. Rien ne casse au
    // plafond du type : la comparaison redevient vraie et la branche du mandat
    // est prise comme partout ailleurs.
    _warpToEpoch(uint256(type(uint32).max));

    assertEq(
      pool.feeInForce(),
      uint256(MANDATE_FEE_NUM),
      "au plafond uint32, la vue rend le feeNum du mandat comme a n'importe quelle epoch"
    );
  }
}
