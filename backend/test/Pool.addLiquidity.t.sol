// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Pool} from '../contracts/Pool.sol';
import {MockWrappedBTC} from '../contracts/MockWrappedBTC.sol';
import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from './PoolTestBase.sol';
import {stdError} from 'forge-std/StdError.sol';


contract AddLiquidityFuzzOnEmptyPool is Test, PoolTestBase {

  function test_FuzzSmallAmountOnEmptyPoolRevertsWithPanic(uint256 anchorIndex, uint256 amount) public {
    anchorIndex = bound(anchorIndex, 0, 2);
    amount = bound(amount, 1, 333);

    vm.expectRevert(stdError.arithmeticError);
    pool.addLiquidity(anchorIndex, amount, 0);
  }

  function test_FuzzAmountOnEmptyPoolMintsExpectedShares(uint256 anchorIndex, uint256 amount) public {
    anchorIndex = bound(anchorIndex, 0, 2);
    amount = bound(amount, 334, 21_000_000e8);

    uint256 mintedShares = pool.addLiquidity(anchorIndex, amount, 0);
    assertEq(mintedShares, 3 * amount - pool.MINIMUM_LIQUIDITY());
  }

  function test_FuzzAmountOnEmptyPoolMintsExpectedSharesWithSlippage(uint256 anchorIndex, uint256 amount, uint256 minShares) public {
    anchorIndex = bound(anchorIndex, 0, 2);
    amount = bound(amount, 334, 21_000_000e8);
    minShares = bound(minShares, 0, 3 * amount - pool.MINIMUM_LIQUIDITY());

    uint256 mintedShares = pool.addLiquidity(anchorIndex, amount, minShares);
    assertEq(mintedShares, 3 * amount - pool.MINIMUM_LIQUIDITY());
  }

  function test_FuzzAmountOnEmptyPoolRevertsWithBadSlippage(uint256 anchorIndex, uint256 amount, uint256 minShares) public {
    anchorIndex = bound(anchorIndex, 0, 2);
    amount = bound(amount, 334, 21_000_000e8);
    minShares = bound(minShares, 3 * amount - pool.MINIMUM_LIQUIDITY() + 1, type(uint256).max);

    vm.expectRevert(Pool.BadSlippage.selector);
    pool.addLiquidity(anchorIndex, amount, minShares);
  }
}

contract AddLiquidityFuzzNotEmptyPool is Test, PoolTestBase {

  function setUp() public override {
    super.setUp();
    pool.addLiquidity(0, 1000e8, 0);
  }

  function test_FuzzAmountNotEmptyPoolMintsExpectedShares(uint256 anchorIndex, uint256 amount) public {
    anchorIndex = bound(anchorIndex, 0, 2);
    amount = bound(amount, 1, 20_999_000e8);

    uint256 supply = pool.totalSupply();
    uint256 reservesAnchor = pool.reserves(anchorIndex);

    uint256 mintedShares = pool.addLiquidity(anchorIndex, amount, 0);
    assertEq(mintedShares, supply * amount / reservesAnchor);
  }

  function test_Fuzz0NotEmptyPoolRevertsWithZeroOutput(uint256 anchorIndex) public {
    anchorIndex = bound(anchorIndex, 0, 2);

    vm.expectRevert(Pool.ZeroOutput.selector);
    pool.addLiquidity(anchorIndex, 0, 0);
  }

  function test_FuzzAmountNotEmptyPoolMintsExpectedSharesWithSlippage(uint256 anchorIndex, uint256 amount, uint256 minShares) public {
    anchorIndex = bound(anchorIndex, 0, 2);
    amount = bound(amount, 1, 20_999_000e8);

    uint256 supply = pool.totalSupply();
    uint256 reservesAnchor = pool.reserves(anchorIndex);
    minShares = bound(minShares, 0, supply * amount / reservesAnchor);

    uint256 mintedShares = pool.addLiquidity(anchorIndex, amount, minShares);
    assertEq(mintedShares, supply * amount / reservesAnchor);
  }

  function test_FuzzAmountNotEmptyPoolRevertsWithBadSlippage(uint256 anchorIndex, uint256 amount, uint256 minShares) public {
    anchorIndex = bound(anchorIndex, 0, 2);
    amount = bound(amount, 1, 20_999_000e8);
    uint256 supply = pool.totalSupply();
    uint256 reservesAnchor = pool.reserves(anchorIndex);
    minShares = bound(minShares, supply * amount / reservesAnchor + 1, type(uint256).max);

    vm.expectRevert(Pool.BadSlippage.selector);
    pool.addLiquidity(anchorIndex, amount, minShares);
  }
}
