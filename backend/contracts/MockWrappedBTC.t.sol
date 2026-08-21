// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {MockWrappedBTC} from "./MockWrappedBTC.sol";
import {Test} from "forge-std/Test.sol";

contract MockWrappedBTCTest is Test {

  MockWrappedBTC public tbtc;
  address public alice = address(0xA11CE);

  function setUp() public {
    tbtc = new MockWrappedBTC("Threshold BTC", "tBTC");
  }

  function test_metadata() public view {
    assertEq(tbtc.name(), "Threshold BTC");
    assertEq(tbtc.symbol(), "tBTC");
  }

  function test_decimalsIs8() public view {
    assertEq(tbtc.decimals(), 8);
  }

  function test_initialSupplyIsZero() public view {
    assertEq(tbtc.totalSupply(), 0);
  }

  function test_mintCreditsAccountAndSupply() public {
    tbtc.mint(alice, 100 * 10 ** 8);

    assertEq(tbtc.balanceOf(alice), 100 * 10 ** 8);
    assertEq(tbtc.totalSupply(), 100 * 10 ** 8);
  }

  function test_mintIsPublic() public {
    vm.prank(alice);
    tbtc.mint(alice, 1 * 10 ** 8);

    assertEq(tbtc.balanceOf(alice), 1 * 10 ** 8);
  }

  function test_mintAccumulates() public {
    tbtc.mint(alice, 1 * 10 ** 8);
    tbtc.mint(alice, 2 * 10 ** 8);

    assertEq(tbtc.balanceOf(alice), 3 * 10 ** 8);
    assertEq(tbtc.totalSupply(), 3 * 10 ** 8);
  }

  function test_mintZeroIsAllowed() public {
    tbtc.mint(alice, 0);

    assertEq(tbtc.balanceOf(alice), 0);
    assertEq(tbtc.totalSupply(), 0);
  }

  function test_mintToZeroAddressReverts() public {
    vm.expectRevert();
    tbtc.mint(address(0), 1 * 10 ** 8);
  }
}
