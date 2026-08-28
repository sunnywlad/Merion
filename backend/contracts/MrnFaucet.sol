// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// V.0 — Faucet MRN pour la démo de soutenance et les consultants. Un seul
// trésor pré-alloué, pas de mint, pas d'inflation : la supply reste celle
// créditée au déployeur à la construction du MRN (« MRN has NO mint
// function » dans `merion.md`). Le motif vient des faucets BTC du début de
// la blockchain — un réservoir pré-financé, pas une création de monnaie.
//
// Fonctionnement :
//   1. Au déploiement, le déployeur (owner du pool) transfère 10 M MRN
//      depuis son solde vers ce contrat, via un script de seed.
//   2. N'importe qui appelle `drip()` et reçoit `dripAmount` MRN, sous
//      réserve du rate-limit `dripInterval` par adresse.
//   3. L'owner peut retirer le résiduel via `withdraw()` à la fin de la
//      soutenance ou pour re-financer ailleurs.
//
// Pas de `dripTo()` : il n'y a pas de liste blanche de jurés. Le rate-limit
// empêche un acteur unique de vider le faucet ; tous les autres y ont accès
// dans la même fenêtre. La pré-alimentation est calibrée pour la démo et
// les consultants, pas pour un usage production.
contract MrnFaucet is Ownable {
  using SafeERC20 for IERC20;

  IERC20 public immutable mrn;
  uint256 public immutable dripAmount;
  uint256 public immutable dripInterval;

  mapping(address => uint256) public lastDripAt;

  event Dripped(address indexed recipient, uint256 amount);
  event Withdrawn(address indexed to, uint256 amount);

  error FaucetEmpty();
  error TooEarly(uint256 nextAllowedAt);

  constructor(
    address _mrn,
    uint256 _dripAmount,
    uint256 _dripInterval,
    address _owner
  ) Ownable(_owner) {
    mrn = IERC20(_mrn);
    dripAmount = _dripAmount;
    dripInterval = _dripInterval;
  }

  function drip() external {
    uint256 nextAllowedAt = lastDripAt[msg.sender] + dripInterval;
    require(block.timestamp >= nextAllowedAt, TooEarly(nextAllowedAt));
    require(mrn.balanceOf(address(this)) >= dripAmount, FaucetEmpty());
    lastDripAt[msg.sender] = block.timestamp;
    mrn.safeTransfer(msg.sender, dripAmount);
    emit Dripped(msg.sender, dripAmount);
  }

  function withdraw(uint256 amount) external onlyOwner {
    mrn.safeTransfer(owner(), amount);
    emit Withdrawn(owner(), amount);
  }
}
