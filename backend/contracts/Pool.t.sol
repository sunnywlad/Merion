// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Pool} from "./Pool.sol";
import {MockWrappedBTC} from "./MockWrappedBTC.sol";
import {Test} from "forge-std/Test.sol";

contract PoolTest is Test {

  MockWrappedBTC public wbtc;
  MockWrappedBTC public cbbtc;
  MockWrappedBTC public lbtc;
  Pool public pool;

  function setUp() public {
    wbtc = new MockWrappedBTC("Wrapped BTC", "wBTC");
    cbbtc = new MockWrappedBTC("Coinbase BTC", "cbBTC");
    lbtc = new MockWrappedBTC("Lombard BTC", "lBTC");

    address[3] memory tokens = [address(wbtc), address(cbbtc), address(lbtc)];
    uint256 feeNum = 5;
    address feeSetter = address(this);

    pool = new Pool(tokens, feeNum, feeSetter, 1);

    wbtc.mint(address(this), 1000 * 10 ** 8);
    cbbtc.mint(address(this), 1000 * 10 ** 8);
    lbtc.mint(address(this), 1000 * 10 ** 8);

    wbtc.approve(address(pool), 1000 * 10 ** 8);
    cbbtc.approve(address(pool), 1000 * 10 ** 8);
    lbtc.approve(address(pool), 1000 * 10 ** 8);
  }
  function test_decimalsIs8() public view {
    assertEq(pool.decimals(), 8);
  }
  // Fuzz tests and invariants for addLiquidity/removeLiquidity/swap are written
  // separately by the author. The three smoke tests that used to live here
  // (test_addLiquidity, test_removeLiquidity, test_swap) called the contract
  // without any assertion and were removed: they tested nothing.
}
