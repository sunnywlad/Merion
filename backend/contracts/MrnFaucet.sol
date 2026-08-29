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
/// @title MrnFaucet
/// @notice Demo and consultant-facing MRN faucet. Holds a pre-funded
///         MRN reserve and drips a fixed amount to any caller, rate-
///         limited per address. No mint, no whitelist.
/// @dev No mint: the reserve is seeded by a transfer from the deployer,
///      so the MRN supply is unchanged.
contract MrnFaucet is Ownable {
  using SafeERC20 for IERC20;

  /// @notice The MRN token distributed by the faucet.
  IERC20 public immutable mrn;
  /// @notice Amount of MRN sent to each successful `drip` call.
  uint256 public immutable dripAmount;
  /// @notice Minimum delay, in seconds, between two consecutive drips
  ///         to the same caller.
  uint256 public immutable dripInterval;

  /// @notice Timestamp of the last successful drip, per address. The
  ///         rate-limit is enforced by comparing
  ///         `lastDripAt[msg.sender] + dripInterval` against
  ///         `block.timestamp`.
  mapping(address => uint256) public lastDripAt;

  /// @notice Emitted when a caller successfully drips from the faucet.
  /// @param recipient Address that received the MRN.
  /// @param amount Amount transferred, equal to `dripAmount`.
  event Dripped(address indexed recipient, uint256 amount);

  /// @notice Emitted when the owner withdraws leftover MRN from the
  ///         faucet to themselves.
  /// @param to Address that received the withdrawn MRN (the owner).
  /// @param amount Amount withdrawn.
  event Withdrawn(address indexed to, uint256 amount);

  /// @notice The faucet does not hold enough MRN to satisfy the next
  ///         drip. Reached only when `mrn.balanceOf(this) < dripAmount`.
  error FaucetEmpty();

  /// @notice The caller dripped too recently; they must wait until
  ///         `nextAllowedAt` to drip again.
  /// @param nextAllowedAt The earliest timestamp at which the next
  ///        drip from the caller is allowed.
  error TooEarly(uint256 nextAllowedAt);

  /// @notice Deploys the faucet with its immutable parameters.
  /// @param _mrn Address of the MRN token to dispense.
  /// @param _dripAmount Amount of MRN per drip, in MRN's 18 decimals.
  /// @param _dripInterval Per-address cooldown, in seconds.
  /// @param _owner Owner of the faucet, allowed to call `withdraw`.
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

  /// @notice Sends `dripAmount` MRN to the caller, subject to the
  ///         per-address rate-limit and the faucet's balance.
  /// @dev Permissionless. Reverts with `TooEarly` if the caller
  ///      dripped within the last `dripInterval` seconds, and with
  ///      `FaucetEmpty` if the faucet has been drained. Updates
  ///      `lastDripAt[msg.sender]` before the transfer (CEI).
  function drip() external {
    // R2 — la lecture de `lastDripAt[msg.sender]` est mise en cache
    // dans une locale, ce qui elimine une deuxieme SLOAD (la 1re
    // est obligatoire, la 2e suivait immediatement pour le calcul
    // de `nextAllowedAt`). Le `TooEarly` emporte la valeur
    // recalculee (`lastDrip + dripInterval`), pas la locale, pour
    // preserver l'ABI d'erreur exacte.
    uint256 lastDrip = lastDripAt[msg.sender];
    require(block.timestamp >= lastDrip + dripInterval, TooEarly(lastDrip + dripInterval));
    require(mrn.balanceOf(address(this)) >= dripAmount, FaucetEmpty());
    lastDripAt[msg.sender] = block.timestamp;
    mrn.safeTransfer(msg.sender, dripAmount);
    emit Dripped(msg.sender, dripAmount);
  }

  /// @notice Withdraws `amount` MRN from the faucet to the owner.
  /// @dev Owner-only. The owner can use this to reclaim the leftover
  ///      reserve at the end of the demo, or to refill the faucet
  ///      elsewhere. Reverts with `ERC20InsufficientBalance` if the
  ///      faucet holds less than `amount`.
  /// @param amount Amount of MRN to withdraw.
  function withdraw(uint256 amount) external onlyOwner {
    mrn.safeTransfer(owner(), amount);
    emit Withdrawn(owner(), amount);
  }
}
