// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
using SafeERC20 for IERC20;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Pool
/// @notice Merion's BTC-denominated tri-token AMM. Holds three
///         8-decimal WBTC-like tokens, mints LP shares, charges a
///         manager-controlled fee, pays MRN rent to LPs, and routes
///         fees to the manager and to the protocol treasury.
/// @dev Reserves are packed into a single 256-bit slot and read through
///      the `reserves(uint256)` ABI-compatible getter. The fee is reset
///      lazily each epoch rather than written on rollover. `pause` gates
///      `addLiquidity` and `swap` only: exits and claims stay open.
///
/// AUDIT F4/F5/F6/F7/F8 — cinq failles corrigees dans ce fichier :
///   F4 : `addLiquidity` / `removeLiquidity` / `swap` sont desormais
///        `nonReentrant` (voir `addLiquidity`).
///   F5 : la rente qui s'ecoulait pendant que le pool n'a plus de LP
///        vivant etait attribuee a l'adresse morte, donc perdue. Elle
///        est reportee dans `rentLeftOver` (voir `_updateRent`).
///   F6 : l'owner pouvait reserver toutes les epochs futures d'un coup
///        (voir `setManager`).
///   F7 : le gestionnaire de l'epoch 0 ne pouvait pas appeler `setFee`
///        (voir le constructeur et `lastSetFeeEpoch`).
///   F8 : la branche d'amorcage d'`addLiquidity` n'avait pas la garde
///        d'overflow uint72 de la branche normale.
contract Pool is ERC20, Ownable, Pausable, ReentrancyGuard {

  /// @notice First token of the pool's basket (e.g. WBTC).
  address public immutable token0;
  /// @notice Second token of the pool's basket (e.g. cbBTC).
  address public immutable token1;
  /// @notice Third token of the pool's basket (e.g. LBTC).
  address public immutable token2;

  /// @dev Current reserves of the three basket tokens, packed in a
  ///      single 256-bit storage slot. Indexed 0/1/2 to match
  ///      `token0/token1/token2`. Read via the `reserves(uint256)`
  ///      public getter.
  uint256 private _reservesPacked;
  /// @notice Lower band coefficient: any reserve must stay above
  ///         `floor * sum / 100` after a swap.
  uint8 public constant floor = 13;
  /// @notice Upper band coefficient: any reserve must stay below
  ///         `ceiling * sum / 100` after a swap.
  uint8 public constant ceiling = 53;

  /// @notice Base fee numerator for the current epoch, in units of
  ///         `FEE_DEN`. Reset lazily to `NOMINAL_FEE_NUM` once the
  ///         epoch advances; see `feeInForce`.
  uint16 public feeNum;
  /// @notice Epoch number at which `feeNum` was last written by the
  ///         manager. Compared against `currentEpoch` to decide
  ///         whether the manager's override still applies.
  /// @dev F7: seeded to `type(uint32).max` by the constructor as a
  ///      "never set" sentinel. It used to be left at the default 0,
  ///      which collides with epoch 0: the manager of the very first
  ///      epoch got `FeeAlreadySetThisEpoch` without having written
  ///      anything, and `feeInForce()` took the manager branch during
  ///      that epoch on a value nobody had chosen. The sentinel is a
  ///      real epoch number in theory, reached about 1.96 million years
  ///      after `GENESIS`; if the chain ever got there, the only effect
  ///      would be that this single epoch's manager cannot set a fee and
  ///      the pool charges `feeNum` (which equals `NOMINAL_FEE_NUM`
  ///      unless a manager wrote it). No value can be stolen either way.
  uint32 public lastSetFeeEpoch;
  /// @notice Absolute maximum fee numerator (in `FEE_DEN` units) that
  ///         any surcharge may reach. `MAX_FEE_NUM / UNBALANCE_FACTOR`
  ///         caps the manager's per-epoch override.
  uint256 constant public MAX_FEE_NUM = 50;
  /// @notice Fee denominator, i.e. basis points for fee math.
  uint256 constant public FEE_DEN = 10000;
  /// @notice Surcharge multiplier applied to the base fee on
  ///         imbalanced swaps (skew detection in
  ///         `effectiveFeeNum`).
  uint256 constant public UNBALANCE_FACTOR = 2;
  /// @notice Width, in basis points of `TOL_DEN`, of the dead-band
  ///         around the balanced point. Below this width, the
  ///         surcharge is not applied.
  uint256 constant public UNBALANCE_TOL_BPS = 200;
  /// @notice Denominator of the imbalance tolerance.
  uint256 constant public TOL_DEN = 10000;
  /// @notice Protocol share of the base fee, in basis points of
  ///         `SPLIT_DEN` (10 %).
  uint256 constant public PROTOCOL_FEE_BPS = 1000;
  /// @notice Denominator of the manager/protocol split.
  uint256 constant public SPLIT_DEN = 10000;
  /// @notice Default base fee numerator applied at the start of
  ///         every epoch, in `FEE_DEN` units, unless the manager
  ///         overrides it inside the priority window.
  uint256 public immutable NOMINAL_FEE_NUM;

  /// @notice Lower bound of the manager's allowed base-fee range,
  ///         in `FEE_DEN` units.
  uint256 public immutable MIN_FEE_NUM;

  /// @notice Unix timestamp of the pool's epoch 0 start.
  uint256 public immutable GENESIS;
  /// @notice Duration of one epoch, in seconds.
  uint256 public immutable EPOCH_DURATION;
  /// @notice Length of the priority window at the start of each
  ///         epoch, in seconds, during which the manager may set
  ///         the fee for that epoch.
  uint256 public immutable PRIORITY_WINDOW;
  /// @notice Protocol treasury: the unique recipient of
  ///         `claimProtocolFees` payouts. Immutable on purpose so
  ///         the cash flow does not follow ownership changes.
  address public immutable treasury;
  /// @notice Address of the MRN token used to pay LP rent.
  /// @dev Captured at deployment as an additional guard against a
  ///      mismatched Pool/Auction wiring: any inconsistency between
  ///      the two contracts surfaces here.
  address public immutable mrn;

  /// @notice Manager elected for a given future epoch, set by the
  ///         auction via `setManager`. Indexed by epoch number.
  mapping(uint256 epoch => address) public managerOf;
  /// @notice Address of the auction contract allowed to call
  ///         `setManager` and `notifyRent`. Set once by the owner
  ///         via `setAuction` and never changed.
  address public auction;

  /// @notice Outstanding base-fee credits owed to each manager,
  ///         per token index. Pulled by `claimManagerFees`.
  mapping(address manager => uint256[3]) public feesOwed;
  /// @notice Outstanding base-fee credits owed to the protocol
  ///         treasury, per token index. Pulled by
  ///         `claimProtocolFees`.
  uint256[3] public protocolFeesOwed;

  /// @notice Lazy rent accumulator, scaled by 1e18. Holds the
  ///         per-share accrued rent; LPs compute their share as
  ///         `balance * accPerShare / 1e18`.
  uint256 public accPerShare;
  /// @notice Current rent emission rate, scaled by 1e18, valid
  ///         between `rentLastUpdate` and `rentEnd`.
  uint256 public rentRate;
  /// @notice Unix timestamp at which the current rent stream ends.
  uint256 public rentEnd;
  /// @notice Last timestamp at which `accPerShare` was advanced
  ///         against `block.timestamp`.
  uint256 public rentLastUpdate;
  /// @notice MRN accumulated while the pool had no live LPs (only
  ///         the dead-address minimum-liquidity shares). Folded
  ///         into the next stream when LPs return.
  /// @dev Two sources feed it. `notifyRent` parks a whole settlement
  ///      here when it lands on an already empty pool. F5 added the
  ///      second: `_updateRent` parks the slice of a RUNNING stream
  ///      that elapsed after the last LP exited, instead of letting
  ///      `accPerShare` credit it to the dead address, where it was
  ///      lost for good. Both are drained by the next `notifyRent`
  ///      that finds a live supply.
  uint256 public rentLeftOver;
  /// @notice Per-address pending rent credit, captured by `_update`
  ///         when shares move.
  mapping(address => uint256) public rentPending;
  /// @notice Per-address rent debt, the checkpoint of
  ///         `balance * accPerShare / 1e18` at the last touch.
  mapping(address => uint256) public rentDebt;

  /// @notice Minimum amount of LP shares permanently locked to the
  ///         dead address on the first liquidity add, to prevent
  ///         the empty-pool share-price attack.
  uint256 constant public MINIMUM_LIQUIDITY = 1000;

  /// @notice Deployment: `nominalFeeNum * UNBALANCE_FACTOR` exceeds
  ///         `MAX_FEE_NUM`, which would let a surcharge breach the
  ///         absolute cap.
  error FeeTooHigh();
  /// @notice Deployment: the manager fee band is empty because
  ///         `minFeeNum * UNBALANCE_FACTOR` already exceeds
  ///         `MAX_FEE_NUM`.
  error EmptyFeeBand();
  /// @notice Deployment: `epochDuration` is zero, which would make
  ///         `currentEpoch` divide by zero.
  error ZeroEpochDuration();
  /// @notice Deployment: `priorityWindow` is greater than
  ///         `epochDuration`; the priority window would never end
  ///         inside an epoch.
  error PriorityWindowTooLong();
  /// @notice Slippage guard: the realised output (or minted share
  ///         amount) is below the caller's minimum tolerance.
  error BadSlippage();
  /// @notice A `uint72`-tracked reserve would overflow after the
  ///         current operation. Defensive guard on swaps and
  ///         add-liquidity.
  error ReserveOverflow();
  /// @notice `swap` would leave the output token's reserve at zero or
  ///         below.
  error InsufficientReserve();
  /// @notice A swap or add-liquidity produced a zero output, which is
  ///         never acceptable.
  error ZeroOutput();
  /// @notice `removeLiquidity` was called while the pool has no
  ///         live supply.
  error NotBootstrapped();
  /// @notice Post-swap reserve of `tokenIndex` fell below the
  ///         `floor` band.
  /// @param tokenIndex The token whose reserve breached the floor.
  error FloorTouched(uint256 tokenIndex);
  /// @notice Post-swap reserve of `tokenIndex` rose above the
  ///         `ceiling` band.
  /// @param tokenIndex The token whose reserve breached the ceiling.
  error CeilingTouched(uint256 tokenIndex);
  /// @notice `setManager` was called by neither the auction nor the
  ///         owner (the owner only when the auction is unset).
  error NotAuctionOrOwner();
  /// @notice `setManager` was called for an epoch that has already
  ///         started, or for the current one.
  error EpochAlreadyStarted();
  /// @notice `setManager` was called with the zero address.
  error ZeroManager();
  /// @notice `setManager` was called twice for the same epoch.
  error ManagerAlreadySet();
  /// @notice F6: the owner's bootstrap path was used to nominate a
  ///         manager further than one epoch ahead. The auction path is
  ///         not subject to this bound.
  /// @param maxEpoch The furthest epoch the owner may nominate, i.e.
  ///        `currentEpoch() + 1`.
  error OwnerEpochTooFar(uint256 maxEpoch);
  /// @notice `setAuction` was called while `auction` is already set.
  error AuctionAlreadySet();
  /// @notice `setFee` was called by an address that is not the
  ///         current epoch's manager.
  error NotManager();
  /// @notice `setFee` was called outside the priority window.
  error OutsidePriorityWindow();
  /// @notice `setFee` was already called during the current epoch
  ///         by the same manager.
  error FeeAlreadySetThisEpoch();
  /// @notice The manager-provided fee numerator is outside the
  ///         allowed `[min, max]` band.
  /// @param min The minimum allowed fee numerator (`MIN_FEE_NUM`).
  /// @param max The maximum allowed fee numerator for this epoch
  ///        (`MAX_FEE_NUM / UNBALANCE_FACTOR`).
  error FeeOutOfBand(uint256 min, uint256 max);
  /// @notice `claimManagerFees` or `claimProtocolFees` was called
  ///         for a token index with no accrued fees.
  error ZeroFeesOwed();
  /// @notice `notifyRent` was called by an address that is not the
  ///         configured auction.
  error NotAuction();
  /// @notice `claimRent` was called by an LP that has no rent
  ///         accrued or pending.
  error ZeroRentOwed();
  /// @notice Deployment: the treasury address is the zero address.
  error InvalidTreasury();
  /// @notice Deployment: two of the three basket tokens share the
  ///         same address.
  error DuplicateToken();
  /// @notice Deployment: one of the three basket tokens is the
  ///         zero address.
  error InvalidTokenAddress();
  /// @notice Deployment: one of the three basket tokens does not
  ///         report 8 decimals.
  error InvalidTokenDecimals();
  /// @notice Deployment: the MRN address is the zero address or
  ///         collides with one of the basket tokens.
  error InvalidMrn();
  /// @notice `reserves(uint256)` was called with an index outside
  ///         the [0, 2] range. Mirrors the panic 0x32 that the
  ///         auto-getter would have raised, for ABI-compat callers.
  error InvalidReserveIndex();

  /// @notice Emitted when the manager sets the base fee for the
  ///         current epoch.
  /// @param epoch The epoch the fee applies to.
  /// @param manager The manager who set the fee.
  /// @param oldFee The previous base-fee numerator.
  /// @param newFee The new base-fee numerator.
  event FeeSet(uint256 indexed epoch, address indexed manager, uint256 oldFee, uint256 newFee);
  /// @notice Emitted on every successful liquidity provision.
  /// @param provider The address that received the LP shares.
  /// @param amountsIn The three token amounts deposited.
  /// @param mintedShares The amount of LP shares minted to the
  ///        provider (dead-address mint excluded).
  event AddedLiquidity(address indexed provider, uint256[3] amountsIn, uint256 mintedShares);
  /// @notice Emitted on every successful liquidity removal.
  /// @param provider The address that burned LP shares.
  /// @param amountsOut The three token amounts withdrawn.
  /// @param burnedShares The amount of LP shares burned.
  event RemovedLiquidity(address indexed provider, uint256[3] amountsOut, uint256 burnedShares);
  /// @notice Emitted on every successful swap.
  /// @param swapper The address that initiated the swap.
  /// @param indexIn The token index of the input side.
  /// @param amountIn The input amount transferred in.
  /// @param indexOut The token index of the output side.
  /// @param amountOut The output amount transferred out.
  event Swapped(address indexed swapper, uint256 indexed indexIn, uint256 amountIn, uint256 indexed indexOut, uint256 amountOut);
  /// @notice Emitted when the auction nominates a manager for a
  ///         future epoch.
  /// @param epoch The epoch the manager is designated for.
  /// @param manager The address chosen as manager.
  event ManagerSet(uint256 indexed epoch, address indexed manager);
  /// @notice Emitted when the auction notifies a new rent stream.
  /// @param amount The MRN amount of the new stream (excluding any
  ///        rolled-in `rentLeftOver`).
  /// @param rate The new emission rate, scaled by 1e18.
  /// @param end The unix timestamp at which the stream ends.
  event RentNotified(uint256 amount, uint256 rate, uint256 end);
  /// @notice Emitted when an LP successfully claims accrued rent.
  /// @param claimant The address that received the MRN.
  /// @param amount The MRN amount transferred.
  event RentClaimed(address indexed claimant, uint256 amount);

  /// @notice Deploys the pool, validates all immutable parameters,
  ///         and seeds `feeNum` to the nominal value.
  /// @dev Performs the deployment-time guards in the following
  ///      order: fee-band sanity, non-zero epoch duration, priority
  ///      window bounded by epoch duration, treasury non-zero,
  ///      tokens non-zero and pairwise distinct, MRN non-zero and
  ///      distinct from the basket tokens, and all three basket
  ///      tokens reporting 8 decimals.
  /// @param _tokens The three basket tokens (WBTC, cbBTC, LBTC or
  ///        mocks).
  /// @param _epochDuration Length of one epoch, in seconds.
  /// @param _priorityWindow Length of the manager's fee-setting
  ///        window at the start of each epoch.
  /// @param _minFeeNum Lower bound of the manager's allowed
  ///        base-fee numerator.
  /// @param _nominalFeeNum Default base-fee numerator.
  /// @param _treasury Protocol treasury, recipient of
  ///        `claimProtocolFees` payouts.
  /// @param _mrn Address of the MRN rent token.
  /// @param _owner Initial owner of the pool (typically the
  ///        deployer).
  constructor(
    address[3] memory _tokens,
    uint256 _epochDuration,
    uint256 _priorityWindow,
    uint256 _minFeeNum,
    uint256 _nominalFeeNum,
    address _treasury,
    address _mrn,
    address _owner
  ) ERC20("MerionLP", "MRNLP") Ownable(_owner) {
    GENESIS = block.timestamp;
    EPOCH_DURATION = _epochDuration;
    PRIORITY_WINDOW = _priorityWindow;
    require(_nominalFeeNum * UNBALANCE_FACTOR <= MAX_FEE_NUM, FeeTooHigh());
    require(_minFeeNum * UNBALANCE_FACTOR <= MAX_FEE_NUM, EmptyFeeBand());
    require(_epochDuration > 0, ZeroEpochDuration());
    require(_priorityWindow <= _epochDuration, PriorityWindowTooLong());

    MIN_FEE_NUM = _minFeeNum;
    NOMINAL_FEE_NUM = _nominalFeeNum;
    require(_treasury != address(0), InvalidTreasury());
    treasury = _treasury;
    mrn = _mrn;

    feeNum = uint16(_nominalFeeNum);
    // F7: sentinelle "aucun tarif de mandat n'a jamais ete pose". Voir
    // la NatSpec de `lastSetFeeEpoch`. Sans elle, le zero par defaut
    // egale l'epoch 0 et ferme `setFee` au tout premier gestionnaire.
    lastSetFeeEpoch = type(uint32).max;

    token0 = _tokens[0];
    token1 = _tokens[1];
    token2 = _tokens[2];
    require(token0 != address(0) && token1 != address(0) && token2 != address(0), InvalidTokenAddress());
    require(token0 != token1 && token1 != token2 && token0 != token2, DuplicateToken());
    require(_mrn != address(0) && _mrn != token0 && _mrn != token1 && _mrn != token2, InvalidMrn());
    require(IERC20Metadata(token0).decimals() == 8, InvalidTokenDecimals());
    require(IERC20Metadata(token1).decimals() == 8, InvalidTokenDecimals());
    require(IERC20Metadata(token2).decimals() == 8, InvalidTokenDecimals());
  }

  /// @notice LP share decimals, fixed at 8 to match the basket tokens.
  /// @return The number of decimals (8).
  function decimals() public pure override returns (uint8) {
    return 8;
  }

  /// @notice Returns the reserve of the basket token at index `_index`
  ///         (0, 1 or 2). Preserves the ABI of the former
  ///         `uint72[3] public reserves` so off-chain callers see no
  ///         change; the storage backing moved from a 3-slot
  ///         `uint72[3]` to a single 256-bit packed slot.
  /// @dev One SLOAD on the packed slot, then a conditional shift.
  ///      Reverts with `InvalidReserveIndex` for indices outside
  ///      `[0, 2]`, matching the out-of-bounds semantics of the
  ///      original auto-getter (panic 0x32).
  /// @param _index The token index (0, 1 or 2).
  /// @return The reserve in token units.
  function reserves(uint256 _index) public view returns (uint72) {
    uint256 packed = _reservesPacked;
    if (_index == 0) return uint72(packed);
    if (_index == 1) return uint72(packed >> 72);
    if (_index == 2) return uint72(packed >> 144);
    revert InvalidReserveIndex();
  }

  function _loadReserves() internal view returns (uint72[3] memory r) {
    uint256 packed = _reservesPacked;
    unchecked {
      r[0] = uint72(packed);
      r[1] = uint72(packed >> 72);
      r[2] = uint72(packed >> 144);
    }
  }

  function _storeReserves(uint72[3] memory r) internal {
    unchecked {
      _reservesPacked =
        (uint256(r[0])) |
        (uint256(r[1]) << 72) |
        (uint256(r[2]) << 144);
    }
  }

  function _setReserves(uint72 r0, uint72 r1, uint72 r2) internal {
    unchecked {
      _reservesPacked =
        (uint256(r0)) |
        (uint256(r1) << 72) |
        (uint256(r2) << 144);
    }
  }

  /// @notice Returns the current epoch derived from `GENESIS` and
  ///         `EPOCH_DURATION`.
  /// @return The current epoch number, zero-based.
  function currentEpoch() public view returns (uint256) {
    return (block.timestamp - GENESIS) / EPOCH_DURATION;
  }

  /// @notice Returns the manager elected for the current epoch, or
  ///         the zero address if none has been set.
  /// @return The current epoch's manager address.
  function manager() public view returns (address) {
    return managerOf[currentEpoch()];
  }

  /// @notice One-shot registration of the auction contract.
  /// @dev Reverts with `AuctionAlreadySet` on any second call.
  /// @param _auction Address of the auction contract allowed to
  ///        call `setManager` and `notifyRent`.
  function setAuction(address _auction) external onlyOwner {
    require(auction == address(0), AuctionAlreadySet());
    auction = _auction;
  }

  /// @notice Designates `_who` as the manager of a future epoch.
  ///         Callable by the auction (normal path) or, before the
  ///         auction is wired, by the owner.
  /// @dev Reverts with `NotAuctionOrOwner` if the caller is neither
  ///      the auction nor the owner (the owner only while the auction
  ///      is unset), with `EpochAlreadyStarted` if the target epoch is
  ///      not strictly in the future, with `ZeroManager` for the
  ///      zero address, and with `ManagerAlreadySet` on duplicate
  ///      nominations.
  ///
  ///      F6 — the owner's bootstrap path is bounded to
  ///      `currentEpoch() + 1`. What was possible before: while
  ///      `auction` is still the zero address, the owner could nominate
  ///      a manager for ANY future epoch, as many times as he liked, and
  ///      `managerOf` is write-once. A malicious owner reserved the next
  ///      N epochs before wiring the auction; every settlement of those
  ///      epochs then reverted `ManagerAlreadySet` inside `_settle`,
  ///      which was exactly the F1 brick with a different trigger. The
  ///      bound holds because the owner can now only ever hold the one
  ///      epoch the auction has not yet had time to sell, and each new
  ///      grab costs him one epoch of wall-clock time.
  ///
  ///      The auction path is untouched on purpose: the auction only
  ///      ever writes `currentEpoch() + 1` anyway (it derives
  ///      `pendingEpoch` from its own `sellingEpoch`), and adding a
  ///      bound there would be a second, redundant place to keep in
  ///      sync with the auction's clock.
  /// @param _epoch The epoch to set, strictly greater than
  ///        `currentEpoch`, and at most `currentEpoch + 1` when the
  ///        caller is the owner.
  /// @param _who The address to designate as manager.
  function setManager(uint256 _epoch, address _who) external {
    bool isAuction = msg.sender == auction;
    require(isAuction || (auction == address(0) && msg.sender == owner()), NotAuctionOrOwner());
    uint256 epochNow = currentEpoch();
    require(_epoch > epochNow, EpochAlreadyStarted());
    if (!isAuction) {
      require(_epoch <= epochNow + 1, OwnerEpochTooFar(epochNow + 1));
    }
    require(_who != address(0), ZeroManager());
    require(managerOf[_epoch] == address(0), ManagerAlreadySet());
    managerOf[_epoch] = _who;
    emit ManagerSet(_epoch, _who);
  }

  /// @notice Returns the base fee numerator currently in effect.
  ///         Equals `feeNum` if the manager set it during the
  ///         current epoch, otherwise the immutable
  ///         `NOMINAL_FEE_NUM` (lazy reset).
  /// @return The active base fee numerator, in `FEE_DEN` units.
  function feeInForce() public view returns (uint256) {
    return lastSetFeeEpoch == currentEpoch() ? feeNum : NOMINAL_FEE_NUM;
  }

  /// @notice Returns the fee numerator that should be applied to a
  ///         swap from `_indexIn` to `_indexOut`, accounting for the
  ///         directional surcharge when the pool is imbalanced.
  /// @dev The surcharge applies when the input reserve exceeds the
  ///      output reserve by more than `UNBALANCE_TOL_BPS`, and is
  ///      floored at `NOMINAL_FEE_NUM * UNBALANCE_FACTOR` so a
  ///      zero-base manager cannot make the pool free when it is
  ///      most imbalanced.
  /// @param _indexIn The token index of the input side.
  /// @param _indexOut The token index of the output side.
  /// @return The effective fee numerator, in `FEE_DEN` units.
  function effectiveFeeNum(uint256 _indexIn, uint256 _indexOut) public view returns (uint256) {
    return _computeEffective(feeInForce(), _indexIn, _indexOut, _loadReserves());
  }

  function _computeEffective(
    uint256 _base,
    uint256 _indexIn,
    uint256 _indexOut,
    uint72[3] memory _r
  ) internal view returns (uint256) {
    if (_r[_indexIn] * TOL_DEN > _r[_indexOut] * (TOL_DEN + UNBALANCE_TOL_BPS)) {
      uint256 candidate = _base * UNBALANCE_FACTOR;
      uint256 floorSurcharge = NOMINAL_FEE_NUM * UNBALANCE_FACTOR;
      return candidate > floorSurcharge ? candidate : floorSurcharge;
    }
    return _base;
  }

  function _getAmountOut(uint72[3] memory _cachedReserves, uint256 _indexIn, uint256 _indexOut, uint256 _dxAfterFee) internal pure returns (uint256) {
    return _dxAfterFee * _cachedReserves[_indexOut] / (_dxAfterFee + _cachedReserves[_indexIn]);
  }

  /// @notice Routing quote following the Curve `get_dy` convention:
  ///         returns the swap output for a given input on the
  ///         pre-swap state.
  /// @dev Not an execution promise: no execution guards (bands,
  ///      pause, zero-output, insufficient-reserve) are applied
  ///      here. The view never reverts on a state that would make
  ///      `swap` fail, which lets aggregators always receive a
  ///      number and decide what to do with the impossibility.
  /// @param _indexIn The token index of the input side.
  /// @param _indexOut The token index of the output side.
  /// @param _dx The input amount.
  /// @return The expected output amount, before any slippage check.
  function get_dy(uint256 _indexIn, uint256 _indexOut, uint256 _dx) external view returns (uint256) {
    uint72[3] memory cachedReserves = _loadReserves();
    uint256 effective = effectiveFeeNum(_indexIn, _indexOut);
    uint256 feeAmount = Math.ceilDiv(_dx * effective, FEE_DEN);
    return _getAmountOut(cachedReserves, _indexIn, _indexOut, _dx - feeAmount);
  }

  /// @notice Lets the current epoch's manager set the base fee
  ///         numerator once, inside the priority window.
  /// @dev Reverts with `NotManager` if the caller is not the
  ///      current manager, with `OutsidePriorityWindow` if called
  ///      outside the window, with `FeeAlreadySetThisEpoch` on a
  ///      second call in the same epoch, and with `FeeOutOfBand` if
  ///      the value falls outside `[MIN_FEE_NUM, MAX_FEE_NUM /
  ///      UNBALANCE_FACTOR]`. Intentionally not gated by
  ///      `whenNotPaused`: setting a fee does not move value.
  /// @param _feeNum The new base-fee numerator, in `FEE_DEN` units.
  function setFee(uint256 _feeNum) external {
    uint256 epoch = currentEpoch();
    require(msg.sender == managerOf[epoch], NotManager());
    require((block.timestamp - GENESIS) % EPOCH_DURATION < PRIORITY_WINDOW, OutsidePriorityWindow());
    require(lastSetFeeEpoch != epoch, FeeAlreadySetThisEpoch());
    uint256 maxManagerFeeNum = MAX_FEE_NUM / UNBALANCE_FACTOR;
    require(
      _feeNum >= MIN_FEE_NUM && _feeNum <= maxManagerFeeNum,
      FeeOutOfBand(MIN_FEE_NUM, maxManagerFeeNum)
    );

    emit FeeSet(epoch, msg.sender, feeNum, _feeNum);
    feeNum = uint16(_feeNum);
    lastSetFeeEpoch = uint32(epoch);
  }

  /// @notice Pauses the value-moving entry points (`addLiquidity`,
  ///         `swap`). Owner-only. Reverts if already paused.
  function pause() external onlyOwner {
    _pause();
  }
  /// @notice Resumes the value-moving entry points. Owner-only.
  ///         Reverts if already unpaused.
  function unpause() external onlyOwner {
    _unpause();
  }

  function indexToAddress(uint256 _tokenIndex) internal view returns (address tokenAddress) {
    if (_tokenIndex == 0) {
      tokenAddress = token0;
    }  else if (_tokenIndex == 1) {
      tokenAddress = token1;
    } else if (_tokenIndex == 2) {
      tokenAddress = token2;
    }
  }

  /// @notice Adds liquidity to the pool against an anchor reserve.
  /// @dev On the first add, mints `3 * _amount - MINIMUM_LIQUIDITY`
  ///      shares to the caller and `MINIMUM_LIQUIDITY` to the dead
  ///      address. On subsequent adds, mints shares proportionally
  ///      to the anchor reserve. Pulls the three token amounts via
  ///      `safeTransferFrom` after the mint.
  ///
  ///      F4 — `nonReentrant`. What was possible before: the shares are
  ///      minted and the three reserves are written BEFORE the loop of
  ///      three `safeTransferFrom`. A basket token with a payer-side
  ///      hook could re-enter `removeLiquidity` (which carries neither
  ///      `nonReentrant` nor `whenNotPaused`) from inside the first
  ///      transfer, at a moment where the pool has credited three
  ///      reserves but collected exactly one token, and walk out with a
  ///      pro-rata slice of reserves it never funded. Not reachable with
  ///      WBTC / cbBTC / LBTC / MockWrappedBTC, which have no such hook,
  ///      but that is a property of today's basket, not an invariant of
  ///      the pool: the guard makes it one. The operation ORDER is left
  ///      exactly as it was, deliberately — it is covered by existing
  ///      tests, and the guard alone closes the hole.
  /// @param _anchorIndex The reserve to anchor the deposit against.
  /// @param _amount The amount of the anchor token to deposit.
  /// @param _minShares Minimum LP shares the caller accepts.
  /// @return mintedShares The LP shares minted to the caller.
  function addLiquidity(uint256 _anchorIndex, uint256 _amount, uint256 _minShares) external whenNotPaused nonReentrant returns (uint256 mintedShares) {
    uint256[3] memory amounts;
    uint256 supply = totalSupply();

    if (supply == 0) {
      // F8: garde d'overflow uint72, par symetrie avec la branche
      // normale ci-dessous. Avant, le `uint72(...)` plus bas tronquait
      // en silence tout `_amount` au-dela de 2^72 - 1. Le plafond de 21M
      // des jetons du panier le rendait inatteignable, mais c'etait une
      // dependance implicite au JETON, pas une invariante du POOL : un
      // panier futur au plafond plus haut rouvrirait la troncature. La
      // garde en fait une invariante.
      //
      // Elle est posee EN TETE de branche, avant le `3 * _amount` :
      // place apres, un `_amount` au-dela de 2^254 declencherait le
      // panic 0x11 de la multiplication avant d'atteindre la garde, et
      // l'appelant lirait un panic arithmetique la ou la branche normale
      // lui rend `ReserveOverflow`.
      require(_amount <= type(uint72).max, ReserveOverflow());

      mintedShares = 3 * _amount - MINIMUM_LIQUIDITY;
      require(mintedShares >= _minShares, BadSlippage());
      amounts[0] = amounts[1] = amounts[2] = _amount;

      _setReserves(uint72(amounts[0]), uint72(amounts[1]), uint72(amounts[2]));
      _mint(0x000000000000000000000000000000000000dEaD, MINIMUM_LIQUIDITY);

    } else {
      uint72[3] memory cachedReserves = _loadReserves();

      mintedShares = supply * _amount / cachedReserves[_anchorIndex];
      require(mintedShares > 0, ZeroOutput());
      require(mintedShares >= _minShares, BadSlippage());

      amounts[0] = Math.ceilDiv(_amount * cachedReserves[0], cachedReserves[_anchorIndex]);
      amounts[1] = Math.ceilDiv(_amount * cachedReserves[1], cachedReserves[_anchorIndex]);
      amounts[2] = Math.ceilDiv(_amount * cachedReserves[2], cachedReserves[_anchorIndex]);
      require(cachedReserves[0] + amounts[0] <= type(uint72).max, ReserveOverflow());
      require(cachedReserves[1] + amounts[1] <= type(uint72).max, ReserveOverflow());
      require(cachedReserves[2] + amounts[2] <= type(uint72).max, ReserveOverflow());
      unchecked {
        cachedReserves[0] = uint72(cachedReserves[0] + amounts[0]);
        cachedReserves[1] = uint72(cachedReserves[1] + amounts[1]);
        cachedReserves[2] = uint72(cachedReserves[2] + amounts[2]);
      }
      _storeReserves(cachedReserves);
    }
    _mint(msg.sender, mintedShares);
    for (uint256 i; i < 3; i++) {
      IERC20(indexToAddress(i)).safeTransferFrom(msg.sender, address(this), amounts[i]);
    }
    emit AddedLiquidity(msg.sender, amounts, mintedShares);
  }

  /// @notice Burns `_burnedShares` LP shares and returns the caller a
  ///         pro-rata slice of all three basket reserves.
  /// @dev Not gated by `whenNotPaused` on purpose: a paused pool must
  ///      still let LPs exit. Reverts with `NotBootstrapped` when the
  ///      pool has no supply, and with `BadSlippage` if any leg falls
  ///      below its `_minOut`. Burns before transferring (CEI).
  /// @param _burnedShares The amount of LP shares to burn.
  /// @param _minOut Per-token minimum the caller accepts, index-aligned
  ///        with `token0`/`token1`/`token2`.
  ///
  ///      F4 — `nonReentrant`. This is the function the add-liquidity
  ///      re-entrancy landed on: it stays open while paused (an exit
  ///      must always be possible), so the pause was not a guard here.
  ///      The shared re-entrancy lock is: it closes the exit only for
  ///      the duration of another entry point's own call, never for a
  ///      standalone exit.
  /// @return amountsOut The three token amounts sent to the caller.
  function removeLiquidity(uint256 _burnedShares, uint256[3] calldata _minOut) external nonReentrant returns (uint256[3] memory amountsOut) {
    uint256 supply = totalSupply();
    require(supply != 0, NotBootstrapped());
    uint72[3] memory cachedReserves = _loadReserves();

    for (uint256 i; i < 3; i++) {
      amountsOut[i] = cachedReserves[i] * _burnedShares / supply;
      require(amountsOut[i] >= _minOut[i], BadSlippage());
      cachedReserves[i] -= uint72(amountsOut[i]);
    }
    _storeReserves(cachedReserves);
    _burn(msg.sender, _burnedShares);
    for (uint256 i; i < 3; i++) {
      IERC20(indexToAddress(i)).safeTransfer(msg.sender, amountsOut[i]);
    }
    emit RemovedLiquidity(msg.sender, amountsOut, _burnedShares);
  }

  /// @notice Swaps `_amount` of the token at `_indexIn` for the token
  ///         at `_indexOut`, at the fee in force for the current epoch
  ///         plus any directional surcharge.
  /// @dev The base fee is split 10 % to the protocol and 90 % to the
  ///      current manager; with no manager elected, only the protocol
  ///      cut is taken and the remainder falls into the reserves. The
  ///      surcharge always stays in the reserves, never reaching the
  ///      manager. Both cuts are credited to pull-only registries, not
  ///      transferred. Reverts with `ZeroOutput`, `InsufficientReserve`,
  ///      `ReserveOverflow`, `FloorTouched` or `CeilingTouched` when a
  ///      post-swap reserve leaves the band, and `BadSlippage`.
  /// @param _indexIn The token index of the input side.
  /// @param _amount The input amount, in token units.
  /// @param _indexOut The token index of the output side.
  /// @param _minOut Minimum output the caller accepts.
  ///
  ///      F4 — `nonReentrant`. Same lock as `addLiquidity` and
  ///      `removeLiquidity`: `swap` writes the reserves and the fee
  ///      registries before its two transfers, so a hooked basket token
  ///      could re-enter on a state that is written but not funded.
  /// @return amountOut The output amount transferred to the caller.
  function swap(uint256 _indexIn, uint256 _amount, uint256 _indexOut, uint256 _minOut) external whenNotPaused nonReentrant returns (uint256 amountOut) {
    uint72[3] memory cachedReserves = _loadReserves();

    uint256 epoch = currentEpoch();
    uint256 baseFee = lastSetFeeEpoch == epoch ? feeNum : NOMINAL_FEE_NUM;
    uint256 effective = _computeEffective(baseFee, _indexIn, _indexOut, cachedReserves);
    uint256 feeAmount = Math.ceilDiv(_amount * effective, FEE_DEN);
    amountOut = _getAmountOut(cachedReserves, _indexIn, _indexOut, _amount - feeAmount);

    require(amountOut > 0, ZeroOutput());
    require(cachedReserves[_indexOut] > amountOut, InsufficientReserve());
    require(_amount + cachedReserves[_indexIn] <= type(uint72).max, ReserveOverflow());

    uint256 baseAmount = _amount * baseFee / FEE_DEN;
    uint256 protocolCut = baseAmount * PROTOCOL_FEE_BPS / SPLIT_DEN;
    address currentManager = managerOf[epoch];
    uint256 managerCut = currentManager == address(0) ? 0 : baseAmount - protocolCut;
    uint256 amountInToReserves = _amount - protocolCut - managerCut;

    unchecked {
      cachedReserves[_indexIn] = uint72(cachedReserves[_indexIn] + amountInToReserves);
      cachedReserves[_indexOut] -= uint72(amountOut);
    }
    uint256 sum = uint256(cachedReserves[0]) + cachedReserves[1] + cachedReserves[2];
    uint256 ceilingTimesSum = uint256(ceiling) * sum;
    uint256 floorTimesSum = uint256(floor) * sum;

    require(uint256(cachedReserves[0]) * 100 < ceilingTimesSum, CeilingTouched(0));
    require(uint256(cachedReserves[0]) * 100 > floorTimesSum, FloorTouched(0));
    require(uint256(cachedReserves[1]) * 100 < ceilingTimesSum, CeilingTouched(1));
    require(uint256(cachedReserves[1]) * 100 > floorTimesSum, FloorTouched(1));
    require(uint256(cachedReserves[2]) * 100 < ceilingTimesSum, CeilingTouched(2));
    require(uint256(cachedReserves[2]) * 100 > floorTimesSum, FloorTouched(2));

    require(amountOut >= _minOut, BadSlippage());

    _storeReserves(cachedReserves);
    if (managerCut > 0) {
      feesOwed[currentManager][_indexIn] += managerCut;
    }
    if (protocolCut > 0) {
      protocolFeesOwed[_indexIn] += protocolCut;
    }

    IERC20(indexToAddress(_indexIn)).safeTransferFrom(msg.sender, address(this), _amount);
    IERC20(indexToAddress(_indexOut)).safeTransfer(msg.sender, amountOut);

    emit Swapped(msg.sender, _indexIn, _amount, _indexOut, amountOut);
  }

  /// @notice Withdraws the caller's accrued base-fee credit for one
  ///         basket token.
  /// @dev Pull-only, CEI strict: the registry is zeroed before the
  ///      transfer. Reverts with `ZeroFeesOwed` when nothing is owed.
  /// @param _tokenIndex The token index (0, 1 or 2) to claim.
  function claimManagerFees(uint256 _tokenIndex) external {
    uint256 owed = feesOwed[msg.sender][_tokenIndex];
    require(owed > 0, ZeroFeesOwed());
    feesOwed[msg.sender][_tokenIndex] = 0;
    IERC20(indexToAddress(_tokenIndex)).safeTransfer(msg.sender, owed);
  }

  /// @notice Sends the protocol's accrued base-fee credit for one
  ///         basket token to the immutable `treasury`.
  /// @dev Permissionless: anyone may trigger the payout, and it always
  ///      lands on `treasury`, never on `owner()`, so the cash flow
  ///      does not follow ownership. Reverts with `ZeroFeesOwed`.
  /// @param _tokenIndex The token index (0, 1 or 2) to claim.
  function claimProtocolFees(uint256 _tokenIndex) external {
    uint256 owed = protocolFeesOwed[_tokenIndex];
    require(owed > 0, ZeroFeesOwed());
    protocolFeesOwed[_tokenIndex] = 0;
    IERC20(indexToAddress(_tokenIndex)).safeTransfer(treasury, owed);
  }

  /// @dev Projection en lecture seule de `accPerShare` a l'instant
  ///      courant. Partagee avec `claimable()`, donc STRICTEMENT
  ///      alignee sur `_updateRent` : les deux appliquent la meme
  ///      condition F5 (`totalSupply() <= MINIMUM_LIQUIDITY`), sinon la
  ///      vue promettrait une rente que le chemin ecrivain ne credite
  ///      pas.
  function _accProjected() internal view returns (uint256) {
    if (rentLastUpdate >= rentEnd) return accPerShare;
    uint256 end = block.timestamp < rentEnd ? block.timestamp : rentEnd;
    uint256 dt = end - rentLastUpdate;
    uint256 supply = totalSupply();
    if (dt == 0 || rentRate == 0 || supply == 0) return accPerShare;
    // F5 : pas de LP vivant, l'accumulateur ne bouge pas. Voir
    // `_updateRent`, qui reporte la tranche dans `rentLeftOver`.
    if (supply <= MINIMUM_LIQUIDITY) return accPerShare;
    return accPerShare + dt * rentRate / supply;
  }

  /// @dev Avance l'accumulateur jusqu'a `min(block.timestamp, rentEnd)`.
  ///
  ///      F5 — quand `totalSupply() <= MINIMUM_LIQUIDITY`, l'unique
  ///      porteur restant est l'adresse morte (les 1000 parts du
  ///      bootstrap), qui ne reclamera jamais. Avant, `accPerShare`
  ///      avancait quand meme de `dt * rentRate / totalSupply` : toute
  ///      la queue d'un flux traverse par une sortie totale des LP etait
  ///      attribuee a l'adresse morte, donc brulee. Le garde-fou
  ///      `rentLeftOver` ne couvrait que le cas ou `notifyRent` arrive
  ///      sur un pool deja vide, pas celui ou le pool se vide PENDANT le
  ///      flux. On reporte desormais la tranche dans `rentLeftOver`, ou
  ///      le prochain `notifyRent` la fondra dans le flux suivant, et on
  ///      recale `rentLastUpdate` pour ne jamais la compter deux fois.
  ///      L'echelle est celle de `notifyRent` (`rentRate` est en 1e18
  ///      par seconde, `rentLeftOver` en MRN), d'ou le `/ 1e18`.
  function _updateRent() internal {
    if (rentLastUpdate >= rentEnd) return;
    uint256 end = block.timestamp < rentEnd ? block.timestamp : rentEnd;

    if (totalSupply() <= MINIMUM_LIQUIDITY) {
      uint256 dt = end - rentLastUpdate;
      if (dt != 0 && rentRate != 0) {
        rentLeftOver += dt * rentRate / 1e18;
      }
      rentLastUpdate = end;
      return;
    }

    accPerShare = _accProjected();
    rentLastUpdate = end;
  }

  /// @notice Returns the MRN rent `_who` could claim right now.
  /// @dev Pure projection: shares `_accProjected` with the writing
  ///      path, so this view returns exactly what `claimRent` would
  ///      transfer. Never reverts.
  /// @param _who The address to quote.
  /// @return The claimable MRN amount, in 18 decimals.
  function claimable(address _who) external view returns (uint256) {
    uint256 acc = _accProjected();
    uint256 accrued = balanceOf(_who) * acc / 1e18;
    uint256 owed = rentPending[_who];
    if (accrued > rentDebt[_who]) owed += accrued - rentDebt[_who];
    return owed;
  }

  function _update(address from, address to, uint256 value) internal virtual override {
    _updateRent();
    uint256 acc = accPerShare;

    if (from != address(0)) {
      uint256 fromBalance = balanceOf(from);
      uint256 pending = fromBalance * acc / 1e18;
      if (pending > rentDebt[from]) {
        rentPending[from] += pending - rentDebt[from];
      }
    }

    super._update(from, to, value);

    uint256 toBalance;
    if (to != address(0) && to != from) {
      toBalance = balanceOf(to);
      uint256 pending = (toBalance - value) * acc / 1e18;
      if (pending > rentDebt[to]) {
        rentPending[to] += pending - rentDebt[to];
      }
    }

    if (from != address(0)) {
      rentDebt[from] = balanceOf(from) * acc / 1e18;
    }
    if (to != address(0) && to != from) {
      rentDebt[to] = toBalance * acc / 1e18;
    }
  }

  /// @notice Opens a new MRN rent stream of `amount` over one epoch
  ///         and pulls the MRN from the auction.
  /// @dev Auction-only (`NotAuction`). While supply is at or below
  ///      `MINIMUM_LIQUIDITY` the rent is parked in `rentLeftOver` and
  ///      no stream starts; otherwise the untailed remainder of the
  ///      running stream is rolled back in before the rate is
  ///      rewritten. CEI strict: state first, then `safeTransferFrom`
  ///      on the allowance the auction sets in its constructor, so a
  ///      missing allowance reverts the whole settlement.
  ///
  ///      F5 coherence: the leading `_updateRent()` has already parked
  ///      into `rentLeftOver` every second the pool spent without a live
  ///      LP, and moved `rentLastUpdate` past them. The `rentEnd >
  ///      block.timestamp` roll-in below therefore covers only the
  ///      untravelled tail `[block.timestamp, rentEnd]`: the two sources
  ///      are disjoint and nothing is counted twice. The
  ///      `rentLeftOver = 0` that follows is still correct, since the
  ///      whole balance is folded into the new `rentRate` on the line
  ///      above it.
  /// @param amount The MRN amount of the new stream, in 18 decimals.
  function notifyRent(uint256 amount) external {
    require(msg.sender == auction, NotAuction());
    _updateRent();
    uint256 supply = totalSupply();
    if (supply <= MINIMUM_LIQUIDITY) {
      rentLeftOver += amount;
    } else {
      if (rentEnd > block.timestamp) {
        rentLeftOver += rentRate * (rentEnd - block.timestamp) / 1e18;
      }
      rentRate = (amount + rentLeftOver) * 1e18 / EPOCH_DURATION;
      rentLeftOver = 0;
      rentEnd = block.timestamp + EPOCH_DURATION;
      rentLastUpdate = block.timestamp;
      emit RentNotified(amount, rentRate, rentEnd);
    }
    IERC20(mrn).safeTransferFrom(msg.sender, address(this), amount);
  }

  /// @notice Transfers the caller's accrued MRN rent.
  /// @dev Flushes the accumulator, then pays `rentPending` plus the
  ///      live accrual on the current balance. `rentDebt` is
  ///      re-checkpointed unconditionally, so integer truncation
  ///      cannot freeze it. CEI strict. Reverts with `ZeroRentOwed`.
  function claimRent() external {
    _updateRent();
    uint256 bal = balanceOf(msg.sender);
    uint256 accrued = bal * accPerShare / 1e18;
    uint256 owed = rentPending[msg.sender];
    if (accrued > rentDebt[msg.sender]) {
      owed += accrued - rentDebt[msg.sender];
    }
    rentDebt[msg.sender] = accrued;
    rentPending[msg.sender] = 0;
    require(owed > 0, ZeroRentOwed());
    IERC20(mrn).safeTransfer(msg.sender, owed);
    emit RentClaimed(msg.sender, owed);
  }

}
