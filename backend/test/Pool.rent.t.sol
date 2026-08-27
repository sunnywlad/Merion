// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from "./PoolTestBase.sol";

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
    mrn.transfer(address(pool), amount); // Auction.settle envoie le MRN avant l'appel
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
}
