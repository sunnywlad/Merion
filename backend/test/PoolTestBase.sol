// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Pool} from '../contracts/Pool.sol';
import {MockWrappedBTC} from '../contracts/MockWrappedBTC.sol';
import {Test} from "forge-std/Test.sol";

contract PoolTestBase {
  MockWrappedBTC public wbtc;
  MockWrappedBTC public cbbtc;
  MockWrappedBTC public lbtc;
  Pool public pool;

  function setUp() virtual public {
    wbtc = new MockWrappedBTC("Wrapped BTC", "wBTC");
    cbbtc = new MockWrappedBTC("Coinbase BTC", "cbBTC");
    lbtc = new MockWrappedBTC("Lombard BTC", "lBTC");

    address[3] memory tokens = [address(wbtc), address(cbbtc), address(lbtc)];
    uint256 feeNum = 5;
    address feeSetter = address(this);

    pool = new Pool(tokens, feeNum, feeSetter);

    wbtc.mint(address(this), 21_000_000 * 10 ** 8);
    cbbtc.mint(address(this), 21_000_000 * 10 ** 8);
    lbtc.mint(address(this), 21_000_000 * 10 ** 8);

    wbtc.approve(address(pool), 21_000_000 * 10 ** 8);
    cbbtc.approve(address(pool), 21_000_000 * 10 ** 8);
    lbtc.approve(address(pool), 21_000_000 * 10 ** 8);
  }
}
