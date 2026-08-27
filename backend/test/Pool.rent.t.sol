// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from "./PoolTestBase.sol";
import {Pool} from "../contracts/Pool.sol";

// Couche Solidity d'I.4 : la MECANIQUE de l'accumulateur de loyer, isolee
// de tout parcours multi-comptes. Meme partage que Pool.feeInForce.t.sol vs
// Pool.feeInForce.test.ts : la couche TypeScript (test/Pool.rent.test.ts)
// reproduit le parcours reel (approve, addLiquidity, claimRent en MRN entre
// comptes distincts), celle-ci force le temps a la seconde avec `vm.warp`
// et verifie deux choses que le parcours reseau ne formule pas bien :
//
//   1. `_updateRent` fait croitre `accPerShare` d'EXACTEMENT
//      `dt * rentRate / totalSupply()` par tranche (echelle 1e18 unique,
//      build-auction.md 4.4). C'est la formule, pas une sortie observee.
//   2. L'ORDRE de `_update`, le choke point d'OZ v5 (build-auction.md E5) :
//      l'accru du SENDER est capture sur son solde PRE-transfert, et le
//      RECEIVER n'herite d'AUCUN accru anterieur a l'instant ou il recoit
//      les parts (mint comme transfert).
//
// address(this) joue a la fois l'owner, l'enchere (via setAuction) et le
// LP1 : c'est voulu, on veut isoler l'accumulateur, pas le controle d'acces
// (couvert cote TypeScript).

contract PoolRentAccumulatorTest is Test, PoolTestBase {

  uint256 internal constant SEED = 100e8;      // amorce par jambe -> supply 3e10
  uint256 internal constant EPOCH = 14400;     // EPOCH_DURATION, cf. PoolTestBase
  uint256 internal constant RENT = 14400e18;   // rentRate tombe sur 1e36 pile
  uint256 internal constant SCALE = 1e18;

  address internal constant LP2 = address(0xB0B2);

  function setUp() public override {
    super.setUp();
    pool.setAuction(address(this)); // le test joue l'enchere
    pool.addLiquidity(0, SEED, 0);  // address(this) devient LP1
  }

  function _notify(uint256 amount) internal {
    // M2 (I.7) : le Pool TIRE, l'Auction ne POUSSE plus. `address(this)`
    // joue l'enchere (cf. setUp), il a recu tout le MRN mint par le
    // deployer de MRN (transfert direct au test contrat, ou via MRN
    // pre-mint). L'approbation est posee ici, exactement le `max`
    // suffisant pour un seul notifyRent — la section V de
    // Pool.rent.test.ts pose `max` et verifie la solvabilite au centime
    // pres.
    mrn.approve(address(pool), amount);
    pool.notifyRent(amount);
  }

  // Touche minimale qui declenche `_updateRent` sans reamorcer le stream ni
  // bouger totalSupply : un transfert de zero vers soi-meme.
  function _touch() internal {
    pool.transfer(address(this), 0);
  }

  // --- 1. La formule de l'accumulateur -----------------------------------

  function test_UpdateRent_AccumulatorGrowsByExactlyDtRateOverSupply() public {
    _notify(RENT);
    uint256 rate = pool.rentRate();          // (RENT + 0) * 1e18 / EPOCH
    uint256 supply = pool.totalSupply();
    uint256 start = pool.rentLastUpdate();

    uint256 dt = EPOCH / 4;
    vm.warp(start + dt);
    _touch();

    // build-auction.md 4.4 : accPerShare += dt * rentRate / totalSupply().
    assertEq(
      pool.accPerShare(),
      dt * rate / supply,
      "accPerShare doit suivre dt * rentRate / totalSupply (echelle 1e18 unique)"
    );
  }

  function test_UpdateRent_TwoTranchesSumToTheWholeStream() public {
    _notify(RENT);
    uint256 rate = pool.rentRate();
    uint256 supply = pool.totalSupply();
    uint256 start = pool.rentLastUpdate();

    vm.warp(start + EPOCH / 3);
    _touch();
    vm.warp(start + EPOCH);
    _touch();

    // Sur le mandat entier, l'accumulateur vaut EPOCH * rentRate / supply,
    // et rentRate * EPOCH / 1e18 == RENT : le stream entier est distribue.
    assertEq(pool.accPerShare(), EPOCH * rate / supply, "somme des tranches == stream entier");
    assertEq(rate * EPOCH / SCALE, RENT, "rentRate * EPOCH / 1e18 restitue le montant notifie");
  }

  // --- 2. L'ordre de `_update` (build-auction.md E5) --------------------

  function test_UpdateOnTransfer_SenderKeepsPreTransferAccrual_ReceiverGetsNothingPrior() public {
    _notify(RENT);
    uint256 rentEnd = pool.rentEnd();
    vm.warp(rentEnd - EPOCH / 2); // mi-stream

    uint256 balPre = pool.balanceOf(address(this));
    pool.transfer(LP2, balPre);

    uint256 acc = pool.accPerShare();

    // Sender : accru capture sur le solde PRE-transfert (sa dette valait 0).
    assertEq(
      pool.rentPending(address(this)),
      balPre * acc / SCALE,
      "le sender garde l'accru de la periode ou il detenait les parts"
    );
    // Receiver neuf : AUCUN accru anterieur au transfert.
    assertEq(pool.rentPending(LP2), 0, "le receiver n'herite d'aucun accru anterieur");
    // Sa dette part de l'accumulateur courant.
    assertEq(pool.rentDebt(LP2), balPre * acc / SCALE, "dette du receiver = solde recu * accPerShare / 1e18");
  }

  function test_UpdateOnMint_LateDepositorHasNoClaimOnEarlierRent() public {
    _notify(RENT);
    uint256 rentEnd = pool.rentEnd();
    vm.warp(rentEnd - EPOCH / 2);

    // LP2 se finance et depose a mi-stream.
    wbtc.transfer(LP2, SEED);
    cbbtc.transfer(LP2, SEED);
    lbtc.transfer(LP2, SEED);
    vm.startPrank(LP2);
    wbtc.approve(address(pool), SEED);
    cbbtc.approve(address(pool), SEED);
    lbtc.approve(address(pool), SEED);
    pool.addLiquidity(0, SEED, 0);
    vm.stopPrank();

    assertEq(pool.rentPending(LP2), 0, "un depot a mi-stream ne donne aucune creance sur la premiere moitie");
    assertEq(
      pool.rentDebt(LP2),
      pool.balanceOf(LP2) * pool.accPerShare() / SCALE,
      "la dette du nouveau LP part de l'accumulateur courant"
    );
  }

  function test_UpdateOnBurn_HolderKeepsAccrualOnPreBurnBalance() public {
    _notify(RENT);
    uint256 rentEnd = pool.rentEnd();
    vm.warp(rentEnd - EPOCH / 2);

    uint256 balPre = pool.balanceOf(address(this));
    uint256[3] memory minOut;
    pool.removeLiquidity(balPre, minOut);

    assertEq(pool.balanceOf(address(this)), 0, "toutes les parts brulees");
    assertEq(
      pool.rentPending(address(this)),
      balPre * pool.accPerShare() / SCALE,
      "l'accru est fige sur le solde pre-burn (sa dette valait 0)"
    );
  }

  // --- 3. claimable(address) : la vue rend ce que claimRent transfere ----

  // claimable(u) doit rendre, au wei pres, ce que claimRent() transfere dans
  // la meme foulee. C'est l'egalite que l'invariant Foundry differentiel I.6
  // generalisera ; ici on l'epingle sur un parcours concret. address(this)
  // detient les parts LP1 posees au setUp (cf. en-tete du fichier), le
  // claimant est donc le contrat de test lui-meme : ni compte distinct ni
  // vm.prank. `claimable` projette l'accumulateur via `_accProjected()` a
  // block.timestamp ; `claimRent` appelle `_updateRent()` qui ecrit cette
  // meme projection puis lit accPerShare. Aucun warp entre les deux : meme
  // timestamp, donc egalite exacte, pas seulement approchee.
  function test_ClaimableMatchesClaimRentTransfer() public {
    _notify(RENT);
    uint256 start = pool.rentLastUpdate();
    vm.warp(start + EPOCH / 2); // mi-stream : l'accru vivant est non nul

    uint256 quoted = pool.claimable(address(this));
    assertGt(quoted, 0, "fixture : claimable doit etre non nul pour tester l'egalite");

    uint256 balBefore = mrn.balanceOf(address(this));
    pool.claimRent();
    assertEq(
      mrn.balanceOf(address(this)) - balBefore,
      quoted,
      "claimable(u) doit rendre exactement ce que claimRent() transfere"
    );
  }

  // claimable == 0 -> claimRent() revert ZeroRentOwed. LP2 n'a jamais detenu
  // de parts : sa vue est nulle et le tirage doit revert. C'est la surface
  // de revert que l'invariant differentiel couvrira aussi (une vue a zero
  // n'autorise aucun transfert).
  function test_ClaimRentRevertsWhenClaimableIsZero() public {
    _notify(RENT);
    vm.warp(pool.rentLastUpdate() + EPOCH / 2);

    assertEq(pool.claimable(LP2), 0, "LP2 sans parts : claimable doit etre nul");

    vm.prank(LP2);
    vm.expectRevert(Pool.ZeroRentOwed.selector);
    pool.claimRent();
  }

  // --- 4. M2 (I.7) : pull depuis l'Auction, garde d'approbation ----

  // M2 — le Pool TIRE, l'Auction ne POUSSE plus. Sans approbation de
  // l'Auction (ici `address(this)`) vers le Pool, `safeTransferFrom`
  // reverte `ERC20InsufficientAllowance` et la totalite de `notifyRent`
  // est annulee (CEI : aucun effet d'etat engage). C'est l'echec
  // bruyant documente en I.7 #10, preferable a une sur-declaration
  // silencieuse de l'Auction (l'ancien push masquait l'approbation
  // manquante : un _settle qui reverte apres le burn laissait l'Auction
  // amputee de ses 30 %).
  //
  // Aucune approbation posee dans le harnais : `address(this)` n'a
  // jamais appele `mrn.approve(address(pool), ...)` — seul `_notify`
  // pose l'approbation necessaire, et le test ci-dessous ne passe pas
  // par lui.
  function test_NotifyRentRevertsWithoutApproval() public {
    uint256 amount = 1e18;
    // Garde specifique : sur pool non amorce (totalSupply == 0) la branche
    // early-return POSERAIT rentLeftOver, mais le test interesse la branche
    // du pull, inconditionnelle en queue. On amorce donc le pool pour
    // traverser aussi la branche `else` (re-base du stream) et montrer
    // que le pull reverte a la fin, apres que les effets sont poses.
    pool.addLiquidity(0, SEED, 0);
    assertEq(mrn.allowance(address(this), address(pool)), 0, "aucune approbation posee par defaut");

    vm.expectRevert(); // ERC20InsufficientAllowance(address(pool), 0, 1e18)
    pool.notifyRent(amount);
  }
}
