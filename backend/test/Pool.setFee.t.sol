// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from "./PoolTestBase.sol";
import {Pool} from "../contracts/Pool.sol";

// Couche Solidity de setFee, et la seule qui reponde a "pour N'IMPORTE QUELLE
// entree".
//
// setFee (Pool.sol:152-175) est une fonction a quatre gardes et trois
// parametres implicites : QUI appelle, QUAND il appelle, et AVEC QUOI. La
// couche TypeScript (test/Pool.setFee.test.ts) epingle des points choisis sur
// chacun de ces trois axes — le gestionnaire nominal, la seconde exacte de la
// frontiere, les deux bornes de la bande — parce que c'est le parcours reel
// qu'elle interroge. Elle ne peut pas balayer un domaine : chaque tirage y
// couterait une transaction et un aller-retour RPC.
//
// Ce fichier balaye. Cinq axes, un par contrat, et chacun formule une
// EQUIVALENCE plutot qu'un exemple :
//
//   I]   la bande accepte tout ce qui est dedans, exactement ;
//   II]  elle refuse tout ce qui est dehors, des deux cotes ;
//   III] la garde d'acces refuse toute adresse qui n'est pas le gestionnaire
//        du mandat courant ;
//   IV]  la fenetre laisse passer si et seulement si l'offset dans l'epoch est
//        strictement inferieur a PRIORITY_WINDOW ;
//   V]   le mecanisme entier ne tient a aucune epoch particuliere.
//
// Le piege du domaine vide est traite explicitement partout : un fuzz dont le
// `bound` produit un intervalle vide passe en vert sans rien eprouver. Sous
// MIN_FEE_NUM il n'y a qu'une seule valeur (zero, MIN_FEE_NUM valant 1 sur
// cette fixture), donc ce cas-la est ecrit SANS fuzz, en dur — voir la section
// II.
//
// Voir test/README.md pour la demarche complete et la liste des cas limites
// groupee par fonction.

abstract contract SetFeeTestBase is Test, PoolTestBase {

  // Le gestionnaire des mandats de ce fichier. Une adresse posee, distincte
  // d'address(this) : le contrat de test est l'owner du pool, et confondre les
  // deux roles ferait passer la garde d'acces pour la mauvaise raison.
  address internal constant MANAGER = address(uint160(0xA11CE));

  // La premiere epoch qu'un gestionnaire puisse recevoir. setManager exige
  // `_epoch > currentEpoch()` (Pool.sol:129) et currentEpoch() vaut 0 au sortir
  // de setUp : 1 est donc le plus petit mandat attribuable, et l'epoch 0 n'en
  // aura jamais aucun.
  uint256 internal constant FIRST_MANDATE = 1;

  // Place block.timestamp a `offset` secondes du debut de `epoch`. C'est la
  // seule facon de viser la fenetre de priorite sans deriver : elle vaut douze
  // secondes, et un saut relatif accumulerait les secondes consommees par les
  // appels precedents.
  function _warpTo(uint256 epoch, uint256 offset) internal {
    vm.warp(pool.GENESIS() + epoch * pool.EPOCH_DURATION() + offset);
  }

  // Le plafond du gestionnaire, derive comme le contrat le derive
  // (Pool.sol:166) : MAX_FEE_NUM / UNBALANCE_FACTOR, soit 25 sur cette
  // fixture. Jamais MAX_FEE_NUM, qui est le plafond de ce qu'un PRENEUR peut
  // payer, pas de ce qu'un gestionnaire peut ecrire.
  function _maxManagerFeeNum() internal view returns (uint256) {
    return pool.MAX_FEE_NUM() / pool.UNBALANCE_FACTOR();
  }

  // L'erreur de bande, avec ses deux arguments, telle que le contrat la
  // construit. Recomposee ici depuis les getters plutot que codee en dur : ce
  // qui est verifie, c'est que setFee annonce SES bornes, pas que 1 et 25
  // soient les bonnes valeurs — ca, c'est le sujet du constructeur.
  function _feeOutOfBand() internal view returns (bytes memory) {
    return abi.encodeWithSelector(
      Pool.FeeOutOfBand.selector,
      pool.MIN_FEE_NUM(),
      _maxManagerFeeNum()
    );
  }
}

// ---------------------------------------------------------------------------
// I] Toute valeur DANS la bande est acceptee, et posee telle quelle
//
// L'assertion porte sur feeNum() relu, jamais sur la seule absence de revert :
// une fonction au corps vide passerait sans la relecture.
// ---------------------------------------------------------------------------

contract SetFeeInBandFuzzTest is SetFeeTestBase {

  function setUp() public override {
    super.setUp();
    pool.setManager(FIRST_MANDATE, MANAGER);
    _warpTo(FIRST_MANDATE, 0);
  }

  function test_FuzzAnyFeeInsideTheBandIsWrittenVerbatim(uint256 rawFeeNum) public {
    // Le domaine est [MIN_FEE_NUM, MAX_FEE_NUM / UNBALANCE_FACTOR] = [1, 25],
    // vingt-cinq valeurs : non vide, et borne des DEUX cotes par ce que le
    // contrat calcule, pas par des constantes recopiees.
    uint256 feeNum = bound(rawFeeNum, pool.MIN_FEE_NUM(), _maxManagerFeeNum());

    vm.prank(MANAGER);
    pool.setFee(feeNum);

    assertEq(
      uint256(pool.feeNum()),
      feeNum,
      "toute valeur de la bande doit etre ecrite telle quelle par setFee"
    );
  }

  function test_FuzzAnyFeeInsideTheBandStampsTheCurrentEpoch(uint256 rawFeeNum) public {
    // Le jumeau du precedent sur l'autre moitie du slot partage. Sans lui, un
    // setFee qui ecrirait feeNum mais oublierait lastSetFeeEpoch passerait le
    // test ci-dessus, et le tarif pose serait invisible pour feeInForce().
    uint256 feeNum = bound(rawFeeNum, pool.MIN_FEE_NUM(), _maxManagerFeeNum());

    vm.prank(MANAGER);
    pool.setFee(feeNum);

    assertEq(
      uint256(pool.lastSetFeeEpoch()),
      pool.currentEpoch(),
      "setFee doit estampiller l'epoch courante, quelle que soit la valeur posee"
    );
  }
}

// ---------------------------------------------------------------------------
// II] Toute valeur HORS de la bande est refusee, des deux cotes
//
// Les deux cotes ne se traitent pas de la meme facon, et c'est le point de
// methode de ce contrat. Au-dessus du plafond le domaine est immense
// (26 .. type(uint256).max) et appelle le fuzz. En dessous de MIN_FEE_NUM il
// ne contient qu'UNE valeur, zero, MIN_FEE_NUM valant 1 sur cette fixture :
// un `bound(x, 0, MIN_FEE_NUM - 1)` y serait un fuzz de facade qui retirerait
// toujours le meme nombre, et un `bound` sur une fixture ou MIN_FEE_NUM
// vaudrait 0 produirait un intervalle VIDE, donc un test vert qui n'eprouve
// rien. Le cas est donc ecrit en dur.
// ---------------------------------------------------------------------------

contract SetFeeOutOfBandFuzzTest is SetFeeTestBase {

  function setUp() public override {
    super.setUp();
    pool.setManager(FIRST_MANDATE, MANAGER);
    _warpTo(FIRST_MANDATE, 0);
  }

  function test_FuzzAnyFeeAboveTheManagerCeilingReverts(uint256 rawFeeNum) public {
    // Borne haute large et volontairement absurde : le plafond du type. La
    // garde de Pool.sol:167 compare sans arithmetique intermediaire, donc rien
    // ne deborde avant elle, et un tirage a type(uint256).max doit ressortir
    // par la meme porte qu'un tirage a 26.
    uint256 feeNum = bound(rawFeeNum, _maxManagerFeeNum() + 1, type(uint256).max);

    vm.expectRevert(_feeOutOfBand());
    vm.prank(MANAGER);
    pool.setFee(feeNum);
  }

  function test_MaxFeeNumItselfIsAboveTheManagerCeilingAndReverts() public {
    // LE cas de ce contrat. MAX_FEE_NUM (50) est le plafond de ce qu'un
    // preneur peut payer, et il est le DOUBLE du plafond qu'un gestionnaire
    // peut ecrire. Un setFee qui bornerait sur MAX_FEE_NUM au lieu de
    // MAX_FEE_NUM / UNBALANCE_FACTOR passerait tous les autres tests de ce
    // fichier — le fuzz ci-dessus le rattraperait, mais seulement sur une
    // partie des tirages. Ici la valeur est posee, et elle est celle qu'une
    // relecture distraite du contrat laisserait passer.
    //
    // Le getter est lu AVANT d'armer expectRevert : le cheatcode porte sur le
    // PROCHAIN appel, et un `pool.setFee(pool.MAX_FEE_NUM())` le ferait porter
    // sur le staticcall du getter, qui ne revert pas. Le test echouerait alors
    // sans avoir jamais appele setFee.
    uint256 takerCeiling = pool.MAX_FEE_NUM();

    vm.expectRevert(_feeOutOfBand());
    vm.prank(MANAGER);
    pool.setFee(takerCeiling);
  }

  function test_ZeroIsBelowTheMinimumAndReverts() public {
    // Le seul membre du domaine "sous MIN_FEE_NUM" sur cette fixture, d'ou
    // l'absence de fuzz (voir l'entete du contrat). Il ferme la borne basse de
    // la bande : un pool a frais nuls est un choix du CONSTRUCTEUR
    // (Pool.constructor.test.ts IV.A), jamais une decision de gestionnaire.
    // Garde de mise en place, pas une assertion de test : si un jour la
    // fixture posait MIN_FEE_NUM a 0, ce test deviendrait un test de la bande
    // BASSE valide, et il vaut mieux qu'il echoue franchement ici.
    require(pool.MIN_FEE_NUM() == 1, "fixture: MIN_FEE_NUM doit valoir 1");

    vm.expectRevert(_feeOutOfBand());
    vm.prank(MANAGER);
    pool.setFee(0);
  }

  function test_FuzzAnOutOfBandCallLeavesFeeNumUntouched(uint256 rawFeeNum) public {
    // Le revert ne dit rien de l'etat : c'est la relecture qui le dit. Elle
    // vaut surtout pour le slot partage, ou une ecriture partielle avant la
    // garde serait invisible autrement.
    uint256 feeNum = bound(rawFeeNum, _maxManagerFeeNum() + 1, type(uint256).max);

    vm.expectRevert(_feeOutOfBand());
    vm.prank(MANAGER);
    pool.setFee(feeNum);

    assertEq(
      uint256(pool.feeNum()),
      pool.NOMINAL_FEE_NUM(),
      "un setFee hors bande ne doit rien ecrire : feeNum reste celui du constructeur"
    );
  }
}

// ---------------------------------------------------------------------------
// III] Seule l'adresse du gestionnaire du mandat courant passe
//
// La garde d'acces (Pool.sol:153) compare a manager(), c'est-a-dire a
// managerOf[currentEpoch()], et non a un role stocke une fois pour toutes.
// Le fuzz balaie donc l'espace des adresses, l'owner du pool et le contrat de
// test inclus : aucun des deux n'a de privilege ici, et c'est le fait le plus
// contre-intuitif de la fonction.
// ---------------------------------------------------------------------------

contract SetFeeCallerFuzzTest is SetFeeTestBase {

  function setUp() public override {
    super.setUp();
    pool.setManager(FIRST_MANDATE, MANAGER);
    _warpTo(FIRST_MANDATE, 0);
  }

  function test_FuzzAnyCallerOtherThanTheCurrentManagerReverts(address caller) public {
    // Deux exclusions, et deux seulement. Le gestionnaire, parce que c'est
    // justement celui qui doit passer. L'adresse du cheatcode, parce que
    // vm.prank la refuse et que le test echouerait pour une raison qui n'a
    // rien a voir avec le contrat.
    vm.assume(caller != MANAGER);
    vm.assume(caller != address(vm));

    vm.expectRevert(Pool.NotManager.selector);
    vm.prank(caller);
    pool.setFee(10);
  }

  function test_FuzzAManagerOfAnotherMandateIsRefusedDuringThisOne(address otherManager) public {
    // Le cas qui distingue "gestionnaire" de "gestionnaire DU MANDAT
    // COURANT". L'adresse tiree recoit un vrai mandat, pour l'epoch suivante,
    // et appelle pendant celle-ci : elle est bien inscrite dans managerOf,
    // mais pas a l'indice que manager() lit. Une garde qui balaierait le
    // mapping au lieu de lire l'epoch courante passerait le test precedent et
    // echouerait ici.
    vm.assume(otherManager != MANAGER);
    vm.assume(otherManager != address(0));
    vm.assume(otherManager != address(vm));

    pool.setManager(FIRST_MANDATE + 1, otherManager);

    vm.expectRevert(Pool.NotManager.selector);
    vm.prank(otherManager);
    pool.setFee(10);
  }
}

// ---------------------------------------------------------------------------
// IV] La fenetre laisse passer si et SEULEMENT si l'offset est sous
//     PRIORITY_WINDOW
//
// Le test central est une EQUIVALENCE, et c'est delibere. Deux tests
// unilateraux — "sous la fenetre ca passe", "au-dessus ca revert" — seraient
// tous deux satisfaits par une fenetre placee ailleurs, tant qu'aucun tirage
// ne tombe entre les deux bornes. Ici le MEME tirage decide de la branche
// attendue, donc tout deplacement de la fenetre, dans un sens ou dans l'autre,
// fait echouer une moitie.
//
// Le domaine de ce test central est volontairement ETROIT, [0,
// 2 * PRIORITY_WINDOW], et c'est le point de methode du contrat. Fuzzer
// l'epoch entiere donnerait douze tirages favorables sur quatorze mille : la
// branche "l'appel passe" ne serait presque jamais executee, et le test
// dirait "ca revert partout" en se croyant une equivalence. Un fuzz dont une
// branche n'est atteinte qu'avec une probabilite negligeable n'est pas plus
// probant qu'un fuzz au domaine vide. Le reste de l'epoch est balaye
// separement, par un test unilateral qui n'a rien a prouver sur la frontiere.
// ---------------------------------------------------------------------------

contract SetFeeWindowFuzzTest is SetFeeTestBase {

  uint256 internal constant MANDATE_FEE_NUM = 17;

  function setUp() public override {
    super.setUp();
    // Aucune nomination ici, contrairement aux trois contrats precedents : le
    // second test de cette section pose son mandat sur une epoch fuzzee, et un
    // mandat deja pose sur l'epoch 1 le ferait sortir en ManagerAlreadySet des
    // que le tirage vaudrait 1.
  }

  function test_FuzzTheCallPassesExactlyWhenTheOffsetIsInsideTheWindow(uint256 rawOffset) public {
    // [0, 24] : douze offsets ouverts, treize fermes, et la frontiere au
    // milieu. Les deux branches sont donc echantillonnees a peu pres
    // egalement, et chaque tirage voisin de 11 ou de 12 eprouve reellement le
    // `<` de Pool.sol:154.
    uint256 offset = bound(rawOffset, 0, 2 * pool.PRIORITY_WINDOW());
    pool.setManager(FIRST_MANDATE, MANAGER);
    _warpTo(FIRST_MANDATE, offset);

    if (offset < pool.PRIORITY_WINDOW()) {
      vm.prank(MANAGER);
      pool.setFee(MANDATE_FEE_NUM);

      assertEq(
        uint256(pool.feeNum()),
        MANDATE_FEE_NUM,
        "sous PRIORITY_WINDOW, l'appel doit passer et poser le tarif"
      );
    } else {
      vm.expectRevert(Pool.OutsidePriorityWindow.selector);
      vm.prank(MANAGER);
      pool.setFee(MANDATE_FEE_NUM);
    }
  }

  function test_FuzzAnyOffsetBeyondTheWindowRevertsForTheWholeEpoch(uint256 rawOffset) public {
    // Le balayage large, unilateral et assume comme tel : tout le reste de
    // l'epoch, de la premiere seconde fermee a la derniere. Il ne dit rien de
    // la frontiere — c'est le test precedent qui la tient — mais il ferme
    // l'idee qu'une seconde fenetre pourrait se rouvrir ailleurs dans l'epoch,
    // ce qu'un modulo mal ecrit produirait.
    uint256 offset = bound(rawOffset, pool.PRIORITY_WINDOW(), pool.EPOCH_DURATION() - 1);
    pool.setManager(FIRST_MANDATE, MANAGER);
    _warpTo(FIRST_MANDATE, offset);

    vm.expectRevert(Pool.OutsidePriorityWindow.selector);
    vm.prank(MANAGER);
    pool.setFee(MANDATE_FEE_NUM);
  }

  function test_FuzzTheWindowIsMeasuredFromTheEpochStartNotFromGenesis(uint256 rawEpoch) public {
    // Corollaire de l'equivalence ci-dessus, et il n'est pas gratuit : le
    // modulo de Pool.sol:154 ramene l'instant au debut de l'EPOCH courante, pas
    // au GENESIS. Une garde ecrite sans modulo — `block.timestamp - GENESIS <
    // PRIORITY_WINDOW` — n'ouvrirait la fenetre qu'une fois dans la vie du
    // contrat, pendant les douze premieres secondes, et fermerait tous les
    // mandats suivants. Ce test la ferait echouer a toute epoch non nulle.
    uint256 epoch = bound(rawEpoch, 1, 1000);
    // AUDIT F6 : la voie d'amorcage de l'owner est desormais bornee a
    // `currentEpoch() + 1`. On se transporte donc a l'epoch precedente
    // AVANT de nommer, au lieu de nommer une epoch lointaine depuis
    // l'epoch 0. Le sujet du test est la fenetre de priorite, pas la
    // borne de nomination : le warp supplementaire ne change rien a ce
    // qu'il eprouve.
    _warpTo(epoch - 1, 0);
    pool.setManager(epoch, MANAGER);
    _warpTo(epoch, pool.PRIORITY_WINDOW() - 1);

    vm.prank(MANAGER);
    pool.setFee(MANDATE_FEE_NUM);

    assertEq(
      uint256(pool.feeNum()),
      MANDATE_FEE_NUM,
      "la derniere seconde de la fenetre doit passer a n'importe quelle epoch"
    );
  }
}

// ---------------------------------------------------------------------------
// V] Le mecanisme ne tient a aucune epoch particuliere
//
// Tout le reste du fichier travaille sur l'epoch 1, la premiere attribuable.
// Ce contrat verifie que ce n'est pas elle qui fait marcher la fonction : un
// mandat quelconque s'impose pendant son epoch, et retombe seul au nominal a
// la suivante, sans qu'aucune transaction ne soit envoyee entre les deux.
//
// L'observable est feeInForce(), qui n'est PAS re-testee ici — elle l'est dans
// test/Pool.feeInForce.{t.sol,test.ts}. Elle est utilisee pour ce qu'elle est :
// la seule lecture qui dise ce que le protocole facture reellement.
// ---------------------------------------------------------------------------

contract SetFeeAnyEpochFuzzTest is SetFeeTestBase {

  // Mille epochs, environ 166 jours a 4 h l'epoch : assez pour que l'epoch
  // prenne beaucoup de valeurs distinctes, assez peu pour rester tres loin du
  // plafond uint32 de lastSetFeeEpoch, qui est le sujet de
  // test/Pool.feeInForce.t.sol VI et pas de celui-ci.
  uint256 internal constant MAX_FUZZED_EPOCH = 1000;

  // Pose un mandat sur `epoch` pour MANAGER, s'y transporte, et y ecrit
  // `feeNum`. La nomination a lieu AVANT le warp : setManager exige une epoch
  // strictement future (Pool.sol:129), et setUp laisse l'horloge a l'epoch 0.
  function _runMandate(uint256 epoch, uint256 feeNum) internal {
    // AUDIT F6 : la voie d'amorcage de l'owner est bornee a
    // `currentEpoch() + 1`. La nomination se fait donc depuis l'epoch
    // precedente, et non plus depuis l'epoch 0 pour une epoch
    // quelconque. `epoch >= FIRST_MANDATE == 1`, donc `epoch - 1` ne
    // sous-deborde pas.
    _warpTo(epoch - 1, 0);
    pool.setManager(epoch, MANAGER);
    _warpTo(epoch, 0);
    vm.prank(MANAGER);
    pool.setFee(feeNum);
  }

  // Le tirage commun aux deux tests : une epoch quelconque et un tarif de la
  // bande DIFFERENT du nominal. Sans cette derniere condition, feeInForce()
  // rendrait la meme valeur par les deux branches du ternaire et
  // n'etablirait rien.
  function _boundMandate(uint256 rawEpoch, uint256 rawFeeNum)
    internal
    view
    returns (uint256 epoch, uint256 feeNum)
  {
    epoch = bound(rawEpoch, FIRST_MANDATE, MAX_FUZZED_EPOCH);
    feeNum = bound(rawFeeNum, pool.MIN_FEE_NUM(), _maxManagerFeeNum());
    vm.assume(feeNum != pool.NOMINAL_FEE_NUM());
  }

  function test_FuzzAMandateFeeIsInForceDuringItsOwnEpoch(
    uint256 rawEpoch,
    uint256 rawFeeNum
  ) public {
    (uint256 epoch, uint256 feeNum) = _boundMandate(rawEpoch, rawFeeNum);
    _runMandate(epoch, feeNum);

    assertEq(
      pool.feeInForce(),
      feeNum,
      "le tarif pose par le gestionnaire doit etre en vigueur pendant son epoch, quelle que soit cette epoch"
    );
  }

  function test_FuzzAMandateFeeFallsBackToNominalAtTheNextEpoch(
    uint256 rawEpoch,
    uint256 rawFeeNum
  ) public {
    (uint256 epoch, uint256 feeNum) = _boundMandate(rawEpoch, rawFeeNum);
    _runMandate(epoch, feeNum);

    // Une epoch plus loin, et rien d'autre : vm.warp est un cheatcode, pas une
    // transaction. Personne ne paie la remise a zero.
    _warpTo(epoch + 1, 0);

    assertEq(
      pool.feeInForce(),
      pool.NOMINAL_FEE_NUM(),
      "a l'epoch suivante, sans aucune transaction, le tarif du mandat expire doit avoir disparu"
    );
  }

  function test_FuzzTheRawFeeNumSurvivesTheEpochChange(
    uint256 rawEpoch,
    uint256 rawFeeNum
  ) public {
    // La contrepartie du test precedent, et ce qui empeche de le lire de
    // travers : ce n'est pas le STOCKAGE qui est remis a zero, c'est la
    // COMPARAISON de feeInForce() qui bascule. feeNum brut porte encore le
    // tarif perime, et c'est exactement ce que swap lit aujourd'hui — voir la
    // divergence signalee dans test/README.md.
    (uint256 epoch, uint256 feeNum) = _boundMandate(rawEpoch, rawFeeNum);
    _runMandate(epoch, feeNum);
    _warpTo(epoch + 1, 0);

    assertEq(
      uint256(pool.feeNum()),
      feeNum,
      "le feeNum brut ne bouge pas au passage d'epoch : aucune ecriture ne l'y remet au nominal"
    );
  }
}
