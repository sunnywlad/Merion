// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
using SafeERC20 for IERC20;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Pool
/// @notice Merion's BTC-denominated tri-token AMM. Holds three
///         8-decimal WBTC-like tokens, mints LP shares, charges a
///         manager-controlled fee, pays MRN rent to LPs, and routes
///         fees to the manager and to the protocol treasury.
contract Pool is ERC20, Ownable, Pausable {

  /// @notice First token of the pool's basket (e.g. WBTC).
  address public immutable token0;
  /// @notice Second token of the pool's basket (e.g. cbBTC).
  address public immutable token1;
  /// @notice Third token of the pool's basket (e.g. LBTC).
  address public immutable token2;

  /// @notice Current reserves of the three basket tokens, in token
  ///         units. Indexed 0/1/2 to match `token0/token1/token2`.
  uint72[3] public reserves;
  /// @notice Lower band coefficient: any reserve must stay above
  ///         `floor * sum / 100` after a swap.
  uint8 public constant floor = 13;
  /// @notice Upper band coefficient: any reserve must stay below
  ///         `ceiling * sum / 100` after a swap.
  uint8 public constant ceiling = 53;

  // Slot packing : uint16 feeNum + uint32 lastSetFeeEpoch partagent UN slot de
  // 32 octets, dont ils n'occupent que 6 ; les 26 restants sont libres.
  // Le compilateur aligne feeNum sur les bits bas (16 bits) puis lastSetFeeEpoch
  // au-dessus (32 bits), soit feeNum | (lastSetFeeEpoch << 16). 2 octets couvrent
  // MAX_FEE_NUM = 50 ; 4 octets couvrent 4,3 milliards d'epochs (~4 970 ans à
  // 4 h/epoch). priorityBlock a quitté ce slot avec l'exclusivité qu'il servait
  // (septième passe, item 3) et ne reviendra pas.
  // Aucune fonction n'écrit ce slot au passage d'epoch : la lecture passe par le
  // reset paresseux, feeInForce() rend NOMINAL_FEE_NUM dès que lastSetFeeEpoch
  // diffère de currentEpoch().
  /// @notice Base fee numerator for the current epoch, in units of
  ///         `FEE_DEN`. Reset lazily to `NOMINAL_FEE_NUM` once the
  ///         epoch advances; see `feeInForce`.
  uint16 public feeNum;
  /// @notice Epoch number at which `feeNum` was last written by the
  ///         manager. Compared against `currentEpoch` to decide
  ///         whether the manager's override still applies.
  uint32 public lastSetFeeEpoch;
  /// @notice Absolute maximum fee numerator (in `FEE_DEN` units)
  ///         that any surcharge may reach: half of it caps the
  ///         manager's per-epoch override.
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
  // I.4 — MRN que le Pool doit connaitre pour transferer le loyer
  // accumule en MRN aux LP via `claimRent`. L'Auction a deja sa
  // propre reference (en argument de constructeur) ; le Pool
  // prend la sienne en immuable de deploiement, ce qui l'expose
  // a un changement de token MRN entre Pool et Auction seulement
  // si le deploiement est incoherent — c'est une garde de plus
  // contre un couplage mal assemble.
  /// @notice Address of the MRN token used to pay LP rent.
  /// @dev Captured at deployment as an additional guard against a
  ///      mismatched Pool/Auction wiring: any inconsistency between
  ///      the two contracts surfaces here.
  address public immutable mrn;

  /// @notice Manager elected for a given future epoch, set by the
  ///         auction via `setManager`. Indexed by epoch number.
  mapping(uint256 epoch => address) public managerOf;
  /// @notice Address of the auction contract allowed to call
  ///         `setManager`, `setFee`, and `notifyRent`. Set once by
  ///         the owner via `setAuction` and never changed.
  address public auction;

  // I.2 — sortie des reserves : deux registres, l'un par gestionnaire
  // (l'adresse du mandat, pas le role) et l'un global pour la part
  // protocole. L'argent reste dans le pool tant que les fonctions de tirage
  // ne l'ont pas pousse vers le manager ou vers la tresorerie, et CEI tient
  // chaque tirage : remise a zero AVANT le transfert.
  /// @notice Outstanding base-fee credits owed to each manager,
  ///         per token index. Pulled by `claimManagerFees`.
  mapping(address manager => uint256[3]) public feesOwed;
  /// @notice Outstanding base-fee credits owed to the protocol
  ///         treasury, per token index. Pulled by
  ///         `claimProtocolFees`.
  uint256[3] public protocolFeesOwed;

  // I.4 — loyer LP : un accumulateur `accPerShare` echelonne par 1e18,
  // une dette par adresse, et un stream lineaire sur `EPOCH_DURATION`
  // a partir de chaque `notifyRent`. La regle Synthetix/MasterChef tient :
  // `pending = balance * accPerShare / 1e18 - rentDebt`. La mise a jour
  // est paresseuse, declenchee par chaque touch (`_update`, `notifyRent`,
  // `claimRent`), jamais par une boucle sur les LP.
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
  /// @notice `swap` asked to remove more of the output token than
  ///         the pool currently holds.
  error InsufficientReserve();
  /// @notice A swap, add-liquidity, or quote produced a zero
  ///         output, which is never acceptable.
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
  // Seule erreur de setFee à porter des arguments : c'est la seule dont
  // l'appelant ne peut pas dériver la cause sans lire deux constantes.
  /// @notice The manager-provided fee numerator is outside the
  ///         allowed `[min, max]` band.
  /// @param min The minimum allowed fee numerator (`MIN_FEE_NUM`).
  /// @param max The maximum allowed fee numerator for this epoch
  ///        (`MAX_FEE_NUM / UNBALANCE_FACTOR`).
  error FeeOutOfBand(uint256 min, uint256 max);
  // I.2 — appel d'un tirage alors que le registre est vide ; distincte de
  // BadSlippage parce que la cause n'est pas un seuil rate mais une
  // quantite nulle.
  /// @notice `claimManagerFees` or `claimProtocolFees` was called
  ///         for a token index with no accrued fees.
  error ZeroFeesOwed();
  // I.4 — notifyRent par un non-auction, claimRent sur un registre vide.
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
  // I.4 — loyer LP : notification d'un nouveau stream de rent, avec
  // montant, taux par seconde (echelle 1e18) et timestamp de fin.
  /// @notice Emitted when the auction notifies a new rent stream.
  /// @param amount The MRN amount of the new stream (excluding any
  ///        rolled-in `rentLeftOver`).
  /// @param rate The new emission rate, scaled by 1e18.
  /// @param end The unix timestamp at which the stream ends.
  event RentNotified(uint256 amount, uint256 rate, uint256 end);
  // I.4 — tirage du loyer LP : quand un LP reclame sa part.
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

    token0 = _tokens[0];
    token1 = _tokens[1];
    token2 = _tokens[2];
    // I.7 #3 : garde d'erreur de deploiement sur l'adresse nulle des
    // trois jetons du panier, avant la garde de doublons et celle des
    // decimales. Sans elle, `decimals()` reverterait en panic 0x21 (appel
    // sur adresse nulle ERC-20) au lieu d'une erreur nommee : le
    // deployer verrait un revert sans cause lisible. Meme classe que la
    // garde decimales acceptee le 24-08 : le deployer doit pouvoir
    // nommer la faute.
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
  /// @dev Reverts with `EpochAlreadyStarted` if the target epoch is
  ///      not strictly in the future, with `ZeroManager` for the
  ///      zero address, and with `ManagerAlreadySet` on duplicate
  ///      nominations.
  /// @param _epoch The epoch to set, strictly greater than
  ///        `currentEpoch`.
  /// @param _who The address to designate as manager.
  function setManager(uint256 _epoch, address _who) external {
    require(msg.sender == auction || (auction == address(0) && msg.sender == owner()), NotAuctionOrOwner());
    require(_epoch > currentEpoch(), EpochAlreadyStarted());
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

  // I.2 — surcharge directionnelle, lue sur l'etat d'avant-swap.
  // Le swap et get_dy passent tous deux par cette vue, ce qui garantit
  // l'accord entre le devis execute et le devis quotable.
  //
  // DEUX BRANCHES, pas de palier intermediaire : la remise directionnelle
  // (R3 bis) et la lecture au point milieu (E6) sont roadmap. La forme
  // reduite tient la demi-journee du chantier, parce que le swap n'a qu'un
  // appel a _getAmountOut et get_dy reste trois lignes au-dessus.
  //
  // La direction se compare sur les RESERVES, jamais sur les parts cibles,
  // et depuis 2026-08-22 les trois cibles sont egales : la regle est exacte
  // dans les deux sens, l'asymetrie du 45/45/10 ne reapparait que le jour
  // ou les cibles cessent d'etre egales.
  //
  // BANDE MORTE lue sur TOL_DEN, JAMAIS sur FEE_DEN. Granularite de tarif
  // et granularite de bande morte ne partagent pas un denominateur (voir
  // build-auction.md 2.1).
  //
  // Le max dans la branche skew protege le cas biaise : un gestionnaire qui
  // ecrit 0 en base ne peut pas rendre la piscine gratuite quand elle est
  // la plus desiquilibree. C'est ce que bunni-v2 faisait avec
  // max(amAmmSwapFee, surgeFee), voir build-auction.md 4.3 (1).
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
    uint256 base = feeInForce();
    uint72[3] memory cachedReserves = reserves;
    if (cachedReserves[_indexIn] * TOL_DEN > cachedReserves[_indexOut] * (TOL_DEN + UNBALANCE_TOL_BPS)) {
      uint256 candidate = base * UNBALANCE_FACTOR;
      uint256 floorSurcharge = NOMINAL_FEE_NUM * UNBALANCE_FACTOR;
      return candidate > floorSurcharge ? candidate : floorSurcharge;
    }
    return base;
  }

  // I.2 — helper de prix, pur sur les reserves qu'on lui passe. Prend la
  // forme d'un quotient de produit constant, sans frais : la function
  // appelante (swap ou get_dy) a deja nette les frais de l'entree.
  function _getAmountOut(uint72[3] memory _cachedReserves, uint256 _indexIn, uint256 _indexOut, uint256 _dxAfterFee) internal pure returns (uint256) {
    return _dxAfterFee * _cachedReserves[_indexOut] / (_dxAfterFee + _cachedReserves[_indexIn]);
  }

  /// @notice Devis de routage : rend la sortie de swap pour une entree
  ///         donnee, sur l'etat pre-swap.
  /// @dev Convention `get_dy` de Curve : un devis de routage, PAS une
  ///      promesse d'execution. Aucune garde d'execution n'est appliquee
  ///      ici (bandes, pause, ZeroOutput, InsufficientReserve) — la vue
  ///      n'ecrit rien et ne revert pas sur un etat qui ferait echouer
  ///      `swap`. C'est ce qui rend la formule quotable par les
  ///      agregateurs : un `get_dy` rend toujours un nombre, et l'integrateur
  ///      decide ce qu'il fait de l'eventuelle impossibilite. Reproduit
  ///      EXACTEMENT la formule de swap (effective fee puis
  ///      `_getAmountOut`), ce que la simplicite de `effectiveFeeNum`
  ///      garantit : un appel, une multiplication, une division.
  // I.2 — interface Curve. C'est la seule raison pour laquelle un
  // agregateur peut coter ce pool.
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
    uint72[3] memory cachedReserves = reserves;
    uint256 effective = effectiveFeeNum(_indexIn, _indexOut);
    uint256 feeAmount = Math.ceilDiv(_dx * effective, FEE_DEN);
    return _getAmountOut(cachedReserves, _indexIn, _indexOut, _dx - feeAmount);
  }

  // Le seul levier du gestionnaire du mandat courant : il fixe la base de
  // frais pour son epoch, une fois, au début de son mandat.
  //
  // La fenêtre de priorité borne setFee et SEULEMENT setFee. Elle n'accorde
  // aucune exclusivité de swap : le design a retiré cette exclusivité, et le
  // champ priorityBlock qui la servait, le 2026-08-25. La fenêtre n'est pas un
  // droit d'échanger en premier, c'est le créneau pendant lequel le tarif de
  // l'epoch se décide ; passé ce créneau, le tarif est figé pour tout le monde,
  // gestionnaire compris.
  //
  // Pas de whenNotPaused, délibérément : la pause arrête ce qui déplace de la
  // valeur entre les jambes du pool, et setFee n'en déplace pas.

  /// @notice Lets the current epoch's manager set the base fee
  ///         numerator once, inside the priority window.
  /// @dev Reverts with `NotManager` if the caller is not the
  ///      current manager, with `OutsidePriorityWindow` if called
  ///      outside the window, with `FeeAlreadySetThisEpoch` on a
  ///      second call in the same epoch, and with `FeeOutBand` if
  ///      the value falls outside `[MIN_FEE_NUM, MAX_FEE_NUM /
  ///      UNBALANCE_FACTOR]`. Intentionally not gated by
  ///      `whenNotPaused`: setting a fee does not move value.
  /// @param _feeNum The new base-fee numerator, in `FEE_DEN` units.
  function setFee(uint256 _feeNum) external {
    require(msg.sender == manager(), NotManager());
    require((block.timestamp - GENESIS) % EPOCH_DURATION < PRIORITY_WINDOW, OutsidePriorityWindow());
    // L'accès gestionnaire passe EN PREMIER, et c'est ce qui rend cette garde
    // correcte. Au mandat 0, lastSetFeeEpoch vaut 0 et currentEpoch() vaut 0 :
    // la garde serait fausse d'emblée et laisserait passer une écriture. Mais
    // le mandat 0 ne peut JAMAIS avoir de gestionnaire, setManager exigeant
    // _epoch > currentEpoch() ; manager() y rend donc address(0) et la garde
    // d'accès referme avant. L'amorçage est fermé par du code, pas par une
    // coïncidence de valeurs.
    require(lastSetFeeEpoch != currentEpoch(), FeeAlreadySetThisEpoch());
    // Le plafond du gestionnaire est dérivé à la volée, jamais MAX_FEE_NUM et
    // jamais une seconde constante stockée : personne ne paie jamais plus de
    // 0,50 %, et le gestionnaire écrit une base entre 0,01 % et 0,25 %.
    uint256 maxManagerFeeNum = MAX_FEE_NUM / UNBALANCE_FACTOR;
    require(
      _feeNum >= MIN_FEE_NUM && _feeNum <= maxManagerFeeNum,
      FeeOutOfBand(MIN_FEE_NUM, maxManagerFeeNum)
    );

    emit FeeSet(currentEpoch(), msg.sender, feeNum, _feeNum);
    feeNum = uint16(_feeNum);
    lastSetFeeEpoch = uint32(currentEpoch());
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
  /// @param _anchorIndex The reserve to anchor the deposit against.
  /// @param _amount The amount of the anchor token to deposit.
  /// @param _minShares Minimum LP shares the caller accepts.
  /// @return mintedShares The LP shares minted to the caller.
  function addLiquidity(uint256 _anchorIndex, uint256 _amount, uint256 _minShares) external whenNotPaused returns (uint256 mintedShares) {
    // WBTC, LBTC and cbBTC all return true or revert on transferFrom, and none of them is a fee-on-transfer token: no need to check balanceOf
    uint256[3] memory amounts;
    uint256 supply = totalSupply();

    if (supply == 0) {
      mintedShares = 3 * _amount - MINIMUM_LIQUIDITY;
      require(mintedShares >= _minShares, BadSlippage());
      amounts[0] = amounts[1] = amounts[2] = _amount;

      for (uint256 i; i < 3; i++) {
        reserves[i] += uint72(amounts[i]);
      }
      _mint(0x000000000000000000000000000000000000dEaD, MINIMUM_LIQUIDITY);

    } else {
      uint72[3] memory cachedReserves = reserves;

      mintedShares = supply * _amount / cachedReserves[_anchorIndex];
      require(mintedShares > 0, ZeroOutput());
      require(mintedShares >= _minShares, BadSlippage());

      for (uint256 i; i < 3; i++) {
        amounts[i] = Math.ceilDiv(_amount * cachedReserves[i], cachedReserves[_anchorIndex]);
        require(reserves[i] + amounts[i] <= type(uint72).max, ReserveOverflow());
        reserves[i] += uint72(amounts[i]);
      }
    }
    _mint(msg.sender, mintedShares);
    for (uint256 i; i < 3; i++) {
      IERC20(indexToAddress(i)).safeTransferFrom(msg.sender, address(this), amounts[i]);
    }
    emit AddedLiquidity(msg.sender, amounts, mintedShares);
  }

  function removeLiquidity(uint256 _burnedShares, uint256[3] calldata _minOut) external returns (uint256[3] memory amountsOut) {
    uint256 supply = totalSupply();
    require(supply != 0, NotBootstrapped());
    uint72[3] memory cachedReserves = reserves;

    for (uint256 i; i < 3; i++) {
      amountsOut[i] = cachedReserves[i] * _burnedShares / supply;
      require(amountsOut[i] >= _minOut[i], BadSlippage());
      reserves[i] -= uint72(amountsOut[i]);
    }
    _burn(msg.sender, _burnedShares);
    for (uint256 i; i < 3; i++) {
      IERC20(indexToAddress(i)).safeTransfer(msg.sender, amountsOut[i]);
    }
    emit RemovedLiquidity(msg.sender, amountsOut, _burnedShares);
  }

  function swap(uint256 _indexIn, uint256 _amount, uint256 _indexOut, uint256 _minOut) external whenNotPaused returns (uint256 amountOut) {
    uint72[3] memory cachedReserves = reserves;

    // I.2 — le frais n'est plus une constante de pool, c'est une lecture
    // d'etat partagee entre la base (feeInForce) et la surcharge
    // directionnelle (effectiveFeeNum). ceilDiv : E7 — la division ronde
    // en faveur du pool, jamais en faveur de l'appelant.
    uint256 feeAmount = Math.ceilDiv(_amount * effectiveFeeNum(_indexIn, _indexOut), FEE_DEN);
    amountOut = _getAmountOut(cachedReserves, _indexIn, _indexOut, _amount - feeAmount);

    require(amountOut > 0, ZeroOutput());
    require(cachedReserves[_indexOut] > amountOut, InsufficientReserve());
    require(_amount + cachedReserves[_indexIn] <= type(uint72).max, ReserveOverflow());

    // I.2 — partage (base, baseCut, protocolCut, managerCut) deplace AVANT
    // la construction d'afterSwapReserves : les bandes (floor/ceiling)
    // verifient le meme etat que l'ecriture, soit le flux net qui entre
    // dans les reserves (cuts du manager et du protocole defalques). Sans
    // ce deplacement, les bandes s'appliquaient a un etat sur evalue de
    // `baseAmount`, le swap passait la garde avec un pot que l'ecriture
    // ne materialisait pas.
    uint256 baseAmount = _amount * feeInForce() / FEE_DEN;
    // I.7 #6 : plancher `protocolCut` = `baseAmount * PROTOCOL_FEE_BPS /
    // SPLIT_DEN`, soit 10 % de la base (PROTOCOL_FEE_BPS = 1000 sur
    // SPLIT_DEN = 10000). Le partage reste INTERNE : `protocolCut` +
    // `managerCut` = `baseAmount` (90 % au manager) quand un
    // gestionnaire est nomme, sinon `protocolCut` seul = `baseAmount/10`
    // et le 9/10 restant tombe dans les reserves par defaut de
    // gestionnaire (cf. commentaire des ecritures ci-dessous). Aucune
    // fuite vers l'appelant : le swap recoit `amountOut` en jeton de
    // sortie, le frais ne sort pas du pool avant `claimManagerFees` /
    // `claimProtocolFees` (pull-only). Arbitrage tranche le 27-08 : le
    // plancher reste, pas de liberte a la baisse.
    uint256 protocolCut = baseAmount * PROTOCOL_FEE_BPS / SPLIT_DEN;
    address currentManager = manager();
    uint256 managerCut = currentManager == address(0) ? 0 : baseAmount - protocolCut;
    uint256 amountInToReserves = _amount - protocolCut - managerCut;

    uint256[3] memory afterSwapReserves = [uint256(cachedReserves[0]), cachedReserves[1], cachedReserves[2]];
    afterSwapReserves[_indexIn] = amountInToReserves + afterSwapReserves[_indexIn];
    afterSwapReserves[_indexOut] = afterSwapReserves[_indexOut] - amountOut;
    uint256 sum = afterSwapReserves[0] + afterSwapReserves[1] + afterSwapReserves[2];

    for (uint256 i; i < 3; i++) {
      require(afterSwapReserves[i] * 100 < ceiling * sum, CeilingTouched(i));
      require(afterSwapReserves[i] * 100 > floor * sum, FloorTouched(i));
    }

    require(amountOut >= _minOut, BadSlippage());

    // I.2 — ligne de credit des reserves (4.3, regle R5) et ecriture des
    // deux registres. Le partage est asymetrique par construction :
    // protocolCut + managerCut = baseAmount quand un gestionnaire est
    // nomme (90 % / 10 %), mais seulement protocolCut = baseAmount/10
    // sinon, le reste de la base (9/10) tombant dans les reserves par
    // defaut de gestionnaire. La surcharge (feeAmount - baseAmount) reste
    // dans les reserves dans les deux cas. Le manager ne touche JAMAIS
    // la surcharge, sinon il profiterait du desequilibre qu'il tarifie
    // (4.3 (4)). CEI tient : effets avant les transferts.
    reserves[_indexIn] += uint72(amountInToReserves);
    reserves[_indexOut] -= uint72(amountOut);
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

  // I.2 — tirage des frais du gestionnaire, pull-only. CEI tient : la
  // remise a zero du registre precede le transfert, sans exception (5.6 (4)).
  function claimManagerFees(uint256 _tokenIndex) external {
    uint256 owed = feesOwed[msg.sender][_tokenIndex];
    require(owed > 0, ZeroFeesOwed());
    feesOwed[msg.sender][_tokenIndex] = 0;
    IERC20(indexToAddress(_tokenIndex)).safeTransfer(msg.sender, owed);
  }

  // I.2 — tirage de la part protocole, pull-only, payable a la tresorerie
  // immuable. L'argent ne suit jamais la propriete (build-auction.md 4.2) :
  // meme si owner() etait detourne, le flux de tresorerie ne le suivrait
  // pas. Permissionless : n'importe qui peut declencher le virement vers
  // la tresorerie, ce qui supprime la dependance a la bonne volonte d'un
  // bot de gouvernance.
  function claimProtocolFees(uint256 _tokenIndex) external {
    uint256 owed = protocolFeesOwed[_tokenIndex];
    require(owed > 0, ZeroFeesOwed());
    protocolFeesOwed[_tokenIndex] = 0;
    IERC20(indexToAddress(_tokenIndex)).safeTransfer(treasury, owed);
  }

  // I.4 — projection sans ecriture de l'accumulateur paresseux. C'est le
  // seul calcul que `_updateRent` et `claimable` doivent partager, sans
  // quoi la vue et le transfert derivent au premier changement de l'un
  // des deux. `_updateRent` prend la valeur et l'ecrit, `claimable` la
  // retourne telle quelle : l'invariant Foundry differentiel
  // (la vue rend exactement ce que `claimRent` transfere) tient par
  // construction, pas par coincidence.
  //
  // ECHELLE : `rentRate` porte deja le facteur 1e18 (pose par `notifyRent`,
  // consomme par `/ 1e18` dans le repli de traine et dans `claimRent`).
  // L'increment est donc `dt * rentRate / supply`, PAS `* 1e18` de plus :
  // `accPerShare` = loyer par part x 1e18, et `claimRent` retire ce seul
  // 1e18 par `balanceOf(x) * accPerShare / 1e18`.
  //
  // Sous-cas `supply == 0` (aucune part, ni vivante ni morte) : la
  // tranche n'est pas accumulee ; `accPerShare` reste a sa valeur
  // courante et `rentLastUpdate` n'est pas avance ici (c'est le role de
  // `_updateRent`, voir ci-dessous). La tranche sautee n'est jamais
  // reanimee par `_accProjected` : la rent correspondante reste en
  // solde MRN du Pool, non reclamable. `claimable` rapporte donc la
  // valeur figee a `rentLastUpdate`, identique a ce que `claimRent`
  // transfererait apres le flush interne qu'il appelle.
  //
  // Sous-cas `supply == MINIMUM_LIQUIDITY` (I.7 #4) : seules les 1000
  // parts mortes 0x...dEaD subsistent. La branche early-return de
  // `notifyRent` empile alors le rent dans `rentLeftOver` et ne touche
  // NI `accPerShare` NI `rentRate` NI `rentEnd`, donc cette garde
  // n'atteint jamais l'increment : `supply > 0` mais `rentRate == 0`,
  // et la formule `dt * rentRate / supply` rend 0 sans division. Le
  // `claimable` de 0x...dEaD reste nul, conforme au E4 documente (la
  // poussiere est differee, jamais perdue, distribuee au premier LP
  // vivant via le repli de `rentLeftOver`).
  function _accProjected() internal view returns (uint256) {
    if (rentLastUpdate >= rentEnd) return accPerShare; // stream fini ou jamais demarre
    uint256 end = block.timestamp < rentEnd ? block.timestamp : rentEnd;
    uint256 dt = end - rentLastUpdate;
    uint256 supply = totalSupply();
    if (dt == 0 || rentRate == 0 || supply == 0) return accPerShare;
    return accPerShare + dt * rentRate / supply;
  }

  // I.4 — helper interne : flush l'accumulateur jusqu'a min(now, rentEnd).
  // Aucune boucle sur les LP, c'est une multiplication et une division.
  // L'early-return coupe court avant le premier `notifyRent` (rentEnd == 0
  // et rentLastUpdate == 0) puis une fois le stream epuise (rentLastUpdate
  // a rattrape rentEnd) : plus de SSTORE gaspille a chaque transfert.
  // Chaque appel accumule sur `min(now, rentEnd) - rentLastUpdate`, donc
  // toute la rent d'une epoch entre dans `accPerShare` meme si aucun
  // `_update` n'a lieu entre `notifyRent` et la fin du stream.
  //
  // Le facteur 1e18 et le sous-cas supply nul sont documentes sur
  // `_accProjected` ci-dessus, dont cette fonction prend la valeur.
  function _updateRent() internal {
    if (rentLastUpdate >= rentEnd) return; // stream fini ou jamais demarre
    accPerShare = _accProjected();
    rentLastUpdate = block.timestamp < rentEnd ? block.timestamp : rentEnd;
  }

  // I.4 — vue du loyer reclamable par une adresse, fondation de
  // l'invariant Foundry differentiel. Reproduit le calcul que `claimRent`
  // realise cote transfert (accru - rentDebt + rentPending) sans appeler
  // `_updateRent` (une `view` ne peut pas ecrire) et sans muter l'etat :
  // c'est la projection pure, partagee via `_accProjected` avec le
  // chemin d'ecriture, qui garantit l'alignement. Cote front, cette vue
  // remplace le miroir `lib/rentClaimable.ts` et les huit lectures
  // accumulees dans `useRentPosition` (hors de ce diff).
  function claimable(address _who) external view returns (uint256) {
    uint256 acc = _accProjected();
    uint256 accrued = balanceOf(_who) * acc / 1e18;
    uint256 owed = rentPending[_who];
    if (accrued > rentDebt[_who]) owed += accrued - rentDebt[_who];
    return owed;
  }

  // I.4 — override du choke point d'OZ v5 (5.6.1) : mint, burn et transfer
  // passent tous par `_update`. L'ordre (1) → (5) est obligatoire :
  // l'accru en attente des DEUX parties se capture sur leur solde
  // PRE-transfert (etapes 2 et 4), puis leurs dettes se recalent sur le
  // solde POST-transfert (etape 5). Chacun ne touche que le loyer couru
  // pendant qu'il detenait ses parts : « a reward belongs to whoever held
  // the shares WHILE it accrued, not to whoever holds them at claim time ».
  function _update(address from, address to, uint256 value) internal virtual override {
    // (1) Flush l'accumulateur jusqu'a maintenant. Cote sender et
    // receiver voient la meme valeur d'`accPerShare`.
    _updateRent();
    // `_updateRent` est le seul point qui bouge `accPerShare` sur ce
    // chemin (`super._update` ne le touche pas) : une seule lecture,
    // reutilisee en (2), (4) et (5).
    uint256 acc = accPerShare;

    // (2) Capturer le loyer en attente du sender (solde pre-transfert).
    if (from != address(0)) {
      uint256 fromBalance = balanceOf(from);
      uint256 pending = fromBalance * acc / 1e18;
      if (pending > rentDebt[from]) {
        rentPending[from] += pending - rentDebt[from];
      }
    }

    // (3) Mise a jour des soldes (OZ v5).
    super._update(from, to, value);

    // (4) Capturer le loyer en attente du receiver sur son solde
    // PRE-transfert : `balanceOf(to)` est deja post-`super._update`, le
    // solde d'avant vaut `toBalance - value` (le receiver gagne exactement
    // `value`, mint comme transfert). Le crediter sur le solde post
    // compterait deux fois l'accru des `value` parts, deja porte au sender
    // en (2). Symetrique de l'etape (2). Pas de capture si `to == from`.
    uint256 toBalance;
    if (to != address(0) && to != from) {
      toBalance = balanceOf(to);
      uint256 pending = (toBalance - value) * acc / 1e18;
      if (pending > rentDebt[to]) {
        rentPending[to] += pending - rentDebt[to];
      }
    }

    // (5) Reinitialisation des dettes sur les soldes post-transfert. Le
    // sender a maintenant `pre - value` parts, le receiver `pre + value`.
    // Leur futur loyer cumulera a partir de `balance * accPerShare /
    // 1e18` qui vaut leur nouveau solde * l'accumulateur courant.
    // `toBalance` est deja le solde post-transfert du receiver, capture
    // en (4) sous la meme condition : pas de second SLOAD cote receiver.
    if (from != address(0)) {
      rentDebt[from] = balanceOf(from) * acc / 1e18;
    }
    if (to != address(0) && to != from) {
      rentDebt[to] = toBalance * acc / 1e18;
    }
  }

  // I.4 — point d'entree du loyer. Reserve a l'auction (setAuction
  // est one-shot, donc personne d'autre ne peut l'appeler). Flush le
  // stream courant, puis pose le nouveau rate et le nouvel end.
  //
  // Cas E4 (premier mandat, totalSupply == MINIMUM_LIQUIDITY, soit
  // seules les parts mortes existent) : on accumule le rent dans
  // `rentLeftOver` et on ne modifie pas l'accumulateur. Le residu
  // sera distribuable a un futur LP, mais la part acquise aux parts
  // mortes de 0x...dEaD reste non reclamable — c'est la reponse
  // honnete a « ou va la poussiere ? » documentee dans
  // build-auction.md 4.4 (1).
  //
  // M2 (I.7) : le MRN est tire en PULL, pas pousse par l'Auction. Le
  // decouplage entre les deux contrats est l'argument load-bearing :
  // `notifyRent` EST deja garde `onlyAuction` (NotAuction, teste) ; le
  // pull ne rajoute aucune parade, il garantit que la garde de cablage
  // (approbation Auction -> Pool, posee au constructeur de l'Auction,
  // cf. `Auction.sol` constructeur) est l'unique condition manquante.
  // Sans approbation, `safeTransferFrom` reverte `ERC20InsufficientAllowance`
  // et la totalite de la transaction est annulee, y compris les effets
  // d'etat poses plus haut (re-base, rentLeftOver, rentRate, rentEnd,
  // rentLastUpdate) : c'est l'echec bruyant documente en I.7 #10,
  // preferable a une sur-declaration silencieuse. Le retrait du
  // `safeTransfer` de `_settle` rend l'argument vrai PAR CONSTRUCTION :
  // les deux contrats n'ont plus besoin de transferer l'un vers l'autre,
  // chacun n'a qu'a connaitre l'adresse de l'autre et l'approbation.
  function notifyRent(uint256 amount) external {
    require(msg.sender == auction, NotAuction());
    _updateRent();
    uint256 supply = totalSupply();
    if (supply <= MINIMUM_LIQUIDITY) {
      // Seules les parts mortes 0x...dEaD subsistent (ou aucune part) :
      // dEaD ne reclame jamais, la rent ne peut aller a personne. Elle
      // s'empile dans `rentLeftOver`, repliee integralement par le prochain
      // `notifyRent` fait avec `totalSupply() > MINIMUM_LIQUIDITY` et
      // distribuee aux LP alors presents, jamais rendue recouvrable par un
      // admin (build-auction.md E4). Valeur differee, pas perdue : la voie
      // de retour est le fonctionnement nominal du protocole.
      rentLeftOver += amount;
    } else {
      // Re-base du stream : la traine non encore distribuee du stream courant
      // (`rentRate * temps restant`, echelle 1e18) est reversee dans
      // `rentLeftOver` avant l'ecrasement de `rentRate`, sinon elle
      // disparaitrait en silence. `_updateRent()` a deja fige l'accru jusqu'a
      // maintenant, donc la periode ecoulee n'est pas comptee deux fois. Si
      // le stream courant est deja expire la traine vaut zero et seul le
      // `rentLeftOver` deja present (cycle supply bas anterieur) compte, ce
      // que la formule ci-dessous gere sans branche supplementaire.
      if (rentEnd > block.timestamp) {
        rentLeftOver += rentRate * (rentEnd - block.timestamp) / 1e18;
      }
      rentRate = (amount + rentLeftOver) * 1e18 / EPOCH_DURATION;
      rentLeftOver = 0;
      rentEnd = block.timestamp + EPOCH_DURATION;
      rentLastUpdate = block.timestamp;
      emit RentNotified(amount, rentRate, rentEnd);
    }
    // CEI strict : effets d'etat poses AVANT l'interaction externe. Une
    // rejection ici (allowance ou balance de l'Auction) revert
    // integralement la transaction, donc rien de ce qui precede n'est
    // engage. Un appel ulterieur rejoue alors le meme scenario sur le
    // meme `rentLeftOver` / `rentRate` / `rentEnd`.
    IERC20(mrn).safeTransferFrom(msg.sender, address(this), amount);
  }

  // I.4 — tirage du loyer LP, pull-only. Flush l'accumulateur, puis ajoute
  // l'accru vivant du claimant sur son solde courant : un LP passif qui ne
  // bouge jamais ses parts n'a rien dans `rentPending` (alimente seulement
  // par `_update`), il faut donc lire `balanceOf * accPerShare / 1e18 -
  // rentDebt` ici aussi. On y ajoute le `rentPending` deja capture par les
  // transferts passes, puis on refixe la dette sur l'accru courant. CEI
  // strict : toutes les ecritures d'etat (`rentDebt`, `rentPending`)
  // precedent le transfert, un transfert qui revert ne donne pas de
  // double claim.
  function claimRent() external {
    _updateRent();
    uint256 bal = balanceOf(msg.sender);
    uint256 accrued = bal * accPerShare / 1e18;
    uint256 owed = rentPending[msg.sender];
    if (accrued > rentDebt[msg.sender]) {
      owed += accrued - rentDebt[msg.sender];
    }
    // I.7 #7 : `rentDebt = accrued` est INCONDITIONNEL, contrairement
    // au `if` ci-dessus qui ne paye la diff que si `accrued > rentDebt`.
    // C'est intentionnel : `rentDebt` est une dette checkpoint, pas un
    // solde cumule. Le rebaser sur l'accru courant a chaque claim (meme
    // quand l'accru n'a pas bouge, par troncature entiere) garantit
    // que le prochain claim diff depuis le bon point de depart, sans
    // piéger un `rentDebt` desynchronise du `accPerShare` courant.
    // Mettre l'ecriture dans le `if` la rendrait dependante du paiement
    // de la diff, et une succession de claims a `accrued == rentDebt`
    // (troncature au wei pres) figerait `rentDebt` au point precedent.
    rentDebt[msg.sender] = accrued;
    rentPending[msg.sender] = 0;
    require(owed > 0, ZeroRentOwed());
    IERC20(mrn).safeTransfer(msg.sender, owed);
    emit RentClaimed(msg.sender, owed);
  }

}
