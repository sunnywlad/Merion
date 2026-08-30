// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockReentrantBTC
/// @notice Test-only 8-decimal WBTC-shaped ERC-20 carrying a payer-side
///         hook on `transferFrom`. Exists for one purpose: prove the F4
///         re-entrancy guard on `Pool.addLiquidity` /
///         `Pool.removeLiquidity` / `Pool.swap`.
/// @dev Real WBTC, cbBTC, LBTC and `MockWrappedBTC` have no such hook,
///      which is exactly why F4 was rated "HAUT sous condition": the
///      pool's safety rested on a property of TODAY'S basket, not on a
///      guard of its own. This mock supplies the missing condition so
///      the guard can be exercised instead of merely argued about.
///
///      The hook fires INSIDE `transferFrom`, i.e. at the instant
///      `addLiquidity` has already minted the LP shares and written all
///      three reserves but has collected at most one of the three
///      tokens. `reenterTarget` / `reenterData` are set by the test to
///      point at `Pool.removeLiquidity`, the entry point that carries
///      neither `whenNotPaused` nor, before F4, `nonReentrant`.
///
///      `armed` is a one-shot latch: without it the re-entrant call's
///      own transfers would fire the hook again and the test would
///      observe an unbounded recursion instead of the guard. It is
///      cleared before the external call, so the mock never re-enters
///      itself.
contract MockReentrantBTC is ERC20 {

  /// @notice Contract the `transferFrom` hook calls back into. Zero
  ///         disables the hook entirely, which is what lets the same
  ///         token bootstrap the pool before the attack.
  address public reenterTarget;
  /// @notice Raw calldata sent to `reenterTarget` by the hook.
  bytes public reenterData;
  /// @notice One-shot latch: the hook fires on the next `transferFrom`
  ///         and disarms itself.
  bool public armed;

  /// @notice Low-level success flag of the last re-entrant call, kept
  ///         for the test to read if it ever wants to assert on a
  ///         SWALLOWED revert. The attack path in
  ///         `test/Pool.reentrancy.test.ts` does NOT swallow: the hook
  ///         bubbles the revert data up so the guard's custom error
  ///         reaches the outer transaction.
  bool public lastCallSucceeded;

  /// @notice Deploys the mock with the given name and symbol. No cap:
  ///         the F4 test needs to mint freely, and the 21M cap of
  ///         `MockWrappedBTC` is irrelevant to re-entrancy.
  /// @param name_ ERC-20 full name.
  /// @param symbol_ ERC-20 ticker.
  constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

  /// @notice Returns the token decimals, fixed at 8. The pool's
  ///         constructor requires exactly 8 (`InvalidTokenDecimals`).
  /// @return The number of decimals (8).
  function decimals() public pure override returns (uint8) {
    return 8;
  }

  /// @notice Mints `value` tokens to `account`. Permissionless, test-only.
  /// @param account Recipient of the newly minted tokens.
  /// @param value Amount to mint, in 8-decimal units.
  function mint(address account, uint256 value) external {
    _mint(account, value);
  }

  /// @notice Arms the payer-side hook for exactly one `transferFrom`.
  /// @param target Contract to call back into (the pool).
  /// @param data Raw calldata for that call (e.g. an encoded
  ///        `removeLiquidity`).
  function armReentrancy(address target, bytes calldata data) external {
    reenterTarget = target;
    reenterData = data;
    armed = true;
  }

  /// @notice Disarms the hook without clearing the stored target/data.
  function disarm() external {
    armed = false;
  }

  /// @dev Standard ERC-20 `transferFrom`, plus the one-shot hook fired
  ///      BEFORE the balances move, so the re-entrant call sees the pool
  ///      at its most inconsistent: reserves credited, tokens not yet in.
  ///      A revert coming back from the target is bubbled up verbatim,
  ///      selector included, so the outer test can assert on
  ///      `ReentrancyGuardReentrantCall` rather than on a boolean.
  function transferFrom(address from, address to, uint256 value) public override returns (bool) {
    if (armed && reenterTarget != address(0)) {
      armed = false;
      (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
      lastCallSucceeded = ok;
      if (!ok) {
        assembly {
          revert(add(ret, 32), mload(ret))
        }
      }
    }
    return super.transferFrom(from, to, value);
  }
}
