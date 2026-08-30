// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Pool} from "../contracts/Pool.sol";
import {MRN} from "../contracts/MRN.sol";
import {MockWrappedBTC} from "../contracts/MockWrappedBTC.sol";
import {Auction} from "../contracts/Auction.sol";

// Suite de non-regression des trois failles d'audit portees par
// Auction.sol : F1 (brique definitive de l'enchere), F2 (settle nomme le
// mauvais gagnant), F3 (capture du mandat au prix plancher par reglement
// anticipe).
//
// Pourquoi du Solidity et pas du TypeScript, ici. Les trois failles se
// formulent en TEMPS et en ETAT INTERNE, pas en parcours utilisateur. F1
// exige de faire tourner deux epochs entieres (8 heures de temps de
// chaine) entre deux mises pour perimer un `pendingEpoch` ; F3 exige de
// se poser a la SECONDE, de part et d'autre de `startOfEpoch(sellingEpoch
// - 1) + auctionWindow` ; F2 ne s'observe que sur un etat ou
// `pendingBidder` et `highBidder` DIFFERENT, etat qu'aucun parcours
// nominal ne produit. `vm.warp` est le bon outil pour les trois, et
// forge-std donne en prime l'assertion par selecteur avec arguments
// encodes (`WindowStillOpen(uint256)`), qu'une correspondance de chaine
// ne remplacerait pas. Le parcours reseau des encheres (approve MRN,
// transferFrom, lecture des events) reste couvert par
// test/Auction.test.ts, conformement au partage decrit dans
// test/README.md.
//
// Chaque test est en deux temps : le commentaire decrit l'attaque TELLE
// QU'ELLE REUSSISSAIT avant le correctif, et l'assertion epingle ce que
// le contrat fait desormais.
//
// La fixture est duplique depuis contracts/Auction.t.sol plutot que
// partagee par heritage : ce fichier doit pouvoir bouger sans faire
// bouger la suite fonctionnelle, et la convention du projet prefere la
// duplication d'une fixture courte a un couplage entre fichiers de test
// (cf. test/README.md).

abstract contract AuctionSecurityTestBase is Test {

  MockWrappedBTC internal wbtc;
  MockWrappedBTC internal cbbtc;
  MockWrappedBTC internal lbtc;
  Pool internal pool;
  MRN internal mrn;
  Auction internal auction;

  uint256 internal constant EPOCH_DURATION = 14400; // 4 h
  uint256 internal constant AUCTION_WINDOW = 900;   // 15 min
  uint256 internal constant MAX_EXTENSION = 0;      // A1 roadmap
  uint256 internal constant BID_SILENCE = 60;
  uint256 internal constant MIN_OPENING_BID = 10e18;

  // Premiere mise, au-dessus de MIN_OPENING_BID et sous la hausse de
  // +10 % (11 MRN), meme convention que contracts/Auction.t.sol.
  uint256 internal constant FIRST_BID = 10.5e18;

  // Amorce du pool par jambe. `_settle` appelle `pool.notifyRent`, qui
  // n'entre dans sa branche nominale que si `totalSupply() >
  // MINIMUM_LIQUIDITY` : sans amorce, le chemin de reglement nominal ne
  // serait pas celui de la production.
  uint256 internal constant SEED_PER_LEG = 1000e8;

  address internal constant BIDDER_A = address(uint160(0xA11CE));
  address internal constant BIDDER_B = address(uint160(0xB0B));
  address internal constant TREASURY = address(0xBEEF);

  function setUp() public virtual {
    wbtc = new MockWrappedBTC("Wrapped BTC", "wBTC");
    cbbtc = new MockWrappedBTC("Coinbase BTC", "cbBTC");
    lbtc = new MockWrappedBTC("Lombard BTC", "lBTC");

    address[3] memory tokens = [address(wbtc), address(cbbtc), address(lbtc)];
    mrn = new MRN();
    pool = new Pool(tokens, EPOCH_DURATION, 12, 1, 5, TREASURY, address(mrn), address(this));
    auction = new Auction(
      address(pool),
      address(mrn),
      AUCTION_WINDOW,
      MAX_EXTENSION,
      BID_SILENCE,
      MIN_OPENING_BID
    );
    pool.setAuction(address(auction));

    wbtc.mint(address(this), SEED_PER_LEG);
    cbbtc.mint(address(this), SEED_PER_LEG);
    lbtc.mint(address(this), SEED_PER_LEG);
    wbtc.approve(address(pool), type(uint256).max);
    cbbtc.approve(address(pool), type(uint256).max);
    lbtc.approve(address(pool), type(uint256).max);
    pool.addLiquidity(0, SEED_PER_LEG, 0);

    uint256 funding = 1_000_000e18;
    mrn.transfer(BIDDER_A, funding);
    mrn.transfer(BIDDER_B, funding);

    vm.prank(BIDDER_A);
    mrn.approve(address(auction), type(uint256).max);
    vm.prank(BIDDER_B);
    mrn.approve(address(auction), type(uint256).max);
  }

  function _bidAs(address bidder, uint256 amount) internal {
    vm.prank(bidder);
    auction.placeBid(amount);
  }

  // Premier instant de l'epoch `epoch`.
  function _warpToEpoch(uint256 epoch) internal {
    vm.warp(pool.GENESIS() + epoch * EPOCH_DURATION);
  }

  // Instant EXACT de fermeture de la fenetre d'enchere du mandat
  // `sellingEpoch`, c'est-a-dire la premiere seconde ou `settle()` est
  // accepte et ou `placeBid` ne l'est plus. Les deux gardes lisent la
  // MEME expression, l'une en `<`, l'autre en `>=` : les deux phases
  // sont disjointes et sans trou.
  function _closesAt(uint256 sellingEpoch) internal view returns (uint256) {
    return pool.GENESIS() + (sellingEpoch - 1) * EPOCH_DURATION + AUCTION_WINDOW;
  }
}

// ---------------------------------------------------------------------------
// F3 — Capture du mandat au prix plancher par reglement anticipe
//
// L'attaque telle qu'elle reussissait : `settle()` n'avait AUCUNE garde
// temporelle. A la premiere seconde de la fenetre, un attaquant posait
// `placeBid(minOpeningBid)` puis `settle()` dans la MEME transaction. Il
// devenait gestionnaire du mandat suivant au prix plancher, et plus
// personne ne pouvait surencherir utilement : un second `settle` sur la
// meme epoch heurtait `Pool.ManagerAlreadySet`. Le commentaire du contrat
// reconnaissait la garde « A4 » comme un FIXME non implemente.
// ---------------------------------------------------------------------------

contract AuctionEarlySettleTest is AuctionSecurityTestBase {

  function test_SettleAtTheFirstSecondOfTheWindowRevertsWindowStillOpen() public {
    // Le snipe, joue tel quel : mise plancher a la premiere seconde,
    // reglement immediat.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, MIN_OPENING_BID);

    // L'erreur porte son argument : l'appelant apprend QUAND il pourra
    // revenir, ce qu'un revert nu ne dirait pas. On l'encode en entier
    // plutot que de se contenter du selecteur, parce que c'est
    // precisement cette valeur qui separe les deux phases.
    vm.expectRevert(abi.encodeWithSelector(Auction.WindowStillOpen.selector, _closesAt(1)));
    auction.settle();
  }

  function test_TheSnipedMandateStaysUnassignedDuringTheWindow() public {
    // La consequence utile de la garde, dite du cote du Pool : le mandat
    // reste libre. Avant F3, `managerOf[1]` valait deja l'attaquant a cet
    // instant et le mandat etait ferme pour de bon.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, MIN_OPENING_BID);

    try auction.settle() {
      revert("le settle anticipe aurait du reverter");
    } catch {}

    assertEq(
      pool.managerOf(1),
      address(0),
      "F3 : pendant la fenetre, aucun gestionnaire ne doit etre nomme, sinon la surenchere devient inutile"
    );
  }

  function test_AnOutbidRemainsPossibleAfterAFailedSnipe() public {
    // Le fond de la faille : ce que le snipe volait, c'etait la
    // CONTESTABILITE du mandat. Apres la tentative echouee, un second
    // encherisseur doit encore pouvoir passer devant.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, MIN_OPENING_BID);
    try auction.settle() {
      revert("le settle anticipe aurait du reverter");
    } catch {}

    _bidAs(BIDDER_B, MIN_OPENING_BID * 11 / 10);

    assertEq(
      auction.highBidder(),
      BIDDER_B,
      "F3 : la surenchere doit encore pouvoir passer devant apres un snipe manque"
    );
  }

  function test_SettleIsAcceptedAtTheExactSecondTheWindowCloses() public {
    // La contrepartie, sans laquelle la garde serait un verrou et non un
    // ordonnancement : a la seconde EXACTE de fermeture, le reglement
    // passe. La frontiere est inclusive cote settle (`>=`) et exclusive
    // cote placeBid (`<`), donc sans trou ni recouvrement.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);

    vm.warp(_closesAt(1));
    auction.settle();

    assertEq(
      pool.managerOf(1),
      BIDDER_A,
      "F3 : a la seconde de fermeture, le reglement doit nommer le gagnant de l'enchere"
    );
  }

  function test_PlaceBidIsRefusedAtTheExactSecondTheWindowCloses() public {
    // L'autre moitie de la frontiere. Si `placeBid` etait encore accepte
    // ici, les deux phases se recouvriraient d'une seconde et le snipe
    // redeviendrait possible dans cet interstice.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);

    vm.warp(_closesAt(1));
    vm.expectRevert(Auction.WindowClosed.selector);
    _bidAs(BIDDER_B, FIRST_BID * 11 / 10);
  }
}

// ---------------------------------------------------------------------------
// F1 — Brique definitive de l'enchere
//
// L'attaque telle qu'elle reussissait : `sellingEpoch` n'est jamais ecrit
// qu'avec `currentEpoch() + 1`. Un `pendingEpoch` capture par la
// reinitialisation de `placeBid` est donc TOUJOURS <= `currentEpoch()`.
// `_settle` appelait `pool.setManager(pendingEpoch, ...)`, le Pool exige
// `_epoch > currentEpoch()`, et le revert `EpochAlreadyStarted` arrivait
// AVANT la remise a zero du slot en fin de fonction. Le slot n'etait donc
// jamais purge : chaque `settle()` ulterieur rejouait le meme revert. Le
// resultat n'etait pas une gene, c'etait la mort du mecanisme — plus
// aucun mandat nomme, plus aucune rente versee aux LP, et les MRN du
// gagnant capture immobilises sans aucun chemin de sortie, `refunds`
// n'ayant jamais ete credite pour lui.
//
// La fixture commune aux tests de cette section : A gagne l'enchere du
// mandat 1, personne ne regle, deux epochs passent, B ouvre l'enchere du
// mandat 3 et capture A dans le slot pending.
// ---------------------------------------------------------------------------

abstract contract ExpiredMandateFixture is AuctionSecurityTestBase {

  uint256 internal constant B_BID = MIN_OPENING_BID;

  function _stageExpiredPending() internal {
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID); // enchere du mandat 1, A en tete

    _warpToEpoch(2); // le mandat 1 a demarre ET fini sans reglement
    _bidAs(BIDDER_B, B_BID); // reinitialisation : capture de A dans le pending
  }
}

contract AuctionExpiredSettlementTest is ExpiredMandateFixture {

  function test_TheCaptureRecordsTheExpiredMandate() public {
    // Prealable rendu explicite : sans lui, les tests suivants
    // passeraient sur un etat qui n'est pas celui qu'ils croient poser.
    _stageExpiredPending();

    assertEq(
      auction.pendingEpoch(),
      1,
      "fixture : le slot pending doit porter le mandat 1, perime depuis deux epochs"
    );
  }

  function test_ExpiredSettlementRefundsTheCapturedBidder() public {
    // LA verite de F1. Avant, ce MRN etait piege pour toujours : ni
    // reglable, ni remboursable, ni ecrasable sans se perdre.
    _stageExpiredPending();

    auction.settle();

    assertEq(
      auction.refunds(BIDDER_A),
      FIRST_BID,
      "F1 : le gagnant d'un mandat perime doit recuperer l'integralite de sa mise, le mandat est perdu, pas l'argent"
    );
  }

  function test_ExpiredSettlementCreditsNothingToTheLiveHighBidder() public {
    // LA verite de F2, observee sur le seul etat qui la distingue : le
    // pending appartient a A, l'enchere vivante est menee par B. Avant,
    // `settle()` passait `highBidder` a `_settle`, donc B — c'etait B
    // qui devenait gestionnaire du mandat de A. Corriger F1 sans F2
    // aurait transforme la brique en vol de mandat.
    _stageExpiredPending();

    auction.settle();

    assertEq(
      auction.refunds(BIDDER_B),
      0,
      "F2 : le meneur de l'enchere COURANTE n'a rien a voir avec le mandat perime, il ne doit rien recevoir"
    );
  }

  function test_ExpiredSettlementPurgesThePendingSlot() public {
    // La deuxieme moitie de F1 : la purge. Sans elle, le slot resterait
    // occupe et le prochain reglement rejouerait le meme chemin.
    _stageExpiredPending();

    auction.settle();

    assertEq(
      auction.pendingEpoch(),
      0,
      "F1 : le slot pending doit etre purge, sinon la brique se reconstitue au reglement suivant"
    );
  }

  function test_ExpiredSettlementLeavesTheLiveAuctionUntouched() public {
    // L'enchere en cours n'est PAS collateralement annulee : le mandat 3
    // reste dispute. C'est ce qui distingue "un mandat perdu" de "le
    // mecanisme mort".
    _stageExpiredPending();

    auction.settle();

    assertEq(
      auction.highBidder(),
      BIDDER_B,
      "F1 : le reglement d'un mandat perime ne doit pas toucher l'enchere vivante"
    );
  }

  function test_ExpiredSettlementNominatesNobody() public {
    // Le mandat perime tourne sans gestionnaire, au tarif nominal. C'est
    // la degradation acceptee, et elle est bornee a UNE epoch.
    _stageExpiredPending();

    auction.settle();

    assertEq(
      pool.managerOf(1),
      address(0),
      "F1 : un mandat perime ne nomme personne, il tourne au tarif nominal"
    );
  }

  function test_ExpiredSettlementBurnsNothing() public {
    // Rien n'est brule : l'argent revient integralement a son
    // proprietaire, sans prelevement de 30 %. Un burn partiel rendrait
    // le remboursement mensonger.
    _stageExpiredPending();
    uint256 supplyBefore = mrn.totalSupply();

    auction.settle();

    assertEq(
      mrn.totalSupply(),
      supplyBefore,
      "F1 : aucun MRN ne doit etre brule sur un mandat perime, la mise est rendue entiere"
    );
  }

  function test_ExpiredSettlementPaysNoRent() public {
    // Pas de rente non plus : les LP ne sont pas payes pour un mandat
    // qui n'a jamais existe, et le pool ne recoit pas de MRN qu'il
    // devrait ensuite streamer sans contrepartie.
    _stageExpiredPending();
    uint256 poolBefore = mrn.balanceOf(address(pool));

    auction.settle();

    assertEq(
      mrn.balanceOf(address(pool)),
      poolBefore,
      "F1 : aucun loyer ne doit partir au pool sur un mandat perime"
    );
  }

  function test_ExpiredSettlementEmitsSettlementExpired() public {
    // L'evenement dedie : un indexeur doit pouvoir distinguer "mandat
    // perdu, mise rendue" d'un `Settled` ordinaire. Sans lui, la
    // difference ne se lirait que par l'absence d'un evenement.
    _stageExpiredPending();

    vm.expectEmit(true, true, false, true, address(auction));
    emit Auction.SettlementExpired(1, BIDDER_A, FIRST_BID);
    auction.settle();
  }

  function test_TheRefundedBidderCanActuallyWithdraw() public {
    // Le credit ne vaut que s'il est tirable : c'est le bout du chemin
    // de sortie que F1 avait supprime.
    _stageExpiredPending();
    auction.settle();

    uint256 before = mrn.balanceOf(BIDDER_A);
    vm.prank(BIDDER_A);
    auction.withdrawRefund();

    assertEq(
      mrn.balanceOf(BIDDER_A) - before,
      FIRST_BID,
      "F1 : le remboursement doit etre reellement tirable par withdrawRefund"
    );
  }

  function test_TheAuctionSurvivesTheExpiredMandate() public {
    // La preuve de vie : apres le mandat perdu, le mandat suivant se
    // regle normalement. Avant, ce reglement etait impossible pour
    // toujours.
    _stageExpiredPending();
    auction.settle();

    vm.warp(_closesAt(3)); // fermeture de la fenetre du mandat 3
    auction.settle();

    assertEq(
      pool.managerOf(3),
      BIDDER_B,
      "F1 : apres un mandat perdu, l'enchere doit continuer a nommer les mandats suivants"
    );
  }
}

// ---------------------------------------------------------------------------
// F1 (suite) — Le remboursement doit etre A UN COUP
//
// Defaut trouve a la RELECTURE du correctif F1, pas dans le contrat
// d'origine : c'est la correction elle-meme qui l'avait ouvert. La
// branche de capture de `settle()` ecrivait les trois champs `pending*`
// mais laissait `highBid` / `highBidder` en place. Sur un `sellingEpoch`
// perime — le scenario meme de F1, le bot n'a pas regle et l'epoch a
// tourne — chaque `settle()` recapturait donc la MEME enchere vive,
// tombait dans la branche perimee, et creditait `refunds[A] += highBid`
// une fois DE PLUS. Permissionless et rejouable a l'infini : n'importe
// qui vidait le MRN de l'Auction en payant le gaz, et l'invariant de
// solvabilite `balanceOf(auction) == somme(refunds) + pendingAmount +
// highBid` sautait des le deuxieme appel.
//
// La capture DEPLACE desormais l'enchere vive dans le slot pending au
// lieu de la copier. C'est la meme discipline que la reinitialisation de
// `placeBid`, qui remet `highBid` a zero apres avoir capture.
// ---------------------------------------------------------------------------

contract AuctionExpiredSettlementIsOneShotTest is AuctionSecurityTestBase {

  // Enchere gagnee par A pour le mandat 1, personne ne regle, deux epochs
  // passent. Le slot pending est VIDE — c'est ce qui distingue cet etat
  // de celui d'`ExpiredMandateFixture` : ici, c'est `settle()` lui-meme
  // qui capture, et non une reinitialisation de `placeBid`.
  function _stageStaleLiveAuction() internal {
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);
    _warpToEpoch(2);
  }

  function test_TheStaleAuctionIsCapturedFromAnEmptyPendingSlot() public {
    // Prealable rendu explicite : sans lui, les tests suivants
    // porteraient sur le chemin d'`ExpiredMandateFixture`, pas sur
    // celui-ci.
    _stageStaleLiveAuction();

    assertEq(
      auction.pendingEpoch(),
      0,
      "fixture : le slot pending doit etre vide, c'est settle() qui doit capturer"
    );
  }

  function test_ASecondSettleCannotRefundTheSameBidTwice() public {
    // LA verite : le remboursement est a un coup. Avant le durcissement,
    // `refunds[A]` valait 2 * FIRST_BID apres ce deuxieme appel.
    _stageStaleLiveAuction();
    auction.settle();

    try auction.settle() {} catch {}

    assertEq(
      auction.refunds(BIDDER_A),
      FIRST_BID,
      "F1 : un mandat perime ne doit etre rembourse qu'une fois, sinon settle() est une pompe a MRN"
    );
  }

  function test_TheSecondSettleFindsNothingLeftToSettle() public {
    // Le mecanisme qui ferme la pompe, epingle directement : la capture
    // a VIDE l'enchere vive, il ne reste donc plus rien a recapturer.
    _stageStaleLiveAuction();
    auction.settle();

    vm.expectRevert(Auction.NoBidToSettle.selector);
    auction.settle();
  }

  function test_TheSolvencyInvariantHoldsAfterTheExpiredRefund() public {
    // L'invariant de solvabilite de test/Auction.invariant.t.sol, verifie
    // ici sur le chemin exact que le correctif F1 a ouvert :
    // `balanceOf(auction) == somme(refunds) + pendingAmount + highBid`.
    // Un double comptage cote passif le casse immediatement.
    _stageStaleLiveAuction();
    auction.settle();

    uint256 owed = auction.refunds(BIDDER_A)
      + auction.refunds(BIDDER_B)
      + auction.pendingAmount()
      + auction.highBid();

    assertEq(
      mrn.balanceOf(address(auction)),
      owed,
      "F1 : le solde MRN de l'Auction doit couvrir exactement ses obligations, ni plus ni moins"
    );
  }

  function test_TheCaptureEmptiesTheLiveAuction() public {
    // Le detail de mecanique dont depend tout ce qui precede, dit une
    // fois pour lui-meme : la capture DEPLACE, elle ne copie pas.
    _stageStaleLiveAuction();
    auction.settle();

    assertEq(
      auction.highBidder(),
      address(0),
      "F1 : la capture doit vider l'enchere vive, sinon le meme montant se recapture indefiniment"
    );
  }
}

// ---------------------------------------------------------------------------
// F1 (suite) — Un mandat DEJA POURVU n'est pas une brique non plus
//
// Deuxieme defaut trouve a la relecture. `_settle` n'interceptait que
// `pendingEpoch <= currentEpoch()`. Restait un second chemin vers
// `pool.setManager` qui revert : une epoch STRICTEMENT FUTURE mais dont
// `managerOf` est deja ecrit. F6 borne l'owner a `currentEpoch() + 1`
// mais ne lui interdit pas cette epoch-la : un pool amorce dont l'owner a
// nomme le mandat suivant AVANT `setAuction` produit exactement cet etat,
// et l'enchere peut tres bien avoir vendu la meme epoch. `_settle`
// revertait alors `ManagerAlreadySet` avant la purge, et le MRN du
// gagnant restait bloque jusqu'a ce que l'epoch tourne — la brique de
// F1, en version bornee dans le temps mais avec le meme mecanisme.
//
// La branche perimee couvre desormais les deux cas : un mandat qu'on ne
// peut pas attribuer est rembourse, quelle qu'en soit la raison. C'est ce
// qui rend `Pool.ManagerAlreadySet` reellement inatteignable depuis le
// chemin de l'enchere, l'affirmation sur laquelle repose la reecriture de
// test/Auction.invariant.t.sol.
// ---------------------------------------------------------------------------

contract AuctionAlreadyNominatedMandateTest is AuctionSecurityTestBase {

  // A gagne l'enchere du mandat 1, mais le mandat 1 a deja un
  // gestionnaire. On l'ecrit par la voie de l'enchere elle-meme : la
  // question posee a `_settle` est « cette epoch est-elle attribuable »,
  // pas « qui l'a attribuee ».
  function _stageAlreadyNominatedMandate() internal {
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);

    vm.prank(address(auction));
    pool.setManager(1, BIDDER_B);

    vm.warp(_closesAt(1));
  }

  function test_TheMandateIsAlreadyTakenBeforeSettling() public {
    // Prealable rendu explicite.
    _stageAlreadyNominatedMandate();

    assertEq(
      pool.managerOf(1),
      BIDDER_B,
      "fixture : le mandat 1 doit deja etre pourvu quand le reglement se presente"
    );
  }

  function test_SettlingAnAlreadyTakenMandateRefundsInsteadOfReverting() public {
    // LA verite : pas de revert, pas de brique, l'argent revient.
    _stageAlreadyNominatedMandate();

    auction.settle();

    assertEq(
      auction.refunds(BIDDER_A),
      FIRST_BID,
      "F1 : un mandat inattribuable doit rembourser son gagnant, pas figer le slot sur ManagerAlreadySet"
    );
  }

  function test_SettlingAnAlreadyTakenMandatePurgesThePendingSlot() public {
    // La purge, sans laquelle le blocage se rejouerait a chaque appel
    // jusqu'a la rotation d'epoch.
    _stageAlreadyNominatedMandate();

    auction.settle();

    assertEq(
      auction.pendingEpoch(),
      0,
      "F1 : le slot doit etre purge, sinon le reglement reste bloque jusqu'a la rotation d'epoch"
    );
  }

  function test_TheIncumbentManagerIsNotOverwritten() public {
    // La contrepartie : le remboursement ne doit pas etre l'occasion
    // d'ecraser le gestionnaire en place. `managerOf` reste ecrit-une-fois.
    _stageAlreadyNominatedMandate();

    auction.settle();

    assertEq(
      pool.managerOf(1),
      BIDDER_B,
      "F1 : le gestionnaire deja nomme doit rester en place, la garde du Pool n'est pas contournee"
    );
  }
}
