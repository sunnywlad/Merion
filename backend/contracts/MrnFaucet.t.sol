// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {MrnFaucet} from "./MrnFaucet.sol";
import {MRN} from "./MRN.sol";
import {Test} from "forge-std/Test.sol";

contract MrnFaucetTest is Test {

  MrnFaucet public faucet;
  MRN public mrn;

  address public owner = address(0xABCD);
  address public alice = address(0xA11CE);
  address public bob = address(0xB0B);

  uint256 public constant DRIP_AMOUNT = 5000 * 10 ** 18;
  uint256 public constant DRIP_INTERVAL = 8 hours;
  uint256 public constant FAUCET_FUNDING = 10_000_000 * 10 ** 18;

  function setUp() public {
    // L'EDR démarre à `block.timestamp = 1`, donc `nextAllowedAt = 0 + 8 h
    // = 28800` dépasse la valeur initiale et le premier `drip()` reverterait
    // sans raison. On cale l'horloge sur une date de prod pour que la garde
    // se comporte comme sur une vraie chaîne.
    vm.warp(1_700_000_000);

    mrn = new MRN();
    faucet = new MrnFaucet(address(mrn), DRIP_AMOUNT, DRIP_INTERVAL, owner);
    mrn.transfer(address(faucet), FAUCET_FUNDING);
  }

  function test_constructorStoresValues() public view {
    assertEq(address(faucet.mrn()), address(mrn));
    assertEq(faucet.dripAmount(), DRIP_AMOUNT);
    assertEq(faucet.dripInterval(), DRIP_INTERVAL);
    assertEq(faucet.owner(), owner);
  }

  function test_dripSendsDripAmountAndStampsLastDrip() public {
    uint256 aliceBefore = mrn.balanceOf(alice);
    uint256 tsBefore = block.timestamp;

    vm.prank(alice);
    faucet.drip();

    assertEq(mrn.balanceOf(alice), aliceBefore + DRIP_AMOUNT);
    assertEq(faucet.lastDripAt(alice), tsBefore);
  }

  function test_dripEmitsEvent() public {
    vm.expectEmit(true, false, false, true, address(faucet));
    emit MrnFaucet.Dripped(alice, DRIP_AMOUNT);

    vm.prank(alice);
    faucet.drip();
  }

  function test_dripTwiceInARowRevertsWithTooEarly() public {
    vm.prank(alice);
    faucet.drip();

    vm.expectRevert(
      abi.encodeWithSelector(MrnFaucet.TooEarly.selector, block.timestamp + DRIP_INTERVAL)
    );
    vm.prank(alice);
    faucet.drip();
  }

  function test_dripAfterIntervalWorksAgain() public {
    vm.prank(alice);
    faucet.drip();

    vm.warp(block.timestamp + DRIP_INTERVAL);

    vm.prank(alice);
    faucet.drip();

    assertEq(mrn.balanceOf(alice), DRIP_AMOUNT * 2);
    assertEq(faucet.lastDripAt(alice), block.timestamp);
  }

  function test_dripOneSecondBeforeIntervalReverts() public {
    vm.prank(alice);
    faucet.drip();

    vm.warp(block.timestamp + DRIP_INTERVAL - 1);

    vm.expectRevert(
      abi.encodeWithSelector(MrnFaucet.TooEarly.selector, block.timestamp + 1)
    );
    vm.prank(alice);
    faucet.drip();
  }

  function test_dripRevertsWhenFaucetEmpty() public {
    // Vue d'abord pour ne pas consommer le prank qui suit : `vm.prank` ne
    // s'applique qu'à l'appel immédiatement suivant, et `balanceOf` est un
    // appel (`staticcall`) qui le consomme quand même en EDR.
    uint256 faucetBal = mrn.balanceOf(address(faucet));

    vm.prank(owner);
    faucet.withdraw(faucetBal);

    vm.expectRevert(abi.encodeWithSelector(MrnFaucet.FaucetEmpty.selector));
    vm.prank(alice);
    faucet.drip();
  }

  function test_differentAddressesDripIndependently() public {
    vm.prank(alice);
    faucet.drip();

    vm.prank(bob);
    faucet.drip();

    assertEq(mrn.balanceOf(alice), DRIP_AMOUNT);
    assertEq(mrn.balanceOf(bob), DRIP_AMOUNT);
  }

  function test_faucetBalanceDecreasesByDripAmount() public {
    uint256 faucetBefore = mrn.balanceOf(address(faucet));

    vm.prank(alice);
    faucet.drip();

    assertEq(mrn.balanceOf(address(faucet)), faucetBefore - DRIP_AMOUNT);
  }

  function test_withdrawOnlyOwner() public {
    vm.expectRevert(
      abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice)
    );
    vm.prank(alice);
    faucet.withdraw(DRIP_AMOUNT);
  }

  function test_withdrawTransfersToOwner() public {
    uint256 ownerBefore = mrn.balanceOf(owner);
    uint256 amount = 100_000 * 10 ** 18;

    vm.prank(owner);
    faucet.withdraw(amount);

    assertEq(mrn.balanceOf(owner), ownerBefore + amount);
    assertEq(mrn.balanceOf(address(faucet)), FAUCET_FUNDING - amount);
  }

  function test_withdrawEmitsEvent() public {
    uint256 amount = 100_000 * 10 ** 18;

    vm.expectEmit(true, false, false, true, address(faucet));
    emit MrnFaucet.Withdrawn(owner, amount);

    vm.prank(owner);
    faucet.withdraw(amount);
  }

  function test_zeroDripAmountIsAllowed() public {
    // Faucet séparé pour ne pas perturber le compteur des autres tests.
    MrnFaucet emptyFaucet = new MrnFaucet(address(mrn), 0, DRIP_INTERVAL, owner);

    vm.prank(alice);
    emptyFaucet.drip();

    assertEq(mrn.balanceOf(alice), 0);
    assertEq(emptyFaucet.lastDripAt(alice), block.timestamp);
  }
}
