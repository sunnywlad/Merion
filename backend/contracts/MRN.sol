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
contract MRN is ERC20, ERC20Burnable {
  constructor() ERC20("Merion", "MRN") ERC20Burnable() {
    _mint(msg.sender, 100000000 * 10**18);
  }
}
