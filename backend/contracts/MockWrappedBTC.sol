// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";

/// @title MockWrappedBTC
/// @notice Test-only WBTC-shaped ERC-20 with 8 decimals and a hard cap
///         equal to BTC's 21M coin supply. Used as a stand-in for WBTC,
///         cbBTC or LBTC in the Merion test suite, never deployed to
///         production.
contract MockWrappedBTC is ERC20Capped {

  /// @notice Deploys the mock token with the given name and symbol, and
  ///         caps the total supply at 21,000,000 tokens (BTC-mimicking).
  /// @param name_ ERC-20 full name (e.g. "Wrapped BTC").
  /// @param symbol_ ERC-20 ticker (e.g. "WBTC").
  constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC20Capped(21_000_000e8) {
  }

  /// @notice Returns the token decimals, fixed at 8 to mirror BTC.
  /// @return The number of decimals (8).
  function decimals() public pure override returns (uint8) {
    return 8;
  }

  /// @notice Mints `value` tokens to `account`, subject to the 21M cap.
  /// @dev Permissionless on purpose: this is a test-only mock, not a
  ///      production token. The cap is enforced by `ERC20Capped._mint`.
  /// @param account Recipient of the newly minted tokens.
  /// @param value Amount to mint, in 8-decimal units.
  function mint(address account, uint256 value) external {
    _mint(account, value);
  }
}
