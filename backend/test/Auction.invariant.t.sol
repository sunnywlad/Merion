// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";
import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {Pool} from "../contracts/Pool.sol";
import {MRN} from "../contracts/MRN.sol";
import {MockWrappedBTC} from "../contracts/MockWrappedBTC.sol";
import {Auction} from "../contracts/Auction.sol";

// ---------------------------------------------------------------------------
// I.6 / I4 — invariant Foundry : le MRN detenu par l'Auction couvre en
// permanence ses trois passifs.
//
//   mrn.balanceOf(address(auction)) == sumRefunds + pendingAmount + highBid
//                                      + deadMrn   (compteur du handler)
//
// Le passif de l'Auction se lit en trois postes, tous on-chain :
//   - `sumRefunds`     : la somme des `refunds[a]` credites et pas encore
//                        tires, recomputee a chaque check sur le jeu FIXE
//                        d'acteurs du handler (aucun accumulateur fantome) ;
//   - `pendingAmount`  : le montant d'un mandat gagne mais pas encore regle,
//                        capture par la reinitialisation par comparaison de
//                        `placeBid` ou par `settle()` ;
//   - `highBid`        : la mise en tete de l'enchere en cours.
//
// L'assertion est une EGALITE EXACTE : `held == owed + deadMrn`. Le solde MRN
// de l'Auction depasse son passif on-chain d'un poste unique et mesurable : un
// mandat capture par une reinitialisation `placeBid` dont l'epoch a deja
// tourne ne pourra jamais etre regle (`_settle` -> `pool.setManager` revert
// `EpochAlreadyStarted`) ; quand une SECONDE reinitialisation ecrase
// `pendingAmount` avec la mise de l'enchere suivante sans sortir l'ancienne
// (`Auction.sol` placeBid (1) : la capture `pendingEpoch = sellingEpoch;
// pendingAmount = highBid;` est inconditionnelle des lors que `highBidder !=
// address(0)` au reset), le MRN de l'ancien pending reste immobilise dans
// l'Auction sans obligation en face. Le handler ACCUMULE exactement ces
// montants ecrases dans `deadMrn`, un par un, a l'instant ou la
// reinitialisation les rend intracables. `owed + deadMrn` couvre alors la
// totalite du solde au wei pres, et l'egalite devient discriminante : une
// mutation cote passif (retirer un `refunds[x] +=`, un `pendingAmount =`)
// casse `held == owed + deadMrn` la ou un `>=` a marge croissante l'aurait
// absorbee. `deadMrn` ne compte QUE du MRN reellement fige : la part 30/70 de
// l'ancien pending n'a jamais ete extraite (`_settle` sur lui revert avant
// tout mouvement) et ce pending n'etait deja plus reglable (son epoch <=
// currentEpoch()). Aucun MRN encore reglable n'y entre.
//
// DEVIATION consignee (cf. brief I.6 et la fiche I.6-fuzzing-invariants) :
// la fiche loge tout le Half B dans `Pool.invariant.t.sol`. I4 a son propre
// handler (`placeBid` / `settle` / `withdrawRefund` / `warp`) et sa propre
// cible (`address(auction)` comme sujet de l'invariant, `address(handler)`
// comme `targetContract`) ; un fichier separe `Auction.invariant.t.sol` est
// plus propre qu'un fichier nomme `Pool` qui porterait les deux.
//
// failOnRevert = true, NON NEGOCIABLE. Fichier neuf : chaque wrapper `bound()`
// ses arguments dans un domaine ou l'appel reussit, ou enveloppe le revert
// LEGITIME dans un `try/catch` qui n'avale QUE des selecteurs NOMMES et
// documentes (jamais de `catch` nu, jamais `Panic`, jamais
// `ERC20InsufficientAllowance` : l'`approve` max est pose au constructeur du
// handler). La config est posee en commentaire `forge-config:` local sur
// l'invariant, faute de `foundry.toml` dans le projet.
//
// SELECTEURS AVALES (revert attendu, pas un bug masque) :
//   placeBidWrapper     : Auction.WindowClosed        — la fenetre d'enchere
//     (900 s apres le debut de l'epoch vendue) est fermee. FILET : depuis le
//     recalage de fenetre en tete de `placeBidWrapper` (voir la DEVIATION
//     documentee la-bas), le wrapper avance le temps jusqu'a la prochaine
//     ouverture avant de miser, donc ce revert n'est quasiment plus atteint
//     par le fuzzer ; le `catch` reste comme garde-fou si un chemin non
//     couvert ferme la fenetre entre le recalage et l'appel.
//   settleWrapper       : Auction.NoBidToSettle       — aucun mandat en
//     attente et aucune enchere courante a capturer (slot vide, degradation
//     R7) ; c'est l'idempotence documentee de `settle`.
//   settleWrapper       : Pool.EpochAlreadyStarted    — `_settle` appelle
//     `pool.setManager(pendingEpoch, ...)` avec `pendingEpoch <=
//     currentEpoch()` : le mandat capture par une reinitialisation `placeBid`
//     a deja demarre. Garde I.1 du Pool (Pool.sol:187), degradation R7.
//   settleWrapper       : Pool.ManagerAlreadySet      — un `settle` reussi a
//     deja nomme le gestionnaire de cet epoch, puis de nouvelles mises sont
//     tombees sur la MEME `sellingEpoch` (aucun warp entre les deux) et un
//     second `settle` retente `pool.setManager` sur l'epoch deja pourvue.
//     Garde I.1 du Pool (Pool.sol:189) : la protection du Pool contre une
//     double nomination par l'enchere tient, l'Auction ne force rien.
//     (Ajout au-dela de la liste du brief, meme famille que le point
//     precedent : deuxieme revert Pool legitime sur le chemin `_settle`.)
//   withdrawRefundWrapper : Auction.NoBidToRefund     — l'acteur n'a aucun
//     refund credite. Cas nominal d'un pull-only sur un registre vide.
//
// `warpWrapper` : `vm.warp` n'est la transaction d'aucun acteur, mais le
// temps n'est pas un etat fabrique, c'est une dimension. C'est le seul moyen
// de faire tourner les epochs et d'exercer la reinitialisation par
// comparaison (close -> open) et la capture `pendingEpoch` / `pendingAmount`
// qui est le coeur du risque de double-comptage. Admis et documente pour un
// handler d'invariant.
// ---------------------------------------------------------------------------

contract AuctionHandler is CommonBase, StdUtils, StdAssertions {
  Auction public immutable auction;
  MRN public immutable mrn;
  uint256 public immutable epochDuration;
  uint256 public immutable genesis;

  // Jeu d'acteurs FIXE et BORNE. EOA sans code, distincts des contrats
  // deployes (adresses hautes). Finances par le test juste apres la
  // construction (le MRN pre-mint du deployeur ne peut pas etre pousse dans
  // une adresse pas encore deployee) ; leur `approve` max vers l'Auction est
  // pose ici, au constructeur.
  address[4] public actors;

  // Plafond de mise impose au handler (pas au contrat). Sans warp entre deux
  // appels, une salve de `placeBid` fait croitre `highBid` de +10 % a chaque
  // fois (HIGH_BID_BPS) : geometrique, elle exploserait le financement des
  // acteurs et ferait reverter `safeTransferFrom` en
  // `ERC20InsufficientBalance`, hors de la liste des selecteurs avales.
  // Au-dela de ce plafond le wrapper passe son tour ; la fenetre finit par se
  // fermer et la reinitialisation ramene `highBid` a zero. Le financement par
  // acteur (ACTOR_FUNDING) est choisi tres au-dessus de la somme geometrique
  // possible jusqu'a ce plafond.
  uint256 internal constant MAX_BID = 1e22;
  uint256 internal constant BID_SPREAD = 100e18;

  // Compteurs de couverture, exposes au runner via afterInvariant() et
  // asserts par les tests deterministes de fin de fichier.
  uint256 public placeBidsOk;
  uint256 public windowClosedCatches;
  uint256 public settlesOk;
  uint256 public noBidToSettleCatches;
  uint256 public epochAlreadyStartedCatches;
  uint256 public managerAlreadySetCatches;
  uint256 public withdrawsOk;
  uint256 public noBidToRefundCatches;
  uint256 public warps;
  uint256 public resetsObserved;
  uint256 public bidsSkippedHighFloor;
  uint256 public bidsSkippedFunding;

  // MRN mort : la somme des `pendingAmount` non nuls qu'une reinitialisation
  // `placeBid` a ecrases sans les sortir du solde (voir entete de fichier).
  // Chaque montant ecrase etait deja non reglable (epoch <= currentEpoch()) et
  // sa part 30/70 n'a jamais bouge. `held == sumRefunds + pendingAmount +
  // highBid + deadMrn` au wei pres sur toute la campagne.
  uint256 public deadMrn;

  constructor(Auction _auction, MRN _mrn) {
    auction = _auction;
    mrn = _mrn;
    epochDuration = _auction.pool().EPOCH_DURATION();
    genesis = _auction.pool().GENESIS();

    actors[0] = address(0xA11CE);
    actors[1] = address(0xB0B);
    actors[2] = address(0xC0FFEE);
    actors[3] = address(0xDECAF);

    for (uint256 i; i < 4; i++) {
      vm.prank(actors[i]);
      _mrn.approve(address(_auction), type(uint256).max);
    }
  }

  // Somme relue du passif "refunds" sur le jeu FIXE d'acteurs. `view`, pas
  // d'accumulateur : l'etat est relu a chaque check.
  function sumRefunds() external view returns (uint256 total) {
    for (uint256 i; i < 4; i++) {
      total += auction.refunds(actors[i]);
    }
  }

  function _selector(bytes memory reason) private pure returns (bytes4 sel) {
    if (reason.length < 4) return bytes4(0);
    assembly {
      sel := mload(add(reason, 32))
    }
  }

  function _bubble(bytes memory reason) private pure {
    assembly {
      revert(add(reason, 32), mload(reason))
    }
  }

  // -------------------------------------------------------------------------
  // placeBidWrapper
  // -------------------------------------------------------------------------
  function placeBidWrapper(uint256 actorSeed, uint256 amountSeed) external {
    address actor = actors[bound(actorSeed, 0, 3)];

    // DEVIATION assumee (hors des cinq durcissements du brief, requise pour que
    // la garde de vacuite d'`afterInvariant()` soit saine). La fenetre
    // d'enchere ne couvre que `auctionWindow` secondes sur `epochDuration`
    // (900 sur 14400, 6,25 %). `warpWrapper` promene le temps librement ; a
    // `depth: 250` un run entier peut ne jamais retomber dans une fenetre, et
    // toutes ses mises reverteraient `WindowClosed` (attrape). `afterInvariant()`
    // s'executant PAR RUN avec remise a zero des compteurs entre runs (verifie),
    // ce run vacue ferait tomber `assertGt(placeBidsOk, 0)` a tort. Sans ce
    // recalage, les briefs §1 (assert de vacuite) et §4 (`runs:64/depth:250`)
    // sont incompatibles. On avance donc jusqu'a la prochaine ouverture de
    // fenetre quand la fenetre courante est fermee ; `warpWrapper` garde tout
    // son role (rotation d'epoch aleatoire, chemins `EpochAlreadyStarted` /
    // slot perime), et le `catch WindowClosed` reste un filet (une mise hors
    // fenetre sur le meme epoch, avant reinitialisation, y tombe encore).
    // La borne haute de fenetre est `startOfEpoch(currentEpoch()) +
    // auctionWindow`, que `sellingEpoch` soit a jour ou perime (dans les deux
    // cas `sellingEpoch - 1 == currentEpoch()` apres reinitialisation).
    uint256 windowCloses =
      genesis + auction.currentEpoch() * epochDuration + auction.auctionWindow();
    if (block.timestamp >= windowCloses) {
      vm.warp(genesis + (auction.currentEpoch() + 1) * epochDuration);
    }

    // Etat pending AVANT l'appel : sert a alimenter `deadMrn` si cette mise
    // declenche une reinitialisation qui ecrase un pending non nul (voir plus
    // bas et l'entete de fichier).
    uint256 pendingBefore = auction.pendingAmount();

    // Reproduit l'ordre de `placeBid` : etape (1) reinitialisation par
    // comparaison PUIS etape (3) seuil. Si l'enchere va se reinitialiser au
    // debut du prochain `placeBid` (`sellingEpoch != currentEpoch() + 1`),
    // le `highBid` herite est mis a zero avant le calcul du seuil, donc le
    // seuil effectif retombe a `minOpeningBid` quel que soit l'ancien
    // `highBid`. On calcule le seuil EXACT ainsi : `amount >= min` par
    // construction, jamais de `BidTooLow`.
    bool willReset = auction.sellingEpoch() != auction.currentEpoch() + 1;
    uint256 effHighBid = willReset ? 0 : auction.highBid();
    uint256 floorBid = (effHighBid * auction.HIGH_BID_BPS()) / auction.BPS_DEN();
    uint256 minBid = floorBid < auction.minOpeningBid() ? auction.minOpeningBid() : floorBid;

    if (minBid > MAX_BID) {
      bidsSkippedHighFloor++;
      return;
    }

    uint256 amount = bound(amountSeed, minBid, minBid + BID_SPREAD);

    // Borne de solde. Le financement des acteurs est strictement non
    // croissant (la mise gagnante est brulee a 30 % et streamee a 70 %, elle
    // ne revient jamais), une longue salve l'epuise et `safeTransferFrom`
    // reverterait `ERC20InsufficientBalance`, hors de la liste des selecteurs
    // avales. On saute la mise EN AMONT : aucun revert n'est absorbe, aucun
    // selecteur nouveau n'est ajoute au `catch`.
    if (mrn.balanceOf(actor) < amount) {
      bidsSkippedFunding++;
      return;
    }

    // Cette mise, si elle passe, va declencher une reinitialisation
    // close -> open qui CAPTURE un `highBid` non nul dans `pendingAmount`.
    bool resetCarrying = willReset && auction.highBidder() != address(0);

    vm.prank(actor);
    try auction.placeBid(amount) {
      placeBidsOk++;
      if (resetCarrying) resetsObserved++;
      // `Auction.sol` placeBid (1) : la reinitialisation vient d'ecraser
      // `pendingAmount` par `highBid` (capture INCONDITIONNELLE tant que
      // `highBidder != address(0)`, ce que `resetCarrying` reproduit). Si
      // l'ancien `pendingAmount` etait non nul, il n'a PAS ete sorti du solde
      // et son epoch avait deja tourne (jamais reglable) : c'est du MRN mort.
      // Un `settle()` reussi avant ce point aurait remis `pendingBefore` a 0,
      // donc le garde `pendingBefore != 0` suffit a ne compter que du fige.
      if (resetCarrying && pendingBefore != 0) deadMrn += pendingBefore;
    } catch (bytes memory reason) {
      if (_selector(reason) == Auction.WindowClosed.selector) {
        windowClosedCatches++;
        return;
      }
      _bubble(reason);
    }
  }

  // -------------------------------------------------------------------------
  // settleWrapper
  // -------------------------------------------------------------------------
  function settleWrapper() external {
    try auction.settle() {
      settlesOk++;
    } catch (bytes memory reason) {
      bytes4 sel = _selector(reason);
      if (sel == Auction.NoBidToSettle.selector) {
        noBidToSettleCatches++;
        return;
      }
      if (sel == Pool.EpochAlreadyStarted.selector) {
        epochAlreadyStartedCatches++;
        return;
      }
      if (sel == Pool.ManagerAlreadySet.selector) {
        managerAlreadySetCatches++;
        return;
      }
      _bubble(reason);
    }
  }

  // -------------------------------------------------------------------------
  // withdrawRefundWrapper
  // -------------------------------------------------------------------------
  function withdrawRefundWrapper(uint256 actorSeed) external {
    address actor = actors[bound(actorSeed, 0, 3)];
    vm.prank(actor);
    try auction.withdrawRefund() {
      withdrawsOk++;
    } catch (bytes memory reason) {
      if (_selector(reason) == Auction.NoBidToRefund.selector) {
        noBidToRefundCatches++;
        return;
      }
      _bubble(reason);
    }
  }

  // -------------------------------------------------------------------------
  // warpWrapper — fait tourner les epochs (voir entete de fichier)
  // -------------------------------------------------------------------------
  function warpWrapper(uint256 dtSeed) external {
    uint256 dt = bound(dtSeed, 1, 2 * epochDuration);
    vm.warp(block.timestamp + dt);
    warps++;
  }
}

contract AuctionInvariantTest is Test {
  MockWrappedBTC internal wbtc;
  MockWrappedBTC internal cbbtc;
  MockWrappedBTC internal lbtc;
  Pool internal pool;
  MRN internal mrn;
  Auction internal auction;
  AuctionHandler internal handler;

  // Parametres figes sur les valeurs de production (cf. AuctionTestBase).
  uint256 internal constant AUCTION_WINDOW = 900;
  uint256 internal constant MAX_EXTENSION = 0;
  uint256 internal constant BID_SILENCE = 60;
  uint256 internal constant MIN_OPENING_BID = 1e18;

  address internal constant TREASURY = address(0xBEEF);
  uint256 internal constant SEED_PER_LEG = 1000e8;
  uint256 internal constant ACTOR_FUNDING = 1_000_000e18;

  function setUp() public {
    wbtc = new MockWrappedBTC("Wrapped BTC", "wBTC");
    cbbtc = new MockWrappedBTC("Coinbase BTC", "cbBTC");
    lbtc = new MockWrappedBTC("Lombard BTC", "lBTC");

    address[3] memory tokens = [address(wbtc), address(cbbtc), address(lbtc)];
    mrn = new MRN();
    pool = new Pool(tokens, 14400, 12, 1, 5, TREASURY, address(mrn), address(this));
    auction = new Auction(
      address(pool),
      address(mrn),
      AUCTION_WINDOW,
      MAX_EXTENSION,
      BID_SILENCE,
      MIN_OPENING_BID
    );
    pool.setAuction(address(auction));

    // Amorcage du pool : `_settle` appelle `pool.notifyRent`, qui n'entre
    // dans son chemin nominal (re-base du stream de loyer) que si
    // `totalSupply() > MINIMUM_LIQUIDITY`. Un seul `addLiquidity` a montants
    // egaux suffit : reserves [1000e8, 1000e8, 1000e8], totalSupply 3000e8.
    wbtc.mint(address(this), SEED_PER_LEG);
    cbbtc.mint(address(this), SEED_PER_LEG);
    lbtc.mint(address(this), SEED_PER_LEG);
    wbtc.approve(address(pool), type(uint256).max);
    cbbtc.approve(address(pool), type(uint256).max);
    lbtc.approve(address(pool), type(uint256).max);
    pool.addLiquidity(0, SEED_PER_LEG, 0);

    handler = new AuctionHandler(auction, mrn);

    // Financement des acteurs. Pousse par le deployeur MRN APRES la
    // construction du handler : le MRN pre-mint ne peut pas etre transfere
    // vers une adresse pas encore deployee, donc l'`approve` seul (qui ne
    // deplace rien) tient dans le constructeur, le `transfer` reste ici.
    // Aucun `deal` / `vm.store` sur le solde MRN : on teste la comptabilite
    // reelle.
    for (uint256 i; i < 4; i++) {
      mrn.transfer(handler.actors(i), ACTOR_FUNDING);
    }

    bytes4[] memory selectors = new bytes4[](4);
    selectors[0] = AuctionHandler.placeBidWrapper.selector;
    selectors[1] = AuctionHandler.settleWrapper.selector;
    selectors[2] = AuctionHandler.withdrawRefundWrapper.selector;
    selectors[3] = AuctionHandler.warpWrapper.selector;
    targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    targetContract(address(handler));
  }

  /// forge-config: default.invariant.failOnRevert = true
  /// forge-config: default.invariant.runs = 64
  /// forge-config: default.invariant.depth = 250
  function invariant_mrnCoversObligations() public view {
    uint256 held = mrn.balanceOf(address(auction));
    uint256 owed = handler.sumRefunds() + auction.pendingAmount() + auction.highBid();
    // EGALITE EXACTE, pas un `>=` : `deadMrn` capture le seul poste par lequel
    // `held` depasse le passif on-chain (pending ecrase par une seconde
    // reinitialisation, voir entete). La marge d'un `>=` croissait de facon
    // monotone et absorbait une sous-creance de `refunds` ; `==` la mord.
    assertEq(held, owed + handler.deadMrn());
  }

  // Garde de vacuite de campagne. `afterInvariant()` s'execute UNE FOIS PAR RUN
  // sous le runner EDR de Hardhat 3, avec remise a zero des compteurs du
  // handler entre runs (verifie : les compteurs somment a `depth` exactement,
  // identiques a `runs: 8` et `runs: 64`). Son echec fait echouer le test ;
  // les `console.log`, eux, sont invisibles sous ce runner.
  //
  // Le trou que ces asserts ferment : si `minBid > MAX_BID` des le premier
  // appel (ou toute autre rupture structurelle), aucune mise ne passe, `held
  // == owed == 0`, et un `assertGe(0, 0)` decoratif resterait vert sur toute
  // la campagne sans rien prouver. Trois chemins sensibles sont exiges dans
  // CHAQUE run, seuil `> 0` (jamais `>= 0`) :
  //   - `placeBidsOk`     : garanti — le premier `placeBidWrapper` d'un run
  //     reussit toujours (acteur finance, `minBid == minOpeningBid`, fenetre
  //     forcee ouverte par le recalage). C'est l'assert qui mord sur la
  //     vacuite `minBid > MAX_BID` : dans ce cas `placeBidsOk` reste 0 partout.
  //   - `resetsObserved`  : la transition close -> open, coeur du risque de
  //     double-comptage. Le recalage de `placeBidWrapper` la declenche a
  //     chaque franchissement d'epoch avec un enchérisseur debout ; observee
  //     dans les 64 runs, stable sur executions repetees.
  //   - `withdrawsOk`     : un refund credite puis tire ; idem, stable.
  //
  // `settlesOk` (settle NOMINAL) n'est PAS asserte ici, et c'est structurel,
  // pas un compromis de seuil. Un settle nominal exige `pendingEpoch == 0` au
  // moment de l'appel ; or des la premiere reinitialisation `placeBid` qui
  // porte un enchérisseur, le slot pending se remplit d'un mandat perime que
  // `_settle` ne peut plus jamais vider (il revert `EpochAlreadyStarted` AVANT
  // le zeroing), et chaque reinitialisation suivante ne fait que l'ecraser par
  // un autre mandat perime. Le settle nominal n'existe donc que dans la
  // fenetre initiale d'un run, avant la premiere reinitialisation portante :
  // le fuzzer l'y touche de facon dependante de la graine, jamais dans tous
  // les runs. Sa reachabilite est prouvee, elle, par
  // `test_handlerReachesResetAndStuckSettlePaths` et
  // `test_handlerReachesManagerAlreadySetPath`, qui asserts tous deux
  // `settlesOk == 1` juste apres un `placeBidWrapper`. DEVIATION vs brief §1
  // (qui en listait quatre), consignee au rapport.
  function afterInvariant() public view {
    assertGt(handler.placeBidsOk(), 0, "campagne vacue : aucune mise passee");
    assertGt(handler.resetsObserved(), 0, "campagne vacue : aucune transition close->open");
    assertGt(handler.withdrawsOk(), 0, "campagne vacue : aucun retrait de refund");

    console.log("placeBidsOk           ", handler.placeBidsOk());
    console.log("windowClosedCatches   ", handler.windowClosedCatches());
    console.log("settlesOk             ", handler.settlesOk());
    console.log("noBidToSettleCatches  ", handler.noBidToSettleCatches());
    console.log("epochAlreadyStarted   ", handler.epochAlreadyStartedCatches());
    console.log("managerAlreadySet     ", handler.managerAlreadySetCatches());
    console.log("withdrawsOk           ", handler.withdrawsOk());
    console.log("noBidToRefundCatches  ", handler.noBidToRefundCatches());
    console.log("warps                 ", handler.warps());
    console.log("resetsObserved        ", handler.resetsObserved());
    console.log("bidsSkippedHighFloor  ", handler.bidsSkippedHighFloor());
    console.log("bidsSkippedFunding    ", handler.bidsSkippedFunding());
    console.log("deadMrn               ", handler.deadMrn());
  }

  // -------------------------------------------------------------------------
  // Tests deterministes de couverture : prouvent que chaque chemin sensible
  // du handler est ATTEIGNABLE, independamment de la campagne de fuzz. Meme
  // role que test_managerPathIsActiveAndConserves dans Pool.invariant.t.sol.
  // -------------------------------------------------------------------------

  // close -> open : une enchere fermee laisse `highBid` en place, le premier
  // `placeBid` de l'epoch suivant capture ce montant dans `pendingAmount`
  // puis remet `highBid` a zero. `settle` sur ce pending revert
  // `EpochAlreadyStarted` (l'epoch a tourne). L'invariant tient a chaque pas.
  function test_handlerReachesResetAndStuckSettlePaths() public {
    handler.placeBidWrapper(0, 0); // acteur 0 : mise plancher pour l'epoch 1
    handler.settleWrapper(); // settle nominal : managerOf[1] = acteur 0
    assertEq(handler.settlesOk(), 1, "un settle nominal doit passer");
    invariant_mrnCoversObligations();

    handler.placeBidWrapper(1, 0); // acteur 1 : nouvelle mise, meme epoch 1
    handler.warpWrapper(type(uint256).max); // +2 epochs -> currentEpoch 2
    handler.placeBidWrapper(2, 0); // reset close -> open, pending = mise acteur 1
    assertGe(handler.resetsObserved(), 1, "une transition close->open doit etre observee");
    invariant_mrnCoversObligations();

    handler.settleWrapper(); // _settle -> pool.setManager(1,..) -> EpochAlreadyStarted
    assertGe(
      handler.epochAlreadyStartedCatches(),
      1,
      "settle d'un pending dont l'epoch a tourne doit reverter EpochAlreadyStarted"
    );
    invariant_mrnCoversObligations();
  }

  // Un `settle` reussi nomme le gestionnaire de l'epoch. De nouvelles mises
  // sur la MEME `sellingEpoch` (aucun warp) puis un second `settle` retentent
  // `pool.setManager` sur l'epoch deja pourvue -> `ManagerAlreadySet`.
  function test_handlerReachesManagerAlreadySetPath() public {
    handler.placeBidWrapper(0, 0); // acteur 0 : mise pour l'epoch 1
    handler.settleWrapper(); // settle nominal : managerOf[1] = acteur 0
    assertEq(handler.settlesOk(), 1, "un settle nominal doit passer");

    handler.placeBidWrapper(1, 12345); // acteur 1 : nouvelle mise, meme epoch 1, pas de warp
    handler.settleWrapper(); // _settle -> pool.setManager(1, acteur1) -> ManagerAlreadySet
    assertGe(
      handler.managerAlreadySetCatches(),
      1,
      "un second settle sur une epoch deja pourvue doit reverter ManagerAlreadySet"
    );
    invariant_mrnCoversObligations();
  }

  // Un encherisseur depasse est CREDITE dans `refunds` (jamais pousse), puis
  // tire son du par `withdrawRefund`. L'invariant couvre le refund tant qu'il
  // est credite, et le solde suit exactement le tirage.
  function test_handlerReachesRefundAndWithdrawPaths() public {
    handler.placeBidWrapper(0, 0); // acteur 0 : mise plancher
    handler.placeBidWrapper(1, type(uint256).max); // acteur 1 : surenchere -> acteur 0 credite
    assertGt(handler.sumRefunds(), 0, "un encherisseur depasse doit etre credite");
    invariant_mrnCoversObligations();

    handler.withdrawRefundWrapper(0); // acteur 0 tire son refund
    assertEq(handler.withdrawsOk(), 1, "le tirage du refund doit passer");
    assertEq(handler.sumRefunds(), 0, "refund a zero apres tirage");
    invariant_mrnCoversObligations();
  }

  // NoBidToSettle : slot vide, aucune enchere courante -> settle idempotent.
  function test_handlerReachesNoBidToSettlePath() public {
    handler.settleWrapper(); // aucune mise nulle part
    assertGe(handler.noBidToSettleCatches(), 1, "settle sur slot vide doit reverter NoBidToSettle");

    handler.withdrawRefundWrapper(2); // acteur 2 sans refund credite
    assertGe(handler.noBidToRefundCatches(), 1, "withdrawRefund sans credit doit reverter NoBidToRefund");
    invariant_mrnCoversObligations();
  }

  // Les TROIS termes du passif non nuls SIMULTANEMENT, avec `sumRefunds()`
  // porte par DEUX entrees distinctes. Prouve que l'invariant n'est pas tenu
  // par un etat ou deux termes sur trois sont a zero. Tous les `amountSeed`
  // valent 0 : `bound(0, minBid, minBid + BID_SPREAD) == minBid`, les montants
  // sont donc exactement le seuil, calculables a la main.
  //
  //   minOpeningBid = 1e18 ; HIGH_BID_BPS/BPS_DEN = 11000/10000 = 1,1.
  //   floorBid(h) = h * 11000 / 10000.
  //
  //   1. acteur 0, enchere vide  -> seuil = minOpeningBid          = 1,00e18
  //        highBid = 1,00e18 ; held = 1,00e18
  //   2. acteur 1, floor(1,00e18)= 1,10e18 -> refunds[a0] += 1,00e18
  //        highBid = 1,10e18 ; held = 2,10e18 ; sumRefunds = 1,00e18 (1 entree)
  //   3. acteur 2, floor(1,10e18)= 1,21e18 -> refunds[a1] += 1,10e18
  //        highBid = 1,21e18 ; held = 3,31e18 ; sumRefunds = 2,10e18 (2 entrees)
  //   4. warp +2 epochs -> currentEpoch() = 2, sellingEpoch (1) perime.
  //   5. acteur 3 : la reinitialisation close -> open capture la mise
  //      d'acteur 2 dans pendingAmount (highBidder != 0 au reset), remet
  //      highBid a zero, puis seuil = minOpeningBid = 1,00e18.
  //        pendingAmount = 1,21e18 ; highBid = 1,00e18 ; held = 4,31e18
  //        pendingBefore lu = 0 (aucun pending anterieur)  -> deadMrn = 0
  //
  //   A ce point : sumRefunds = 2,10e18 > 0 (2 entrees) ; pendingAmount =
  //   1,21e18 > 0 ; highBid = 1,00e18 > 0.
  //   owed = 2,10e18 + 1,21e18 + 1,00e18 = 4,31e18 = held. Egalite au wei.
  function test_threeLiabilityTermsNonZeroTogether() public {
    handler.placeBidWrapper(0, 0); // 1. acteur 0 : mise plancher, epoch 1
    handler.placeBidWrapper(1, 0); // 2. acteur 1 : surenchere -> acteur 0 credite
    handler.placeBidWrapper(2, 0); // 3. acteur 2 : surenchere -> acteur 1 credite

    assertEq(handler.sumRefunds(), 2.1e18, "deux refunds credites : 1,00e18 + 1,10e18");
    assertEq(auction.refunds(address(0xA11CE)), 1e18, "refund acteur 0");
    assertEq(auction.refunds(address(0xB0B)), 1.1e18, "refund acteur 1");
    invariant_mrnCoversObligations();

    handler.warpWrapper(type(uint256).max); // 4. +2 epochs -> currentEpoch 2
    handler.placeBidWrapper(3, 0); // 5. acteur 3 : reset close->open capture acteur 2

    assertGe(handler.resetsObserved(), 1, "une transition close->open doit etre observee");
    assertEq(handler.deadMrn(), 0, "aucun pending anterieur ecrase : deadMrn nul");

    // Les trois termes non nuls SIMULTANEMENT.
    assertEq(handler.sumRefunds(), 2.1e18, "terme 1 : sumRefunds, 2 entrees");
    assertEq(auction.pendingAmount(), 1.21e18, "terme 2 : pendingAmount = mise acteur 2");
    assertEq(auction.highBid(), 1e18, "terme 3 : highBid = mise acteur 3");

    assertEq(
      mrn.balanceOf(address(auction)),
      4.31e18,
      "held = 1,00 + 1,10 + 1,21 + 1,00 (en e18)"
    );
    invariant_mrnCoversObligations();
  }
}
