// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {CommonBase} from 'forge-std/Base.sol';
import {StdUtils} from 'forge-std/StdUtils.sol';
import {StdAssertions} from 'forge-std/StdAssertions.sol';
import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from './PoolTestBase.sol';
import {Pool} from '../contracts/Pool.sol';
import {MockWrappedBTC} from '../contracts/MockWrappedBTC.sol';

contract PoolHandler is CommonBase, StdUtils, StdAssertions {
  MockWrappedBTC public wbtc;
  MockWrappedBTC public cbbtc;
  MockWrappedBTC public lbtc;
  Pool public pool;

  constructor(MockWrappedBTC _wbtc, MockWrappedBTC _cbbtc, MockWrappedBTC _lbtc, Pool _pool) {
    wbtc = _wbtc;
    cbbtc = _cbbtc;
    lbtc = _lbtc;
    pool = _pool;

    wbtc.approve(address(pool), 21_000_000e8);
    cbbtc.approve(address(pool), 21_000_000e8);
    lbtc.approve(address(pool), 21_000_000e8);
  }

  function poolState() internal view returns (uint256[3] memory reserves, uint256[3] memory balances) {
    reserves[0] = pool.reserves(0);
    reserves[1] = pool.reserves(1);
    reserves[2] = pool.reserves(2);
    balances[0] = wbtc.balanceOf(address(pool));
    balances[1] = cbbtc.balanceOf(address(pool));
    balances[2] = lbtc.balanceOf(address(pool));
  }

  function assertReservesTrackBalances(uint256[3] memory reservesBefore, uint256[3] memory balancesBefore) internal view {
    (uint256[3] memory reservesAfter, uint256[3] memory balancesAfter) = poolState();
    for (uint256 i; i < 3; i++) {
      assertEq(reservesAfter[i] + balancesBefore[i], reservesBefore[i] + balancesAfter[i]);
    }
  }

  function addLiquidityWrapper(uint256 _anchorIndex, uint256 _amount, uint256 _minShares) external returns (uint256 mintedShares) {
    uint256 anchorIndex = bound(_anchorIndex, 0, 2);
    uint256 amount = bound(_amount, 334, 21_000_000e8);
    uint256 supply = pool.totalSupply();
    uint256 reservesAnchor = pool.reserves(anchorIndex);
    uint256 minShares = supply > 0 ? bound(_minShares, 0, supply * amount / reservesAnchor) : bound(_minShares, 0, 3 * amount - pool.MINIMUM_LIQUIDITY());

    (uint256[3] memory reservesBefore, uint256[3] memory balancesBefore) = poolState();
    mintedShares = pool.addLiquidity(anchorIndex, amount, minShares);
    assertReservesTrackBalances(reservesBefore, balancesBefore);
    assertGt(mintedShares, 0);
  }

  function boundIndex(uint256 _index) internal pure returns (uint256 index) {
    index = bound(_index, 0, 2);
  }

  function expectedSwapAmountOut(uint256 indexIn, uint256 amount, uint256 indexOut) internal view returns (uint256) {
    uint256 amountAfterFee = amount * (pool.FEE_DEN() - pool.feeNum()) / pool.FEE_DEN();
    return amountAfterFee * pool.reserves(indexOut) / (amountAfterFee + pool.reserves(indexIn));
  }

  function swapWrapper(uint256 _indexIn, uint256 _amount, uint256 _indexOut, uint256 _minOut) external returns (uint256 amountOut) {
    uint256 indexIn = boundIndex(_indexIn);
    uint256 indexOut = boundIndex(_indexOut);
    uint256 amount = bound(_amount, 1, 21_000_000e8);
    uint256 minOut = bound(_minOut, 0, expectedSwapAmountOut(indexIn, amount, indexOut));

    uint256 kBefore = pool.reserves(indexIn) * pool.reserves(indexOut);
    (uint256[3] memory reservesBefore, uint256[3] memory balancesBefore) = poolState();
    amountOut = pool.swap(indexIn, amount, indexOut, minOut);
    assertReservesTrackBalances(reservesBefore, balancesBefore);

    uint256 kAfter = pool.reserves(indexIn) * pool.reserves(indexOut);
    assertGe(kAfter, kBefore);
  }

  function removeLiquidityWrapper(uint256 _burnedShares) external returns (uint256[3] memory amountsOut) {
    uint256 burnedShares = bound(_burnedShares, 0, pool.balanceOf(address(this)));
    uint256[3] memory minOut;

    (uint256[3] memory reservesBefore, uint256[3] memory balancesBefore) = poolState();
    amountsOut = pool.removeLiquidity(burnedShares, minOut);
    assertReservesTrackBalances(reservesBefore, balancesBefore);
  }

  function addThenRemoveRoundTrip(uint256 _anchorIndex, uint256 _amount) external {
    uint256 anchorIndex = bound(_anchorIndex, 0, 2);
    uint256 amount = bound(_amount, 334, 21_000_000e8);

    uint256 wbtcBefore = wbtc.balanceOf(address(this));
    uint256 cbbtcBefore = cbbtc.balanceOf(address(this));
    uint256 lbtcBefore = lbtc.balanceOf(address(this));

    uint256 mintedShares = pool.addLiquidity(anchorIndex, amount, 0);
    uint256[3] memory minOut;
    pool.removeLiquidity(mintedShares, minOut);

    assertLe(wbtc.balanceOf(address(this)), wbtcBefore);
    assertLe(cbbtc.balanceOf(address(this)), cbbtcBefore);
    assertLe(lbtc.balanceOf(address(this)), lbtcBefore);
  }
}

contract PoolInvariantTest is Test, PoolTestBase {
  PoolHandler public handler;
  uint256 public lastShareValue;

  function setUp() public override {
    super.setUp();
    handler = new PoolHandler(wbtc, cbbtc, lbtc, pool);
    wbtc.transfer(address(handler), 21_000_000e8);
    cbbtc.transfer(address(handler), 21_000_000e8);
    lbtc.transfer(address(handler), 21_000_000e8);

    targetContract(address(handler));
  }

  function invariant_reservesNeverExceedBalances() view public {
    assertLe(pool.reserves(0), wbtc.balanceOf(address(pool)));
    assertLe(pool.reserves(1), cbbtc.balanceOf(address(pool)));
    assertLe(pool.reserves(2), lbtc.balanceOf(address(pool)));
  }

  function invariant_shareValueNeverDecreases() public {
    uint256 supply = pool.totalSupply();
    if (supply == 0) return;

    uint256 currentShareValue = (uint256(pool.reserves(0)) + pool.reserves(1) + pool.reserves(2)) * 1e18 / supply;
    assertGe(currentShareValue, lastShareValue);
    lastShareValue = currentShareValue;
  }

  // Slot of `reserves` in Pool's storage. The packing of `uint72[3]` means
  // all three values live in a single slot; the high-order bits carry
  // reserves[2] and the low-order bits carry reserves[0]. The slot is
  // resolved at test time by reading the public getter and scanning
  // candidate slots, so a layout shift in OZ or in the parent contracts
  // surfaces as a clean probe failure rather than a silent wrong write.
  function _findReservesSlot() internal returns (bytes32) {
    handler.addLiquidityWrapper(0, 1_000e8, 0);

    uint256 r0 = pool.reserves(0);
    uint256 r1 = pool.reserves(1);
    uint256 r2 = pool.reserves(2);
    require(r0 == r1 && r1 == r2, "seed reserves not equal; bootstrap changed shape");
    uint256 packed = (r2 << 144) | (r1 << 72) | r0;

    for (uint256 i = 0; i < 20; i++) {
      bytes32 slot = bytes32(i);
      bytes32 value = vm.load(address(pool), slot);
      if (uint256(value) == packed) {
        return slot;
      }
    }
    revert("reserves slot not found in slots 0..19");
  }

  function test_InsufficientReserveReachedViaForgedState() public {
    bytes32 reservesSlot = _findReservesSlot();

    uint256 r1Before = pool.reserves(1);
    require(r1Before > 0, "seed reserves[1] must be positive");

    bytes32 current = vm.load(address(pool), reservesSlot);
    bytes32 zeroedReserves0 = current & ~bytes32(uint256((uint256(1) << 72) - 1));
    vm.store(address(pool), reservesSlot, zeroedReserves0);

    require(pool.reserves(0) == 0, "vm.store did not zero reserves[0]");
    require(pool.reserves(1) == r1Before, "vm.store touched reserves[1]");

    vm.expectRevert(Pool.InsufficientReserve.selector);
    pool.swap(0, 1000, 1, 0);
  }
}
