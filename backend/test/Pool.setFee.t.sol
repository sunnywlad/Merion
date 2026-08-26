// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Pool} from '../contracts/Pool.sol';
import {MockWrappedBTC} from '../contracts/MockWrappedBTC.sol';
import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from './PoolTestBase.sol';


contract SetFeeFuzzTooSoon is Test, PoolTestBase {

  function test_FuzzSetFeeTooSoonReverts(uint256 newFee) public {
    newFee = bound(newFee, 0, pool.MAX_FEE_NUM());

    vm.expectRevert(Pool.FeeUpdateTooSoon.selector);
    pool.setFee(newFee);
  }
}

contract SetFeeFuzzAfterDelay is Test, PoolTestBase {

  function setUp() public override {
    super.setUp();
    vm.warp(block.timestamp + pool.MIN_SET_FEE_DELAY());
  }

  function test_FuzzSetFeeUpdatesFee(uint256 newFee) public {
    newFee = bound(newFee, 0, pool.MAX_FEE_NUM());

    pool.setFee(newFee);
    assertEq(pool.feeNum(), newFee);
  }

  function test_FuzzSetFeeUpdatesLastFeeUpdate(uint256 newFee) public {
    newFee = bound(newFee, 0, pool.MAX_FEE_NUM());

    pool.setFee(newFee);
    assertEq(pool.lastFeeUpdate(), block.timestamp);
  }

  function test_FuzzSetFeeRevertsWhenTooHigh(uint256 newFee) public {
    newFee = bound(newFee, pool.MAX_FEE_NUM() + 1, type(uint256).max);

    vm.expectRevert(Pool.FeeTooHigh.selector);
    pool.setFee(newFee);
  }

  function test_FuzzSetFeeRevertsWhenNotOwner(address caller, uint256 newFee) public {
    vm.assume(caller != address(this));
    newFee = bound(newFee, 0, pool.MAX_FEE_NUM());

    vm.prank(caller);
    vm.expectRevert();
    pool.setFee(newFee);
  }
}
