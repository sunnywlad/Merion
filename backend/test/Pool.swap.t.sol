// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Pool} from '../contracts/Pool.sol';
import {MockWrappedBTC} from '../contracts/MockWrappedBTC.sol';
import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from './PoolTestBase.sol';
import {stdError} from 'forge-std/StdError.sol';


contract SwapFuzz is Test, PoolTestBase {

  function setUp() public override {
    super.setUp();
    pool.addLiquidity(0, 1000e8, 0);
  }

  function boundIndices(uint256 _indexIn, uint256 _indexOut) internal pure returns (uint256 indexIn, uint256 indexOut) {
    indexIn = bound(_indexIn, 0, 2);
    indexOut = bound(_indexOut, 0, 1);
    if (indexOut >= indexIn) indexOut += 1;
  }

  function expectedAmountOut(uint256 indexIn, uint256 amount, uint256 indexOut) internal view returns (uint256) {
    uint256 amountAfterFee = amount * (pool.FEE_DEN() - pool.feeNum()) / pool.FEE_DEN();
    return amountAfterFee * pool.reserves(indexOut) / (amountAfterFee + pool.reserves(indexIn));
  }

  function test_FuzzSwapReturnsExpectedAmountOut(uint256 _indexIn, uint256 amount, uint256 _indexOut) public {
    (uint256 indexIn, uint256 indexOut) = boundIndices(_indexIn, _indexOut);
    amount = bound(amount, 1000, 20_000_000e8);

    uint256 expected = expectedAmountOut(indexIn, amount, indexOut);
    uint256 amountOut = pool.swap(indexIn, amount, indexOut, 0);
    assertEq(amountOut, expected);
  }

  function test_FuzzSwap0RevertsWithZeroOutput(uint256 _indexIn, uint256 _indexOut) public {
    (uint256 indexIn, uint256 indexOut) = boundIndices(_indexIn, _indexOut);

    vm.expectRevert(Pool.ZeroOutput.selector);
    pool.swap(indexIn, 0, indexOut, 0);
  }

  function test_FuzzSwapWithSlippageSatisfied(uint256 _indexIn, uint256 amount, uint256 _indexOut, uint256 minOut) public {
    (uint256 indexIn, uint256 indexOut) = boundIndices(_indexIn, _indexOut);
    amount = bound(amount, 1000, 20_000_000e8);
    uint256 expected = expectedAmountOut(indexIn, amount, indexOut);
    minOut = bound(minOut, 0, expected);

    uint256 amountOut = pool.swap(indexIn, amount, indexOut, minOut);
    assertEq(amountOut, expected);
  }

  function test_FuzzSwapRevertsWithBadSlippage(uint256 _indexIn, uint256 amount, uint256 _indexOut, uint256 minOut) public {
    (uint256 indexIn, uint256 indexOut) = boundIndices(_indexIn, _indexOut);
    amount = bound(amount, 1000, 20_000_000e8);
    uint256 expected = expectedAmountOut(indexIn, amount, indexOut);
    minOut = bound(minOut, expected + 1, type(uint256).max);

    vm.expectRevert(Pool.BadSlippage.selector);
    pool.swap(indexIn, amount, indexOut, minOut);
  }
}
