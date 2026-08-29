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
// de l'Auction depasse son passif on-chain d'un poste unique et mesurable.
// AUDIT F1 : un mandat capture par une reinitialisation `placeBid` dont
// l'epoch a deja tourne est desormais REGLABLE — `_settle` detecte l'epoch
// perimee, credite integralement `refunds[pendingBidder]` et purge le slot,
// la ou il revertait `EpochAlreadyStarted` a jamais. Ce MRN-la n'est donc
// plus mort : il figure dans `pendingAmount` avant le reglement et dans
// `refunds` apres, le passif on-chain le couvre des deux cotes. Le poste
// residuel est ailleurs : quand une SECONDE reinitialisation ecrase
// `pendingAmount` avec la mise de l'enchere suivante sans sortir l'ancienne
// (`Auction.sol` placeBid (1) : la capture `pendingEpoch = sellingEpoch;
// pendingAmount = highBid;` est inconditionnelle des lors que `highBidder !=
// address(0)` au reset), le MRN de l'ancien pending reste immobilise dans
// l'Auction sans obligation en face. Le handler ACCUMULE exactement ces
// montants ecrases dans `deadMrn`, un par un, a l'instant ou la
// reinitialisation les rend intracables (la capture ecrase aussi
// `pendingBidder`, donc plus personne ne peut reclamer l'ancien montant :
// c'est ce que le correctif F1 ne repare PAS, et que ce compteur mesure).
// `owed + deadMrn` couvre alors la totalite du solde au wei pres, et
// l'egalite devient discriminante : une
// mutation cote passif (retirer un `refunds[x] +=`, un `pendingAmount =`)
// casse `held == owed + deadMrn` la ou un `>=` a marge croissante l'aurait
// absorbee. `deadMrn` ne compte QUE du MRN reellement fige : la part 30/70 de
// l'ancien pending n'a jamais ete extraite (un `_settle` sur une epoch
// perimee ne brule rien et ne verse aucun loyer) et son beneficiaire a ete
// efface du slot par la capture suivante. Aucun MRN encore reglable ou
// remboursable n'y entre.
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
//     (900 s apres le debut de l'epoch vendue) est fermee. CODE MORT EN
//     CAMPAGNE : le recalage de fenetre en tete de `placeBidWrapper` (voir la
//     DEVIATION documentee la-bas) precede TOUJOURS le calcul du seuil et
//     l'appel `placeBid`, et il avance le temps jusqu'a la prochaine
//     ouverture des que la fenetre courante est fermee. Aucun chemin du
//     handler ne referme la fenetre entre ce recalage et l'appel : le fuzzer
//     ne peut donc pas atteindre `WindowClosed`, et `windowClosedCatches`
//     reste structurellement 0 (verifie sur executions repetees). Le `catch`
//     est conserve UNIQUEMENT comme garde defensive : si un futur changement
//     retirait ou deplacait le recalage, une mise hors fenetre redeviendrait
//     possible et ce revert legitime ne doit pas casser la campagne.
//     `WindowClosed` reste couvert positivement par `Auction.test.ts` I] C).
//   settleWrapper       : Auction.NoBidToSettle       — aucun mandat en
//     attente et aucune enchere courante a capturer (slot vide, degradation
//     R7) ; c'est l'idempotence documentee de `settle`.
//   settleWrapper       : Auction.WindowStillOpen     — AUDIT F3. La
//     capture d'une enchere VIVE exige desormais que la fenetre de mise
//     du mandat vendu soit fermee (`block.timestamp >=
//     startOfEpoch(sellingEpoch - 1) + auctionWindow`). Le fuzzer appelle
//     `settle` a des instants quelconques, dont beaucoup tombent dans la
//     fenetre : c'est un revert LEGITIME, la degradation attendue d'un
//     bot qui regle trop tot. Le chemin de reglement d'un `pendingEpoch`
//     deja capture n'est PAS soumis a cette garde.
//   settleWrapper       : Pool.EpochAlreadyStarted    — CODE MORT depuis
//     l'AUDIT F1. `_settle` intercepte lui-meme `pendingEpoch <=
//     currentEpoch()` et rembourse au lieu d'appeler `setManager` ; et sur
//     le chemin nominal `pendingEpoch == sellingEpoch == currentEpoch() +
//     1`, strictement futur. Le `catch` est conserve comme garde
//     defensive : si un futur changement retirait la branche perimee de
//     `_settle`, ce revert redeviendrait atteignable et ne doit pas
//     casser la campagne.
//   settleWrapper       : Pool.ManagerAlreadySet      — CODE MORT, pour
//     DEUX raisons distinctes qu'il faut tenir ensemble. (1) AUDIT F3 :
//     une double nomination exigeait un second `settle` sur la MEME
//     `sellingEpoch` apres de nouvelles mises ; or `settle` n'est accepte
//     qu'une fois la fenetre fermee, et `placeBid` est refuse des ce meme
//     instant (`WindowClosed`), donc aucune mise ne peut plus tomber sur
//     une epoch deja reglee, les deux phases sont disjointes. (2) F3 ne
//     suffit PAS a lui seul : une epoch strictement future peut avoir ete
//     pourvue par la voie d'amorcage de l'owner, que F6 borne a
//     `currentEpoch() + 1` sans la lui interdire. C'est `_settle` qui
//     ferme ce second chemin, en traitant un `pendingEpoch` deja pourvu
//     comme un mandat perime : remboursement et purge, jamais d'appel a
//     `setManager`. `catch` defensif, meme raison que ci-dessus ; la
//     garde du Pool reste couverte positivement par
//     test/Pool.manager.test.ts, qui l'atteint par la voie owner en
//     appelant `setManager` deux fois sur la meme epoch ; et le
//     remboursement qui la rend inatteignable depuis l'enchere est
//     epingle par AuctionAlreadyNominatedMandateTest
//     (test/Auction.security.t.sol) et par AuctionManagerCouplingTest
//     (contracts/Auction.t.sol), qui n'attendent plus de revert.
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
  // AUDIT F3 : nouveau revert legitime sur `settle` (fenetre de mise
  // encore ouverte). Voir la liste des selecteurs avales en entete.
  uint256 public windowStillOpenCatches;
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
    // slot perime). Ce recalage precede TOUJOURS le calcul du seuil et l'appel
    // `placeBid`, et aucun chemin du handler ne referme la fenetre entre les
    // deux : le `catch WindowClosed` plus bas est donc du CODE MORT en
    // campagne, `windowClosedCatches` reste structurellement 0. Il n'est
    // conserve que comme garde defensive si un futur changement retirait ou
    // deplacait ce recalage (cf. entete de fichier). `WindowClosed` est
    // couvert positivement par `Auction.test.ts` I] C).
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
      if (sel == Auction.WindowStillOpen.selector) {
        windowStillOpenCatches++;
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
  // Le trou que cette assert ferme : si `minBid > MAX_BID` des le premier
  // appel (ou toute autre rupture structurelle), aucune mise ne passe, `held
  // == owed == 0`, et un `assertGe(0, 0)` decoratif resterait vert sur toute
  // la campagne sans rien prouver. Un seul chemin sensible est exige dans
  // CHAQUE run, seuil `> 0` (jamais `>= 0`) :
  //   - `placeBidsOk`     : garanti — le premier `placeBidWrapper` d'un run
  //     reussit toujours (acteur finance, `minBid == minOpeningBid`, fenetre
  //     forcee ouverte par le recalage). C'est l'assert qui mord sur la
  //     vacuite `minBid > MAX_BID` : dans ce cas `placeBidsOk` reste 0 partout.
  //
  // I.7 #13 : les deux autres asserts de la version precedente
  // (`resetsObserved`, `withdrawsOk`) sont passes en deterministe. Ils
  // dependent de l'ordre des tirages du fuzzer, et une graine
  // malheureuse les laisse a zero sur 64 runs : le test rougit alors
  // sans qu'aucun defaut reel n'existe. La couverture de ces deux
  // chemins est assuree par les tests deterministes a la fin de ce
  // fichier, qui les exercent explicitement :
  //   - `test_handlerReachesResetAndExpiredSettlePaths` : `resetsObserved >= 1`
  //   - `test_handlerReachesRefundAndWithdrawPaths`  : `withdrawsOk == 1`
  // L'assertion structurelle au niveau run reste sur `placeBidsOk`, qui
  // est l'indicateur de vacuite, et l'indicateur de reellement.
  //
  // `settlesOk` (settle NOMINAL) n'est PAS asserte ici, et c'est structurel,
  // pas un compromis de seuil. AUDIT F3 : un settle nominal exige desormais
  // DEUX coincidences a l'instant de l'appel — `pendingEpoch == 0` (sinon
  // on part sur le chemin du slot capture) et une fenetre de mise deja
  // fermee mais une epoch pas encore tournee, soit une cible de
  // `epochDuration - auctionWindow` secondes qu'il faut atteindre avec un
  // slot vide. `warpWrapper` promene le temps librement : le fuzzer y tombe
  // de facon dependante de la graine, jamais dans tous les runs.
  //
  // AUDIT F1 : la raison invoquee ici auparavant n'est plus la bonne. Le
  // slot pending n'est plus un cul-de-sac — `_settle` sait vider un mandat
  // perime en remboursant son enchérisseur — mais la conclusion sur
  // `settlesOk` tient, pour la raison de fenetre ci-dessus. Sa
  // reachabilite est prouvee par
  // `test_handlerReachesResetAndExpiredSettlePaths` et
  // `test_aDoubleNominationIsStructurallyUnreachable`, qui asserts tous
  // deux `settlesOk == 1`. DEVIATION vs brief §1 (qui en listait quatre),
  // consignee au rapport.
  function afterInvariant() public view {
    assertGt(handler.placeBidsOk(), 0, "campagne vacue : aucune mise passee");

    console.log("placeBidsOk           ", handler.placeBidsOk());
    console.log("windowClosedCatches   ", handler.windowClosedCatches());
    console.log("settlesOk             ", handler.settlesOk());
    console.log("noBidToSettleCatches  ", handler.noBidToSettleCatches());
    console.log("windowStillOpen       ", handler.windowStillOpenCatches());
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
  // puis remet `highBid` a zero.
  //
  // AUDIT F1 + F3, deux changements dans ce test :
  //   - le `warpWrapper(901)` avant le premier `settleWrapper` est
  //     desormais EXIGE : `settle` refuse de capturer une enchere vive tant
  //     que la fenetre de mise n'est pas fermee (`WindowStillOpen`). 901 s
  //     est la premiere seconde apres `auctionWindow` (900 s), et
  //     `bound(901, 1, 2 * epochDuration)` rend 901 tel quel.
  //   - `settle` sur un pending perime ne revert plus
  //     `EpochAlreadyStarted` : il rembourse integralement son
  //     enchérisseur et purge le slot. C'est ce que le test epingle
  //     maintenant, et c'est la propriete qui empeche l'enchere de mourir.
  // L'invariant tient a chaque pas.
  function test_handlerReachesResetAndExpiredSettlePaths() public {
    handler.placeBidWrapper(0, 0); // acteur 0 : mise plancher pour l'epoch 1
    handler.warpWrapper(901); // ferme la fenetre de mise du mandat 1 (F3)
    handler.settleWrapper(); // settle nominal : managerOf[1] = acteur 0
    assertEq(handler.settlesOk(), 1, "un settle nominal doit passer");
    invariant_mrnCoversObligations();

    handler.placeBidWrapper(1, 0); // acteur 1 : mise sur le mandat suivant
    handler.warpWrapper(type(uint256).max); // +2 epochs : le mandat d'acteur 1 perime
    handler.placeBidWrapper(2, 0); // reset close -> open, pending = mise acteur 1
    assertGe(handler.resetsObserved(), 1, "une transition close->open doit etre observee");
    invariant_mrnCoversObligations();

    uint256 pendingAmountBefore = auction.pendingAmount();
    handler.settleWrapper(); // _settle -> branche perimee -> remboursement d'acteur 1

    assertEq(
      auction.refunds(handler.actors(1)),
      pendingAmountBefore,
      "F1 : le reglement d'un mandat perime doit rembourser integralement SON encherisseur"
    );
    invariant_mrnCoversObligations();
  }

  // AUDIT F3 : le chemin `ManagerAlreadySet` du handler est devenu
  // structurellement INATTEIGNABLE, et ce test le prouve plutot que de
  // l'affirmer. Une double nomination exigeait qu'une nouvelle mise tombe
  // sur une `sellingEpoch` deja reglee. Or `settle` n'est accepte qu'a
  // partir de `startOfEpoch(sellingEpoch - 1) + auctionWindow`, et
  // `placeBid` est refuse a partir du MEME instant : apres un reglement,
  // toute mise sur cette epoch heurte `WindowClosed`. Les deux phases sont
  // disjointes, il n'y a donc plus de second `settle` a tenter. La garde
  // `ManagerAlreadySet` du Pool reste couverte positivement par
  // test/Pool.manager.test.ts, par la voie owner (deux `setManager` sur
  // la meme epoch) : depuis l'AUDIT F1, aucun chemin de l'enchere ne
  // l'atteint plus, `_settle` rembourse au lieu de nommer.
  function test_aDoubleNominationIsStructurallyUnreachable() public {
    handler.placeBidWrapper(0, 0); // acteur 0 : mise pour l'epoch 1
    handler.warpWrapper(901); // ferme la fenetre de mise (F3)
    handler.settleWrapper(); // settle nominal : managerOf[1] = acteur 0
    assertEq(handler.settlesOk(), 1, "un settle nominal doit passer");

    // La mise qui aurait rouvert la porte. Aucun warp : `sellingEpoch`
    // vaut encore l'epoch tout juste reglee.
    //
    // Les deux lectures externes (`actors(1)`, `minOpeningBid()`) sont
    // HISSEES avant les cheatcodes, et ce n'est pas cosmetique. Solidity
    // evalue les arguments d'un appel AVANT l'appel lui-meme : ecrit
    // `auction.placeBid(auction.minOpeningBid())`, le `staticcall` a
    // `minOpeningBid()` devient le « prochain appel » que `vm.prank` et
    // `vm.expectRevert` interceptent. Il ne revert pas, et le test echoue
    // sur « next call did not revert as expected » sans avoir jamais
    // atteint `placeBid`.
    address bidder = handler.actors(1);
    uint256 openingBid = auction.minOpeningBid();

    vm.prank(bidder);
    vm.expectRevert(Auction.WindowClosed.selector);
    auction.placeBid(openingBid);
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

  // Couverture POSITIVE de `deadMrn`. Le test ci-dessus laisse `deadMrn == 0` :
  // une seule reinitialisation portante, sans pending anterieur a ecraser.
  // Ici on force une SECONDE reinitialisation portante, celle qui ecrase un
  // `pendingAmount` non nul et deja non reglable -> `deadMrn += pendingBefore`.
  //
  // Etapes 1 a 5 identiques a test_threeLiabilityTermsNonZeroTogether. Tous
  // les `amountSeed` valent 0, donc chaque mise vaut EXACTEMENT son seuil :
  //   minOpeningBid = 1e18 ; HIGH_BID_BPS / BPS_DEN = 11000 / 10000 = 1,1.
  //   1. acteur 0, enchere vide      -> 1,00e18
  //   2. acteur 1, floor(1,00e18)    -> 1,10e18   (refund acteur 0 += 1,00e18)
  //   3. acteur 2, floor(1,10e18)    -> 1,21e18   (refund acteur 1 += 1,10e18)
  //   4. warp +2 epochs (currentEpoch 0 -> 2)
  //   5. acteur 3 : reset close->open, capture la mise d'acteur 2 dans
  //      pendingAmount (1,21e18), highBid revient a minOpeningBid = 1,00e18.
  //      pendingBefore lu = 0  -> deadMrn reste 0.
  //   held = 1,00 + 1,10 + 1,21 + 1,00 = 4,31e18 (en e18).
  //
  // Etapes 6 et 7, l'ajout :
  //   6. warp +2 epochs (currentEpoch 2 -> 4) : `sellingEpoch` (3, pose par le
  //      reset de l'etape 5) devient perime, la prochaine mise reinitialisera.
  //   7. acteur 0, `placeBidWrapper(0, 0)` : SECONDE reinitialisation portante.
  //      `highBidder` == acteur 3 (non nul) au reset -> capture INCONDITIONNELLE
  //      `pendingAmount = highBid` : l'ancien `pendingAmount` (1,21e18, issu de
  //      la mise d'acteur 2, epoch 1 deja tournee, jamais reglable) est ECRASE
  //      par la mise d'acteur 3 (1,00e18) SANS etre sorti du solde. Le wrapper
  //      lit `pendingBefore = 1,21e18 != 0` et fait `deadMrn += 1,21e18`.
  //      Nouvelle mise d'acteur 0 : seuil = minOpeningBid = 1,00e18 (highBid
  //      remis a zero par le reset).
  //
  //   <mise acteur 2> = 1,21e18  (le pending ecrase).
  //   held  = 1,00 + 1,10 + 1,21 + 1,00 + 1,00 = 5,31e18
  //           (les 5 `safeTransferFrom` des 5 mises ; aucun settle, aucun
  //            withdraw : rien ne sort).
  //   owed  = sumRefunds + pendingAmount + highBid
  //         = 2,10e18   + 1,00e18       + 1,00e18 = 4,10e18
  //   owed + deadMrn = 4,10e18 + 1,21e18 = 5,31e18 == held. Egalite au wei.
  function test_deadMrnAccumulatesOnSecondCarryingReset() public {
    handler.placeBidWrapper(0, 0); // 1
    handler.placeBidWrapper(1, 0); // 2
    handler.placeBidWrapper(2, 0); // 3
    handler.warpWrapper(type(uint256).max); // 4. +2 epochs -> currentEpoch 2
    handler.placeBidWrapper(3, 0); // 5. 1re reinitialisation portante

    assertEq(handler.deadMrn(), 0, "1re reinit : aucun pending anterieur, deadMrn nul");
    assertEq(auction.pendingAmount(), 1.21e18, "pending = mise acteur 2");
    assertEq(mrn.balanceOf(address(auction)), 4.31e18, "held apres 4 mises");

    handler.warpWrapper(type(uint256).max); // 6. +2 epochs -> currentEpoch 4
    handler.placeBidWrapper(0, 0); // 7. 2e reinitialisation portante : ecrase le pending

    assertGe(handler.resetsObserved(), 2, "deux transitions close->open observees");
    assertEq(
      handler.deadMrn(),
      1.21e18,
      "pending d'acteur 2 (1,21e18) ecrase sans etre sorti : deadMrn"
    );
    assertEq(auction.pendingAmount(), 1e18, "pending ecrase par la mise d'acteur 3 (1,00e18)");
    assertEq(auction.highBid(), 1e18, "nouvelle mise d'acteur 0 = minOpeningBid");
    assertEq(handler.sumRefunds(), 2.1e18, "refunds inchanges : 1,00e18 + 1,10e18");
    assertEq(
      mrn.balanceOf(address(auction)),
      5.31e18,
      "held = 1,00 + 1,10 + 1,21 + 1,00 + 1,00 (en e18)"
    );

    // held == owed + deadMrn au wei : 5,31e18 == 4,10e18 + 1,21e18.
    invariant_mrnCoversObligations();
  }
}
