// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";

contract MockWrappedBTC is ERC20Capped {

  constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC20Capped(21_000_000e8) {
  }

  function decimals() public pure override returns (uint8) {
    return 8;
  }

  function mint(address account, uint256 value) external {
    _mint(account, value);
  }
}
