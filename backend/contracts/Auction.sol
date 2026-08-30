// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "./Pool.sol";

using SafeERC20 for IERC20;

/// @title Auction
/// @notice Ascending-price MRN auction that elects the manager of the
///         next epoch. Bidders outbid each other during a fixed window
///         in MRN; the highest bid at settle-time designates the
///         manager, pays the LP rent, and burns the protocol share.
/// @dev The pool's clock is snapshotted at construction so the two
///      contracts cannot drift. Manager nomination happens once per
///      auction, inside `settle`, which is only accepted once the
///      bidding window of the epoch being sold has closed (F3 guard,
///      see `settle`). A settlement that misses the epoch rollover is
///      no longer a permanent brick: `_settle` detects the expired
///      mandate and refunds the captured bidder (F1).
///
/// AUDIT F1/F2/F3 — trois failles corrigees dans ce fichier :
///   F1 : un `pendingEpoch` perime faisait reverter `_settle` pour
///        toujours (`Pool.EpochAlreadyStarted`), l'enchere etait morte
///        et le MRN du gagnant capture etait piege sans aucun chemin de
///        sortie. `_settle` rembourse desormais et purge le slot.
///   F2 : `settle()` passait `highBidder` (le meneur de l'enchere
///        COURANTE) a `_settle`, qui nommait donc le mauvais gagnant
///        pour `pendingEpoch`. Le gagnant capture est maintenant
///        memorise dans `pendingBidder`.
///   F3 : `settle()` n'avait aucune garde temporelle : n'importe qui
///        pouvait, dans une seule transaction, poser `minOpeningBid`
///        puis regler, et rafler le mandat au prix plancher. La
///        fermeture de la fenetre est desormais exigee.
contract Auction {

  uint256 internal immutable genesis;
  uint256 internal immutable epochDuration;

  /// @notice Duration of the bidding window, in seconds, measured from
  ///         the start of the epoch preceding the one being auctioned,
  ///         i.e. the current epoch.
  uint256 public immutable auctionWindow;
  /// @notice Maximum soft-close extension in seconds, reserved for the
  ///         A1 soft-close gate. Set to 0 at I.3; the gate is not
  ///         active yet.
  uint256 public immutable maxExtension;
  /// @notice Length of the settle window at the end of the epoch, in
  ///         seconds, during which the bot is expected to call
  ///         `settle` and nominate the manager.
  /// @dev F3: bidding is now effectively closed for the whole stretch
  ///      between `startOfEpoch(sellingEpoch - 1) + auctionWindow` and
  ///      the epoch rollover, because `placeBid` already refuses bids
  ///      past `auctionWindow` (`WindowClosed`) and `settle` now
  ///      refuses to run before it (`WindowStillOpen`). `bidSilence`
  ///      remains a scheduling hint for the off-chain bot: it says how
  ///      late in the epoch the bot should aim, not when the contract
  ///      opens or closes. It is deliberately NOT the gate itself, so
  ///      that a bot outage cannot shrink the settle window.
  uint256 public immutable bidSilence;
  /// @notice Minimum first bid of any new auction, in MRN (18 decimals).
  uint256 public immutable minOpeningBid;

  /// @notice The MRN token used for bidding, refunds, and the rent
  ///         payout to the pool.
  IERC20 public immutable mrn;
  /// @notice The Merion pool whose next-epoch manager this auction
  ///         elects. Read at construction and held immutable.
  Pool public immutable pool;

  /// @notice The Pool's protocol treasury, mirrored here at
  ///         construction. Not used by `settle` (R6: no treasury share
  ///         on the auction revenue), but stored for completeness.
  address public immutable treasury;

  /// @notice Minimum outbid ratio in basis points. A new bid must
  ///         reach at least `highBid * HIGH_BID_BPS / BPS_DEN` to be
  ///         accepted (effectively +10 %).
  uint256 constant public HIGH_BID_BPS = 11000;
  /// @notice Basis-point denominator, shared by `HIGH_BID_BPS` and
  ///         `SETTLE_REWARD_BPS`.
  uint256 constant public BPS_DEN = 10000;

  /// @notice Denominator of the auction-revenue split between LP
  ///         share and burn share. Distinct from `BPS_DEN` to keep
  ///         each calculation bounded by a single denominator.
  uint256 constant public SPLIT_DEN = 10000;
  /// @notice Share of the settled amount routed to the pool as LP
  ///         rent, in basis points over `SPLIT_DEN` (70 %).
  uint256 constant public LP_BPS = 7000;
  /// @notice Share of the settled amount burned by the auction, in
  ///         basis points over `SPLIT_DEN` (30 %).
  uint256 constant public BURN_BPS = 3000;

  /// @notice Caller reward on `settle`, in basis points of `lpAmount`,
  ///         paid in MRN to the bot that nominates the manager
  ///         (0.1 %).
  uint256 constant public SETTLE_REWARD_BPS = 10;

  /// @notice The epoch whose manager is currently being auctioned.
  ///         Equal to `currentEpoch() + 1` while the auction is live;
  ///         stale value reset by the next `placeBid` or `settle`.
  uint256 public sellingEpoch;
  /// @notice The current highest bid of the live auction, in MRN
  ///         (18 decimals). Zero when no bid is in flight.
  uint256 public highBid;
  /// @notice Address of the current highest bidder, or the zero
  ///         address when no bid is in flight.
  address public highBidder;

  /// @notice The epoch waiting to be settled. Zero means no pending
  ///         settlement.
  uint256 public pendingEpoch;
  /// @notice The winning bid amount waiting to be settled, in MRN
  ///         (18 decimals). Zero means no pending settlement.
  uint256 public pendingAmount;
  /// @notice The winner of `pendingEpoch`, captured at the same instant
  ///         as `pendingEpoch` and `pendingAmount`.
  /// @dev F2: before this field existed, `settle()` handed `_settle` the
  ///      CURRENT auction's `highBidder`. When the pending slot had been
  ///      filled by a `placeBid` reset, that address had nothing to do
  ///      with the mandate being settled: the last bidder of the live
  ///      auction was nominated for someone else's epoch, and the real
  ///      winner never appeared anywhere. The three pending fields are
  ///      now written and purged as one unit, always together.
  address public pendingBidder;

  /// @notice Outstanding refund credits, per address, in MRN
  ///         (18 decimals). Pulled by `withdrawRefund`.
  mapping(address => uint256) public refunds;

  /// @notice The provided bid is below the minimum required for the
  ///         current auction (either `minOpeningBid` or a +10 % outbid
  ///         over the current high).
  /// @param min The minimum amount the caller had to bid.
  /// @param provided The amount the caller actually bid.
  error BidTooLow(uint256 min, uint256 provided);
  /// @notice The auction window is closed: the caller's bid arrived
  ///         after the bidding deadline.
  error WindowClosed();
  /// @notice The caller has no refund credit to withdraw.
  error NoBidToRefund();
  /// @notice There is no winning bid awaiting settlement, and no live
  ///         auction to capture either.
  error NoBidToSettle();
  /// @notice F3: `settle` was called while the bidding window of the
  ///         epoch being sold is still open. Settling early would
  ///         freeze the auction at the current high bid, since a
  ///         second settlement on the same epoch is refused by the
  ///         pool (`ManagerAlreadySet`).
  /// @param closesAt The unix timestamp from which `settle` is allowed.
  error WindowStillOpen(uint256 closesAt);

  /// @notice Emitted when a new highest bid is placed in the auction.
  /// @param epoch The epoch whose manager the bid is for.
  /// @param bidder The address that placed the bid.
  /// @param amount The bid amount in MRN (18 decimals).
  event BidPlaced(uint256 indexed epoch, address indexed bidder, uint256 amount);
  /// @notice Emitted when the previous highest bidder is credited a
  ///         refund (R2: credit, never push).
  /// @param bidder The address whose previous bid is now refundable.
  /// @param amount The refunded amount in MRN (18 decimals).
  event RefundCredited(address indexed bidder, uint256 amount);
  /// @notice Emitted when a bidder successfully withdraws their
  ///         refund credit.
  /// @param bidder The address that withdrew the refund.
  /// @param amount The withdrawn amount in MRN (18 decimals).
  event RefundWithdrawn(address indexed bidder, uint256 amount);
  /// @notice Re-emitted here for per-bidder auditability. The Pool
  ///         already emits its own `ManagerSet`; this duplicate allows
  ///         clients to filter settlement events by bidder without
  ///         scanning Pool logs.
  /// @param epoch The epoch whose manager has been set.
  /// @param manager The manager designated for that epoch.
  event ManagerSet(uint256 indexed epoch, address indexed manager);
  /// @notice Epoch-closing snapshot emitted at settle-time. Captures
  ///         the manager, the clearing price, the fee in force for
  ///         the settled epoch, and the three reserves read at that
  ///         instant.
  /// @param epoch The epoch that has just been settled.
  /// @param manager The manager designated for that epoch.
  /// @param clearingPrice The winning bid, in MRN (18 decimals).
  /// @param fee The fee in force at the start of the epoch (numerator
  ///        over `FEE_DEN`).
  /// @param reservesAtClose The three pool reserves read at settle
  ///        time, in token units.
  event Settled(uint256 indexed epoch, address indexed manager, uint256 clearingPrice, uint256 fee, uint256[3] reservesAtClose);
  /// @notice F1: emitted when a pending settlement is abandoned because
  ///         its epoch has already started. No manager is nominated, no
  ///         MRN is burned, no rent is paid: the whole amount is
  ///         credited back to the captured bidder's refund balance.
  /// @param epoch The expired epoch that will run unmanaged.
  /// @param bidder The captured winner, refunded in full.
  /// @param amount The refunded amount in MRN (18 decimals).
  event SettlementExpired(uint256 indexed epoch, address indexed bidder, uint256 amount);

  /// @notice Deploys the auction, snapshots the pool's `GENESIS` and
  ///         `EPOCH_DURATION` to keep the two clocks aligned, records
  ///         the bidding-window parameters, and pre-approves the pool
  ///         to pull MRN for rent payouts.
  /// @dev The pool's clock fields are copied rather than re-read on
  ///      every call: this is the only way to guarantee the two
  ///      contracts never drift. The pre-approval uses `approve`
  ///      (not `forceApprove`) because the Auction is freshly
  ///      deployed and its previous MRN allowance is zero.
  /// @param _pool Address of the Merion pool whose manager this
  ///        auction elects.
  /// @param _mrn Address of the MRN token used for bidding and rent.
  /// @param _auctionWindow Length of the bidding window, in seconds.
  /// @param _maxExtension Reserved for the A1 soft-close gate; set
  ///        to 0 at I.3.
  /// @param _bidSilence Length of the settle window, in seconds.
  /// @param _minOpeningBid Minimum first bid of any new auction, in
  ///        MRN (18 decimals).
  constructor(
    address _pool,
    address _mrn,
    uint256 _auctionWindow,
    uint256 _maxExtension,
    uint256 _bidSilence,
    uint256 _minOpeningBid
  ) {
    Pool p = Pool(_pool);
    genesis = p.GENESIS();
    epochDuration = p.EPOCH_DURATION();

    pool = p;
    mrn = IERC20(_mrn);
    auctionWindow = _auctionWindow;
    maxExtension = _maxExtension;
    bidSilence = _bidSilence;
    minOpeningBid = _minOpeningBid;

    treasury = p.treasury();

    IERC20(_mrn).approve(address(p), type(uint256).max);
  }

  /// @notice Returns the current epoch derived from the pool's
  ///         `GENESIS` and `EPOCH_DURATION` snapshot at deployment.
  /// @return The current epoch number, zero-based.
  function currentEpoch() public view returns (uint256) {
    return (block.timestamp - genesis) / epochDuration;
  }

  /// @notice Returns the current highest bid of the live auction.
  /// @return The current high bid, in MRN (18 decimals), or zero if
  ///         no bid is in flight.
  function currentBid() external view returns (uint256) {
    return highBid;
  }

  /// @notice Returns whether the bidding window is currently open.
  /// @return True iff the auction is for the next epoch and
  ///         `block.timestamp` is before the window deadline.
  function windowOpen() public view returns (bool) {
    if (sellingEpoch != currentEpoch() + 1) return false;
    return block.timestamp < startOfEpoch(sellingEpoch - 1) + auctionWindow;
  }

  /// @notice Returns the closing timestamp of the bidding window for
  ///         the epoch currently being sold.
  /// @dev Reverts by underflow while `sellingEpoch` is zero, i.e.
  ///      before the first bid ever placed. Returns a stale value once
  ///      the auction it describes has closed; pair it with
  ///      `windowOpen()`.
  /// @return The unix timestamp at which the bidding window closes.
  function closesAt() public view returns (uint256) {
    return startOfEpoch(sellingEpoch - 1) + auctionWindow;
  }

  /// @dev Start timestamp of `epoch`, from the clock snapshotted at
  ///      construction.
  /// @param epoch The epoch number.
  /// @return The unix timestamp at which `epoch` begins.
  function startOfEpoch(uint256 epoch) internal view returns (uint256) {
    return genesis + epoch * epochDuration;
  }

  /// @notice Places a bid on the auction for the next epoch.
  /// @dev When `sellingEpoch` is stale, the slot is reopened at zero
  ///      and the previous winner is first captured into
  ///      `pendingEpoch` and `pendingAmount` for `settle` to process;
  ///      `refunds` are never cleared. The outbid bidder is credited,
  ///      never paid (pull-only), then the MRN is pulled from the
  ///      caller, who must have approved the auction first. Manager
  ///      nomination is deferred to `settle`. Reverts with
  ///      `WindowClosed` past the deadline and `BidTooLow` below
  ///      `max(minOpeningBid, highBid * HIGH_BID_BPS / BPS_DEN)`.
  /// @param amount The bid amount, in MRN (18 decimals).
  function placeBid(uint256 amount) external {
    uint256 nextEpoch = currentEpoch() + 1;
    if (sellingEpoch != nextEpoch) {
      if (highBidder != address(0)) {
        // F2: the three pending fields are written together. Capturing
        // the epoch and the amount without the winner is what let
        // `settle()` nominate the wrong address.
        pendingEpoch = sellingEpoch;
        pendingAmount = highBid;
        pendingBidder = highBidder;
      }
      sellingEpoch = nextEpoch;
      highBid = 0;
      highBidder = address(0);
    }

    uint256 closesAt_ = startOfEpoch(sellingEpoch - 1) + auctionWindow;
    require(
      block.timestamp < closesAt_,
      WindowClosed()
    );

    uint256 min = highBid * HIGH_BID_BPS / BPS_DEN;
    if (min < minOpeningBid) min = minOpeningBid;
    require(amount >= min, BidTooLow(min, amount));

    if (highBidder != address(0)) {
      refunds[highBidder] += highBid;
      emit RefundCredited(highBidder, highBid);
    }

    mrn.safeTransferFrom(msg.sender, address(this), amount);

    highBid = amount;
    highBidder = msg.sender;

    emit BidPlaced(sellingEpoch, msg.sender, amount);
  }

  /// @notice Withdraws the caller's outstanding refund credit, if any.
  /// @dev Pull-only, CEI strict: the registry is reset to zero before
  ///      the transfer. Reverts with `NoBidToRefund` if the caller
  ///      has nothing to withdraw.
  function withdrawRefund() external {
    uint256 owed = refunds[msg.sender];
    require(owed > 0, NoBidToRefund());
    refunds[msg.sender] = 0;
    mrn.safeTransfer(msg.sender, owed);
    emit RefundWithdrawn(msg.sender, owed);
  }

  /// @notice Settles the pending winning bid: burns 30 % of
  ///         `pendingAmount`, pays the caller a `SETTLE_REWARD_BPS`
  ///         reward on the LP share, hands the rest to the pool as rent
  ///         via `Pool.notifyRent`, and nominates `pendingBidder` as
  ///         the manager of `pendingEpoch`. When no settlement is
  ///         queued, first captures the live auction into the pending
  ///         slot, which is only allowed once its bidding window has
  ///         closed (`WindowStillOpen`). If `pendingEpoch` can no
  ///         longer be nominated, nothing is burned or paid and the
  ///         captured bidder is refunded in full (`SettlementExpired`).
  /// @dev Permissionless. Captures a live auction into the pending
  ///      slot if no previous settlement is queued. Not idempotent:
  ///      reverts with `NoBidToSettle` when there is nothing to
  ///      settle and no live auction either, which is what a second
  ///      consecutive call hits.
  ///
  ///      F3 — the capture branch now requires the bidding window of
  ///      `sellingEpoch` to be closed. What was possible before: bid
  ///      `minOpeningBid` and call `settle()` in the SAME transaction,
  ///      at the first second of the window. The caller became manager
  ///      of the next epoch at the floor price, and no one could outbid
  ///      him any more, because a second `settle` on that epoch hits the
  ///      pool's `ManagerAlreadySet`. The guard holds because
  ///      `placeBid` refuses any bid at or after the very same instant
  ///      (`WindowClosed`, strict `<` on the identical expression): the
  ///      bidding phase and the settlement phase are now disjoint, so a
  ///      settlement can never freeze a price that is still contestable.
  ///
  ///      The pending-settlement branch is deliberately NOT gated: a
  ///      slot captured by a `placeBid` reset must stay drainable at any
  ///      time, otherwise F1 would come back through the front door.
  ///
  ///      The capture MOVES the live auction into the pending slot: it
  ///      writes the three pending fields AND zeroes `highBid` /
  ///      `highBidder`. Zeroing here is not cosmetic, it is what makes
  ///      the capture idempotent. Leaving the live auction in place
  ///      would let a stale `sellingEpoch` (the bot never settled, the
  ///      epoch rolled over) be captured, refunded by the expired
  ///      branch of `_settle`, and then captured AGAIN by the next
  ///      `settle()` call, crediting `refunds[highBidder] += highBid`
  ///      once per call and draining the contract's MRN to anyone
  ///      willing to spend the gas. The move also keeps the solvency
  ///      invariant `balanceOf(this) == sum(refunds) + pendingAmount +
  ///      highBid` true across the capture, exactly as the `placeBid`
  ///      reset already does.
  function settle() external {
    if (pendingEpoch == 0 && pendingAmount == 0) {
      if (highBidder == address(0)) {
        revert NoBidToSettle();
      }
      uint256 closes = startOfEpoch(sellingEpoch - 1) + auctionWindow;
      require(block.timestamp >= closes, WindowStillOpen(closes));
      pendingEpoch = sellingEpoch;
      pendingAmount = highBid;
      pendingBidder = highBidder;
      highBid = 0;
      highBidder = address(0);
    }
    _settle();
  }

  /// @dev Splits `pendingAmount` 30 % burn / 70 % LP, pays the caller
  ///      the settle reward, pulls the remainder to the pool as rent,
  ///      nominates the manager, emits `Settled`, then clears both the
  ///      pending slot and the live auction state.
  ///
  ///      F1 — expired-mandate branch. `pendingEpoch` is written from
  ///      `sellingEpoch`, and `sellingEpoch` is only ever assigned
  ///      `currentEpoch() + 1`. So a `pendingEpoch` that differs from
  ///      `currentEpoch() + 1` is necessarily STRICTLY BELOW it, i.e.
  ///      `pendingEpoch <= currentEpoch()`. What was possible before:
  ///      `pool.setManager(pendingEpoch, ...)` reverted
  ///      `EpochAlreadyStarted`, the revert happened BEFORE the zeroing
  ///      at the end of this function, so the slot was never purged and
  ///      every later `settle()` replayed the same revert. The auction
  ///      was dead for good, the rent stream stopped, and the captured
  ///      winner's MRN sat in this contract with no exit at all
  ///      (`refunds` was never credited for him).
  ///
  ///      The decision taken here: the mandate is simply LOST, the money
  ///      goes back to its owner. Nothing is burned, no rent is paid,
  ///      the epoch runs unmanaged at the nominal fee, and the live
  ///      auction (`highBid` / `highBidder` / `sellingEpoch`) is left
  ///      untouched so the next mandate keeps being contested. Refunding
  ///      rather than re-auctioning is the conservative choice: the
  ///      bidder paid for a mandate that no longer exists, and charging
  ///      him for the bot's outage would be theft.
  ///      The same branch also swallows a `pendingEpoch` that ALREADY
  ///      has a manager. That state is reachable even after F6: the
  ///      owner's bootstrap path may legitimately nominate
  ///      `currentEpoch() + 1` before `setAuction` is wired, and the
  ///      auction may then sell that very epoch. Without this arm,
  ///      `pool.setManager` would revert `ManagerAlreadySet` before the
  ///      zeroing at the end of this function — the F1 brick again,
  ///      with a different trigger, holding the bidder's MRN hostage
  ///      until the epoch rolls over. Folding it into the expired
  ///      branch is what makes `Pool.ManagerAlreadySet` genuinely
  ///      unreachable from the auction path, which is the claim
  ///      `test/Auction.invariant.t.sol` rests on.
  function _settle() internal {
    uint256 epoch_ = pendingEpoch;
    address manager = pendingBidder;

    if (epoch_ <= currentEpoch() || pool.managerOf(epoch_) != address(0)) {
      uint256 stranded = pendingAmount;
      pendingEpoch = 0;
      pendingAmount = 0;
      pendingBidder = address(0);
      refunds[manager] += stranded;
      emit RefundCredited(manager, stranded);
      emit SettlementExpired(epoch_, manager, stranded);
      return;
    }

    uint256 burnAmount = pendingAmount * BURN_BPS / SPLIT_DEN;
    uint256 lpAmount = pendingAmount - burnAmount;
    ERC20Burnable(address(mrn)).burn(burnAmount);
    uint256 settleReward = lpAmount * SETTLE_REWARD_BPS / BPS_DEN;
    mrn.safeTransfer(msg.sender, settleReward);
    pool.notifyRent(lpAmount - settleReward);

    pool.setManager(pendingEpoch, manager);
    emit ManagerSet(pendingEpoch, manager);

    uint256 fee = pool.lastSetFeeEpoch() == pendingEpoch
      ? uint256(pool.feeNum())
      : pool.NOMINAL_FEE_NUM();

    uint256[3] memory reservesAtClose;
    reservesAtClose[0] = uint256(pool.reserves(0));
    reservesAtClose[1] = uint256(pool.reserves(1));
    reservesAtClose[2] = uint256(pool.reserves(2));

    emit Settled(pendingEpoch, manager, pendingAmount, fee, reservesAtClose);

    pendingEpoch = 0;
    pendingAmount = 0;
    pendingBidder = address(0);
    highBid = 0;
    highBidder = address(0);
    sellingEpoch = currentEpoch() + 1;
  }
}
