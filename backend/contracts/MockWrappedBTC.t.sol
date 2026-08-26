// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {MockWrappedBTC} from "./MockWrappedBTC.sol";
import {Test} from "forge-std/Test.sol";

contract MockWrappedBTCTest is Test {

  MockWrappedBTC public wbtc;
  address public alice = address(0xA11CE);

  function setUp() public {
    wbtc = new MockWrappedBTC("Wrapped BTC", "wBTC");
  }

  function test_metadata() public view {
    assertEq(wbtc.name(), "Wrapped BTC");
    assertEq(wbtc.symbol(), "wBTC");
  }

  function test_decimalsIs8() public view {
    assertEq(wbtc.decimals(), 8);
  }

  function test_initialSupplyIsZero() public view {
    assertEq(wbtc.totalSupply(), 0);
  }

  function test_mintCreditsAccountAndSupply() public {
    wbtc.mint(alice, 100 * 10 ** 8);

    assertEq(wbtc.balanceOf(alice), 100 * 10 ** 8);
    assertEq(wbtc.totalSupply(), 100 * 10 ** 8);
  }

  function test_mintIsPublic() public {
    vm.prank(alice);
    wbtc.mint(alice, 1 * 10 ** 8);

    assertEq(wbtc.balanceOf(alice), 1 * 10 ** 8);
  }

  function test_mintAccumulates() public {
    wbtc.mint(alice, 1 * 10 ** 8);
    wbtc.mint(alice, 2 * 10 ** 8);

    assertEq(wbtc.balanceOf(alice), 3 * 10 ** 8);
    assertEq(wbtc.totalSupply(), 3 * 10 ** 8);
  }

  function test_mintZeroIsAllowed() public {
    wbtc.mint(alice, 0);

    assertEq(wbtc.balanceOf(alice), 0);
    assertEq(wbtc.totalSupply(), 0);
  }

  function test_mintToZeroAddressReverts() public {
    vm.expectRevert();
    wbtc.mint(address(0), 1 * 10 ** 8);
  }
}
