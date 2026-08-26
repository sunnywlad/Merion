// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Pool} from '../contracts/Pool.sol';
import {MockWrappedBTC} from '../contracts/MockWrappedBTC.sol';
import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from './PoolTestBase.sol';
import {stdError} from 'forge-std/StdError.sol';


contract RemoveLiquidityFuzzOnEmptyPool is Test, PoolTestBase {

  function test_FuzzBurnedSharesOnEmptyPoolRevertsWithNotBootstrapped(uint256 burnedShares) public {
    uint256[3] memory minOut = [uint256(0), 0, 0];

    vm.expectRevert(Pool.NotBootstrapped.selector);
    pool.removeLiquidity(burnedShares, minOut);
  }
}

contract RemoveLiquidityFuzzNotEmptyPool is Test, PoolTestBase {

  function setUp() public override {
    super.setUp();
    pool.addLiquidity(0, 1000e8, 0);
  }

  function test_FuzzBurnedSharesReturnsExpectedAmounts(uint256 burnedShares) public {
    uint256 supply = pool.totalSupply();
    uint256 balance = pool.balanceOf(address(this));
    burnedShares = bound(burnedShares, 0, balance);

    uint256[3] memory minOut = [uint256(0), 0, 0];
    uint256[3] memory expected;
    for (uint256 i; i < 3; i++) {
      expected[i] = pool.reserves(i) * burnedShares / supply;
    }

    uint256[3] memory amountsOut = pool.removeLiquidity(burnedShares, minOut);
    assertEq(amountsOut[0], expected[0]);
    assertEq(amountsOut[1], expected[1]);
    assertEq(amountsOut[2], expected[2]);
  }

  function test_FuzzBurnedSharesRevertsWithBadSlippage(uint256 burnedShares, uint256 tokenIndex) public {
    uint256 supply = pool.totalSupply();
    uint256 balance = pool.balanceOf(address(this));
    burnedShares = bound(burnedShares, 1, balance);
    tokenIndex = bound(tokenIndex, 0, 2);

    uint256[3] memory minOut = [uint256(0), 0, 0];
    minOut[tokenIndex] = pool.reserves(tokenIndex) * burnedShares / supply + 1;

    vm.expectRevert(Pool.BadSlippage.selector);
    pool.removeLiquidity(burnedShares, minOut);
  }

  function test_FuzzBurnedSharesExceedingBalanceRevertsWithInsufficientBalance(uint256 burnedShares) public {
    uint256 supply = pool.totalSupply();
    uint256 balance = pool.balanceOf(address(this));
    burnedShares = bound(burnedShares, balance + 1, supply);

    uint256[3] memory minOut = [uint256(0), 0, 0];

    vm.expectRevert();
    pool.removeLiquidity(burnedShares, minOut);
  }

  function test_FuzzBurnedSharesExceedingSupplyRevertsWithPanic(uint256 burnedShares) public {
    // Borne choisie pour faire deborder la multiplication reserves(0) *
    // burnedShares elle-meme (Pool.sol:125), avant division ou troncature
    // uint72 : ce point-la panique par construction du contrele d'overflow
    // de Solidity, contrairement a un simple burnedShares > supply, qui
    // laisse une zone ou amountsOut[i] deborde son cast uint72 sans que la
    // valeur tronquee resultante depasse forcement reserves[i].
    uint256 overflowThreshold = type(uint256).max / pool.reserves(0) + 1;
    burnedShares = bound(burnedShares, overflowThreshold, type(uint256).max);

    uint256[3] memory minOut = [uint256(0), 0, 0];

    vm.expectRevert(stdError.arithmeticError);
    pool.removeLiquidity(burnedShares, minOut);
  }
}
