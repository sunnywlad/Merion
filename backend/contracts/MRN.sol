// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

// I.3 — MRN herite desormais ERC20Burnable. Le motif tient en une phrase
// (build-auction.md 4.5) : `mrn.burn(30 %)` est la moitie droite du partage
// des produits de l'enchere, et un ERC-20 sans `burn` ne peut pas le faire
// sans mentir, parce qu'un transfert vers 0x...dEaD ne reduit pas le
// `totalSupply`. La migration de bytecode change les adresses deterministes
// du deploiement MRN : le module Ignition `mrn.ts` continue de fonctionner,
// mais la nouvelle MRN n'herite d'aucune ancienne adresse.
/// @title MRN
/// @notice Merion's native ERC-20 token, used to bid in the auction,
///         pay LP rent, and settle protocol revenue. Pre-mints a fixed
///         supply to the deployer; no further mint is possible.
/// @dev Inherits `ERC20Burnable` so the auction can burn its 30 % share
///      of the settlement amount (see `Auction._settle`). Has no
///      `mint` function beyond the constructor.
contract MRN is ERC20, ERC20Burnable {

  /// @notice Deploys the MRN token, mints the entire 100,000,000 MRN
  ///         supply to the deployer, and grants no further mint
  ///         authority.
  /// @dev The initial mint is the only mint the contract will ever
  ///      perform. Subsequent supply changes can only happen through
  ///      `burn`, called by the auction.
  constructor() ERC20("Merion", "MRN") ERC20Burnable() {
    _mint(msg.sender, 100000000 * 10**18);
  }
}
