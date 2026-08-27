// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Pool} from "./Pool.sol";
import {MRN} from "./MRN.sol";
import {MockWrappedBTC} from "./MockWrappedBTC.sol";
import {Auction} from "./Auction.sol";

// Couche Solidity d'I.3 — la couche qui pose les invariants et l'etat sans
// dependre du reseau. Meme approche que Pool.feeInForce.t.sol : la couche
// TypeScript (test/Auction.test.ts) reproduit le parcours reeel d'un
// enchérisseur (approve MRN, transferFrom, lecture des events), et celle-ci
// force l'etat et verifie les proprietes mecaniques que la couche reseau
// ne peut pas formuler.
//
// Sections :
//   I]    Reinitialisation par comparaison (build-auction.md 4.5) ;
//   II]   Couplage Auction ↔ Pool : setManager et protection ;
//   III]  Burns, transfers et l'invariant MRN ;
//   IV]   CEI dans `withdrawRefund` (propriete documentee).
//
// Pourquoi un invariant Foundry `invariant_highBidResetsOnEpochRollover`
// n'est PAS livre ici : Foundry exige un handler dedie et une cible, et la
// reinitialisation par comparaison n'a de sens qu'apres un `placeBid` qui
// pose `sellingEpoch` a une valeur differente de `currentEpoch() + 1`. Un
// invariant Foundry rejoue apres chaque appel, ce qui demanderait ici un
// handler qui pose systematiquement un `highBid > 0` avant chaque
// rollover. La section I utilise a la place un test manuel qui avance
// l'horloge et verifie l'etat apres le premier `placeBid` du nouveau
// mandat. C'est acceptable pour I.3 (le brief le mentionne explicitement) et
// ca deplace le cout du handler a l'etape ou il aura un sens (quand le
// pot MRN sera a streamer, et que l'invariant I4 de build-auction.md 7.2
// rentrera dans le runner).

abstract contract AuctionTestBase is Test {

  MockWrappedBTC public wbtc;
  MockWrappedBTC public cbbtc;
  MockWrappedBTC public lbtc;
  Pool public pool;
  MRN public mrn;
  Auction public auction;

  // Les quatre parametres du constructeur Auction figes sur les valeurs
  // de production. Ils sont poses ici en `constant` pour qu'un changement
  // de la valeur de deploiement casse les tests plutot que de les laisser
  // passer en silence.
  uint256 internal constant AUCTION_WINDOW = 900; // 15 min
  uint256 internal constant MAX_EXTENSION = 0; // A1 roadmap
  uint256 internal constant BID_SILENCE = 60; // fenetre de settle avant fin d'epoch
  uint256 internal constant MIN_OPENING_BID = 1e18; // 1 MRN a 18 decimales

  // Le prix d'ouverture au-dessus de MIN_OPENING_BID. C'est la valeur
  // qu'utilise `placeBid` quand une enchere est deja ouverte, parce que
  // `MIN_OPENING_BID` est strictement inferieur a la hausse minimale de
  // +10 % sur une mise plus haute. Voir 5.3 (3) : `placeBid` prend
  // `max(MIN_OPENING_BID, highBid * 11 / 10)`, et toute enchere succes-
  // sive passe par la branche `highBid * 11 / 10`.
  uint256 internal constant FIRST_BID = 2e18; // 2 MRN

  address internal constant BIDDER_A = address(uint160(0xA11CE));
  address internal constant BIDDER_B = address(uint160(0xB0B));
  address internal constant TREASURY = address(0xBEEF);

  function setUp() public virtual {
    wbtc = new MockWrappedBTC("Wrapped BTC", "wBTC");
    cbbtc = new MockWrappedBTC("Coinbase BTC", "cbBTC");
    lbtc = new MockWrappedBTC("Lombard BTC", "lBTC");

    address[3] memory tokens = [address(wbtc), address(cbbtc), address(lbtc)];
    pool = new Pool(tokens, 14400, 12, 1, 5, TREASURY, address(this));

    mrn = new MRN();
    auction = new Auction(address(pool), address(mrn), AUCTION_WINDOW, MAX_EXTENSION, BID_SILENCE, MIN_OPENING_BID);

    pool.setAuction(address(auction));

    // Le deployer recoit tout le MRN mint. Les bidders sont finances par
    // `vm.deal`-equivalent : ils recoivent directement du MRN par
    // `mrn.transfer`, ce qui leur permet d'approuver et d'encherir sans
    // dance d'allowance orchestr ee par le contrat de test.
    uint256 bidderFunding = 1_000_000 * 1e18; // 1M MRN, plus que suffisant
    mrn.transfer(BIDDER_A, bidderFunding);
    mrn.transfer(BIDDER_B, bidderFunding);

    vm.prank(BIDDER_A);
    mrn.approve(address(auction), type(uint256).max);

    vm.prank(BIDDER_B);
    mrn.approve(address(auction), type(uint256).max);
  }

  // Pose un bid de la part de `bidder` pour `amount`. Le contrat de test
  // est `address(this)`, mais le prank garantit que `msg.sender` vu par
  // l'Auction est `bidder`. Voir Pool.feeInForce.t.sol pour la meme
  // convention.
  function _bidAs(address bidder, uint256 amount) internal {
    vm.prank(bidder);
    auction.placeBid(amount);
  }

  // Place l'horloge au premier instant de l'epoch `epoch`.
  function _warpToEpoch(uint256 epoch) internal {
    vm.warp(pool.GENESIS() + epoch * pool.EPOCH_DURATION());
  }

  // Place l'horloge a 1 seconde avant le debut de l'epoch `epoch`,
  // c'est-a-dire 1 seconde avant la fin de l'epoch `epoch - 1`. C'est
  // la fenetre BID_SILENCE de l'enchere pour le mandat `epoch` : le
  // bot peut y appeler `settle()` pendant que `currentEpoch()` est
  // encore l'ancienne epoch, et la garde `_epoch > currentEpoch()` du
  // Pool (I.1) tient. Le `epoch` passe en argument est le `sellingEpoch`
  // (le mandat mis aux encheres), pas l'epoch courante.
  function _warpToBidSilenceWindow(uint256 epoch) internal {
    vm.warp(pool.GENESIS() + epoch * pool.EPOCH_DURATION() - 1);
  }
}

// ---------------------------------------------------------------------------
// I] Reinitialisation par comparaison (build-auction.md 4.5)
//
// Le reset est pose au debut de `placeBid`, par comparaison a
// `currentEpoch() + 1`. Un `highBid > 0` pose pour un mandat qui n'est
// PLUS le mandat courant ne doit pas survivre au premier `placeBid` du
// nouveau mandat, sinon le second mandat herite du plancher du premier
// (et il faudrait alors miser strictement au-dessus de l'ancien `highBid`,
// pas au-dessus de `MIN_OPENING_BID`).
// ---------------------------------------------------------------------------

contract AuctionEpochResetTest is AuctionTestBase {

  function test_HighBidResetsOnEpochRollover() public {
    // Mandat 0, l'enchere du mandat 1. BIDDER_A pose 2 MRN. Le slot
    // `highBid` est non nul.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);
    assertEq(auction.highBid(), FIRST_BID, "highBid doit valoir 2 MRN apres la mise initiale");

    // On avance au mandat 1 (la fenetre du mandat 1 est ouverte). Aucun
    // bid n'a ete pose sur l'enchere du mandat 2.
    _warpToEpoch(1);

    // Calcul a la main : sur l'enchere du mandat 2,
    // `sellingEpoch == 1` mais `currentEpoch() + 1 == 2`. La comparaison
    // de la reinitialisation echoue, le slot est rouvert a zero, et
    // `highBid` passe a 0. La mise de 2 MRN * 110 / 100 = 2.2 MRN - 1
    // wei doit donc passer, ce qu'elle ne ferait PAS si le slot
    // portait encore l'ancien 2 MRN.
    _bidAs(BIDDER_B, 2e18 + 1);

    assertEq(
      auction.highBid(),
      2e18 + 1,
      "apres rollover, highBid doit avoir ete remis a zero : la mise tient, pas une deuxieme fois 2.2 MRN"
    );
  }

  function test_RefundsAreNotClearedByTheEpochRollover() public {
    // L'enchere du mandat 1 : BIDDER_A pose 2 MRN, BIDDER_B enchérit
    // au-dessus et le dépasse. BIDDER_A est crédité dans `refunds`.
    // Le seuil pour la surenchere est `highBid * 11/10 = 2.2 MRN` (avec
    // HIGH_BID_BPS = 11000, voir commentaire dans Auction.sol).
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);
    _bidAs(BIDDER_B, (FIRST_BID * 11) / 10);
    assertEq(auction.refunds(BIDDER_A), FIRST_BID, "BIDDER_A doit etre credite de 2 MRN");

    // On avance au mandat 1, on enchérit sur le mandat 2. La
    // reinitialisation par comparaison a efface `highBid`, `highBidder`
    // et `sellingEpoch`, mais les `refunds` sont préservés.
    _warpToEpoch(1);
    _bidAs(BIDDER_A, MIN_OPENING_BID);

    assertEq(
      auction.refunds(BIDDER_A),
      FIRST_BID,
      "les refunds ne sont PAS effaces par la reinitialisation : BIDDER_A peut toujours tirer"
    );
  }
}

// ---------------------------------------------------------------------------
// II] Couplage Auction ↔ Pool
//
// `_settle()` appelle `pool.setManager(pendingEpoch, highBidder)` (R3). Ce
// couplage tient le mandat suivant designé au moment du basculement de
// l'enchere, et c'est ce qui rend la charge "prise par le passage du temps"
// et non par une transaction de reglement. La section verifie :
//
//   - `managerOf[sellingEpoch]` reste a `address(0)` pendant toute la duree
//     de l'enchere (avant settle) ;
//   - `managerOf[sellingEpoch]` est sette au `highBidder` du moment, par
//     `_settle`, qui peut etre auto (a l'ouverture d'une nouvelle enchere)
//     ou externe (par n'importe quel tiers) ;
//   - un settle sur un mandat où `managerOf` est déjà posé revert
//     `ManagerAlreadySet` (la garde de Pool.sol), ce qui est la protection
//     du Pool contre une double nomination, et c'est le test qu'un deuxieme
//     appel a `pool.setManager` est bien bloque.
// ---------------------------------------------------------------------------

contract AuctionManagerCouplingTest is AuctionTestBase {

  function test_ManagerNotDesignatedDuringAuction() public {
    // Avant l'enchere, aucun manager n'est designé.
    _warpToEpoch(0);
    assertEq(pool.managerOf(1), address(0), "managerOf[1] doit etre vide avant toute enchere");

    _bidAs(BIDDER_A, FIRST_BID);
    // APRES le placeBid, la nomination n'est toujours pas faite : la
    // garde ManagerAlreadySet du Pool tient, et le front lit
    // `auction.highBidder()` pour afficher le meneur courant.
    assertEq(
      pool.managerOf(1),
      address(0),
      "managerOf[1] doit rester address(0) pendant l'enchere, avant settle"
    );
    // Sanity check : le meneur COURANT de l'enchere est bien BIDDER_A.
    assertEq(
      auction.highBidder(),
      BIDDER_A,
      "highBidder doit etre BIDDER_A pendant la fenetre, distinct du manager-designate futur"
    );

    // Meme apres une surenchere : managerOf[1] reste vide.
    _bidAs(BIDDER_B, (FIRST_BID * 11) / 10);
    assertEq(
      pool.managerOf(1),
      address(0),
      "managerOf[1] reste address(0) apres une surenchere : setManager n'est pas appele par placeBid"
    );
    assertEq(
      auction.highBidder(),
      BIDDER_B,
      "highBidder doit etre BIDDER_B apres la surenchere"
    );
  }

  function test_LastBidderIsManagerDesignateAfterSettle() public {
    // Sequence complete : BIDDER_A pose la mise initiale, BIDDER_B la
    // surenchere, et le bot appelle `settle()` pendant la fenetre
    // BID_SILENCE de l'epoch 0. C'est le DERNIER enchérisseur du
    // mandat 1 qui est designe, pas le premier : voir point (3) de
    // l'entete d'Auction.sol.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);
    _bidAs(BIDDER_B, (FIRST_BID * 11) / 10);
    assertEq(
      pool.managerOf(1),
      address(0),
      "managerOf[1] doit etre address(0) apres les placeBid, avant settle"
    );

    // Le bot appelle `settle()` pendant la fenetre BID_SILENCE, avant
    // que l'epoch ne tourne. Le `settle` capture l'enchere courante
    // (slot pending vide) et appelle `pool.setManager(1, BIDDER_B)`.
    // settle est permissionless, le contrat de test appelle directement.
    _warpToBidSilenceWindow(1);
    auction.settle();

    assertEq(
      pool.managerOf(1),
      BIDDER_B,
      "managerOf[1] doit etre BIDDER_B, le dernier encherisseur au moment du settle"
    );
  }

  function test_ExternalSettleAlsoDesignatesTheLastBidder() public {
    // Le `settle()` externe, appele par n'importe qui, doit lui aussi
    // designer le dernier enchérisseur. On pose une mise sur le mandat
    // 1, on l'appelle directement, et on verifie que managerOf[1] est
    // l'unique enchérisseur. Le contrat de test n'a pas besoin d'un
    // prank ici : `settle` est permissionless.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);

    auction.settle();

    assertEq(
      pool.managerOf(1),
      BIDDER_A,
      "managerOf[1] doit etre BIDDER_A, le DERNIER (et seul) encherisseur du mandat 1 au moment du settle"
    );
  }

  function test_SettleOnAlreadyManagedEpochReverts() public {
    // Le Pool porte la garde `managerOf[epoch] != address(0)` (Pool.sol
    // I.1). Pour tester la protection depuis l'Auction, on deploie
    // un pool isole avec un manager pose par bootstrap pour l'epoch 1,
    // puis on branche l'enchere par `setAuction`. Une fois la voie
    // bootstrap fermee, l'enchere ne peut plus ecrire dans
    // `managerOf[1]`. Le test verifie qu'un `settle()` externe
    // (appele pendant la fenetre BID_SILENCE) reverte bien
    // `ManagerAlreadySet` : c'est la protection du Pool contre une
    // double nomination par l'enchere.
    wbtc = new MockWrappedBTC("Wrapped BTC", "wBTC");
    cbbtc = new MockWrappedBTC("Coinbase BTC", "cbBTC");
    lbtc = new MockWrappedBTC("Lombard BTC", "lBTC");
    address[3] memory tokens = [address(wbtc), address(cbbtc), address(lbtc)];
    Pool localPool = new Pool(tokens, 14400, 12, 1, 5, TREASURY, address(this));
    Auction localAuction = new Auction(
      address(localPool),
      address(mrn),
      AUCTION_WINDOW,
      MAX_EXTENSION,
      BID_SILENCE,
      MIN_OPENING_BID
    );

    // Voie bootstrap : le contrat de test est owner, `auction` n'est
    // pas encore branchee, on pose un manager pour l'epoch 1.
    localPool.setManager(1, address(0xDEAD));

    // Maintenant on branche l'enchere : la voie bootstrap se ferme.
    localPool.setAuction(address(localAuction));

    // BIDDER_A doit avoir une allowance sur la nouvelle Auction.
    vm.prank(BIDDER_A);
    mrn.approve(address(localAuction), type(uint256).max);

    // BIDDER_A pose une mise sur l'enchere du mandat 1. Le `placeBid`
    // ne doit PAS reverter — `setManager` n'est pas appele ici, et
    // c'est precisement ce que le design defend.
    _warpToEpoch(0);
    vm.prank(BIDDER_A);
    localAuction.placeBid(FIRST_BID);
    assertEq(
      localPool.managerOf(1),
      address(0xDEAD),
      "placeBid ne doit PAS modifier managerOf[1] : la nomination est reportee a settle"
    );

    // Le bot appelle `settle()` pendant la fenetre BID_SILENCE. Le
    // `settle` capture l'enchere courante et appelle `_settle`, qui
    // appelle `pool.setManager(1, highBidder)`. Comme
    // `managerOf[1] == 0xDEAD` deja, le `_settle` reverte
    // `ManagerAlreadySet` : c'est la garde de Pool.sol qui tient.
    _warpToBidSilenceWindow(1);
    vm.expectRevert(Pool.ManagerAlreadySet.selector);
    localAuction.settle();
  }
}

// ---------------------------------------------------------------------------
// III] Burns, transfers et l'invariant MRN
//
// `settle()` partage `pendingAmount` en 30 % brule et 70 % transfere au
// Pool. L'invariant MRN est explicite :
//
//   - avant `settle` : `mrn.balanceOf(auction) == pendingAmount` ;
//   - apres `settle` : `mrn.balanceOf(auction) == 0` (tout a ete brule ou
//     transfere) ;
//   - `mrn.totalSupply() == initialSupply - burnAmount` (ERC20Burnable
//     reduit le totalSupply, contrairement a un transfer vers 0x...dEaD) ;
//   - le Pool a recu EXACTEMENT 70 % de `pendingAmount`, ni 100 % ni 0 %.
// ---------------------------------------------------------------------------

contract AuctionSettleInvariantTest is AuctionTestBase {

  uint256 internal constant INITIAL_MRN_SUPPLY = 100_000_000 * 1e18;

  // Met l'Auction dans un etat OU le slot pending est vide et l'etat
  // d'enchere est reinitialise, apres un settle reussi. C'est l'etat
  // de depart du test `test_SecondSettleRevertsNoBidToSettle` : un
  // `settle()` externe doit reverer `NoBidToSettle()` parce qu'il n'y
  // a rien a capturer (`highBidder == address(0)` apres le reset).
  // Le nom `_seedPending` est conserve pour la compatibilite avec
  // l'appelant, mais l'etat produit est "post-settle", pas
  // "pre-settle".
  function _seedPending() internal {
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);
    _warpToBidSilenceWindow(1);
    auction.settle();
  }

  function test_SettleBurns30AndSends70ToPool() public {
    // L'enchere du mandat 1. BIDDER_A pose 2 MRN. L'enchere cloture a
    // la dure sans qu'un autre encherisseur ne surenchérisse. Le bot
    // appelle `settle()` pendant la fenetre BID_SILENCE, AVANT que
    // l'epoch ne tourne. La garde `_epoch > currentEpoch()` du Pool
    // (I.1) tient : `pendingEpoch (1) > currentEpoch() (0)`.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);
    assertEq(auction.highBid(), FIRST_BID, "highBid vaut 2 MRN");

    // Avant le settle, le MRN de l'Auction vaut exactement le highBid.
    assertEq(
      mrn.balanceOf(address(auction)),
      FIRST_BID,
      "avant le settle, l'Auction detient 2 MRN"
    );
    uint256 totalSupplyBefore = mrn.totalSupply();

    // Le bot appelle `settle()` pendant la fenetre BID_SILENCE. On
    // capture les deltas AVANT l'appel pour mesurer le partage.
    _warpToBidSilenceWindow(1);
    uint256 poolBalanceBefore = mrn.balanceOf(address(pool));
    auction.settle();
    uint256 poolBalanceAfter = mrn.balanceOf(address(pool));
    uint256 totalSupplyAfter = mrn.totalSupply();

    // Le partage : 30 % brule (sur SPLIT_DEN = 10000), 70 % au pool.
    uint256 expectedBurn = FIRST_BID * 3000 / 10000;
    uint256 expectedLp = FIRST_BID - expectedBurn;

    // 1) Le pool a recu EXACTEMENT 70 % de pendingAmount.
    assertEq(
      poolBalanceAfter - poolBalanceBefore,
      expectedLp,
      "le pool doit avoir recu exactement 70 % du pendingAmount, pas tout ni rien"
    );

    // 2) Le totalSupply a ete reduit du montant brule (ERC20Burnable).
    assertEq(
      totalSupplyBefore - totalSupplyAfter,
      expectedBurn,
      "le totalSupply doit ete reduit du montant brule, comme ERC20Burnable l'exige"
    );

    // 3) Le slot pending est vide (le settle l'a remis a zero), et
    // l'etat d'enchere aussi (highBid = 0, highBidder = 0,
    // sellingEpoch au mandat suivant).
    assertEq(auction.pendingEpoch(), 0, "pendingEpoch doit etre remis a zero apres settle");
    assertEq(auction.pendingAmount(), 0, "pendingAmount doit etre remis a zero apres settle");
    assertEq(auction.highBidder(), address(0), "highBidder doit etre remis a zero apres settle");

    // 4) Sanity check : l'Auction ne detient plus de MRN (tout a ete
    // brule ou transfere au pool).
    assertEq(
      mrn.balanceOf(address(auction)),
      0,
      "apres settle, l'Auction ne detient plus de MRN : tout a ete brule ou transfere"
    );
  }

  function test_SecondSettleRevertsNoBidToSettle() public {
    // Apres un settle reussi (ici, l'auto-settle de l'enchere du
    // mandat 2), le slot est vide. Un `settle()` externe reverte
    // `NoBidToSettle()`.
    _seedPending();

    vm.expectRevert(Auction.NoBidToSettle.selector);
    auction.settle();
  }

  function test_SettleWithoutAnyBidRevertsNoBidToSettle() public {
    // Pas d'encherisseur, pas d'enchere, donc `pendingEpoch == 0 &&
    // pendingAmount == 0` des le depart. Le pool continue de trader au
    // tarif nominal, et rien ne s'accumule pour le mandat suivant (R7).
    _warpToEpoch(0);

    vm.expectRevert(Auction.NoBidToSettle.selector);
    auction.settle();
  }

  function test_SettleEmitsTheSettledEvent() public {
    // L'evenement Settled porte l'epoch, le manager, le clearing
    // price, le tarif en vigueur AU MOMENT DU MANDAT pendingEpoch, et
    // les trois reserves lues a cet instant. Sur cette fixture le
    // tarif est le nominal (5), parce que le gestionnaire n'a pas
    // appele setFee.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);
    _warpToBidSilenceWindow(1);

    vm.expectEmit(true, true, false, true, address(auction));
    emit Auction.Settled(
      1,
      BIDDER_A,
      FIRST_BID,
      pool.NOMINAL_FEE_NUM(),
      [uint256(0), 0, 0]
    );
    auction.settle();
  }
}

// ---------------------------------------------------------------------------
// IV] CEI dans `withdrawRefund`
//
// La propriété attendue est : `refunds[msg.sender]` est mis a 0 AVANT
// `mrn.safeTransfer(msg.sender, owed)`. La voie choisie pour la verifier
// est un mock de MRN qui reverte a la reception, parce qu'un mock standard
// reussit et ne permet pas de distinguer l'ordre de l'operation.
//
// Cette section documente la propriete en commentaire, et tient le cas
// "revert a la reception => refund est laisse a zero" comme test
// indirect : un mock qui reverte sur `safeTransfer` ne permet PAS de
// tester l'ordre CEI directement, parce que la sequence "refunds[x] = 0
// puis safeTransfer revert" laisse le registre a zero dans les deux cas
// (avant ET apres la mise a zero). C'est la SEULE propriete de la
// section qui n'a pas de test executable ici.
//
// Le cas "le refund est tire correctement" est couvert par la suite
// TypeScript (test/Auction.test.ts) qui peut observer le delta de solde.
// ---------------------------------------------------------------------------

contract AuctionWithdrawRefundCEITest is AuctionTestBase {

  function test_WithdrawRefundTransfersAndZeroesTheRegistry() public {
    // Test executable : BIDDER_A est dépassé, credite de 2 MRN, tire
    // son refund. Le registre passe a zero, le solde MRN de BIDDER_A
    // augmente du montant attendu, et un second appel reverte
    // `NoBidToRefund`.
    _warpToEpoch(0);
    _bidAs(BIDDER_A, FIRST_BID);
    _bidAs(BIDDER_B, (FIRST_BID * 11) / 10);

    assertEq(auction.refunds(BIDDER_A), FIRST_BID, "BIDDER_A doit etre credite avant le tirage");

    uint256 balanceBefore = mrn.balanceOf(BIDDER_A);
    vm.prank(BIDDER_A);
    auction.withdrawRefund();
    uint256 balanceAfter = mrn.balanceOf(BIDDER_A);

    assertEq(
      balanceAfter - balanceBefore,
      FIRST_BID,
      "le solde MRN de BIDDER_A doit augmenter de 2 MRN apres withdrawRefund"
    );
    assertEq(
      auction.refunds(BIDDER_A),
      0,
      "le registre refunds[BIDDER_A] doit etre a zero apres le tirage (CEI)"
    );

    // Un second appel reverte, le registre etait deja a zero.
    vm.expectRevert(Auction.NoBidToRefund.selector);
    vm.prank(BIDDER_A);
    auction.withdrawRefund();
  }
}
