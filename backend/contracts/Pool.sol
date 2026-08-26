// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
using SafeERC20 for IERC20;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract Pool is ERC20, Ownable, Pausable {

  address public immutable token0;
  address public immutable token1;
  address public immutable token2;

  uint72[3] public reserves;
  uint8 public constant floor = 13;
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
  uint16 public feeNum;
  uint32 public lastSetFeeEpoch;
  uint256 constant public MAX_FEE_NUM = 50;
  uint256 constant public FEE_DEN = 10000;
  uint256 public immutable NOMINAL_FEE_NUM;
  uint256 constant public UNBALANCE_FACTOR = 2;
  uint256 constant public TOL_DEN = 10000;

  uint256 public immutable MIN_FEE_NUM;

  uint256 public immutable GENESIS;
  uint256 public immutable EPOCH_DURATION;
  uint256 public immutable PRIORITY_WINDOW;
  address public immutable treasury;

  mapping(uint256 epoch => address) public managerOf;
  address public auction;

  uint256 constant public MINIMUM_LIQUIDITY = 1000;

  error FeeTooHigh();
  error EmptyFeeBand();
  error ZeroEpochDuration();
  error PriorityWindowTooLong();
  error BadSlippage();
  error ReserveOverflow();
  error InsufficientReserve();
  error ZeroOutput();
  error NotBootstrapped();
  error FloorTouched(uint256 tokenIndex);
  error CeilingTouched(uint256 tokenIndex);
  error NotAuctionOrOwner();
  error EpochAlreadyStarted();
  error ZeroManager();
  error ManagerAlreadySet();
  error AuctionAlreadySet();
  error NotManager();
  error OutsidePriorityWindow();
  error FeeAlreadySetThisEpoch();
  // Seule erreur de setFee à porter des arguments : c'est la seule dont
  // l'appelant ne peut pas dériver la cause sans lire deux constantes.
  error FeeOutOfBand(uint256 min, uint256 max);

  event FeeSet(uint256 indexed epoch, address indexed manager, uint256 oldFee, uint256 newFee);
  event AddedLiquidity(address indexed provider, uint256[3] amountsIn, uint256 mintedShares);
  event RemovedLiquidity(address indexed provider, uint256[3] amountsOut, uint256 burnedShares);
  event Swapped(address indexed swapper, uint256 indexed indexIn, uint256 amountIn, uint256 indexed indexOut, uint256 amountOut);
  event ManagerSet(uint256 indexed epoch, address indexed manager);

  constructor(
    address[3] memory _tokens,
    uint256 _epochDuration,
    uint256 _priorityWindow,
    uint256 _minFeeNum,
    uint256 _nominalFeeNum,
    address _treasury,
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
    treasury = _treasury;

    feeNum = uint16(_nominalFeeNum);

    token0 = _tokens[0];
    token1 = _tokens[1];
    token2 = _tokens[2];
  }

  function decimals() public pure override returns (uint8) {
    return 8;
  }

  function currentEpoch() public view returns (uint256) {
    return (block.timestamp - GENESIS) / EPOCH_DURATION;
  }

  function manager() public view returns (address) {
    return managerOf[currentEpoch()];
  }

  function setAuction(address _auction) external onlyOwner {
    require(auction == address(0), AuctionAlreadySet());
    auction = _auction;
  }

  function setManager(uint256 _epoch, address _who) external {
    require(msg.sender == auction || (auction == address(0) && msg.sender == owner()), NotAuctionOrOwner());
    require(_epoch > currentEpoch(), EpochAlreadyStarted());
    require(_who != address(0), ZeroManager());
    require(managerOf[_epoch] == address(0), ManagerAlreadySet());
    managerOf[_epoch] = _who;
    emit ManagerSet(_epoch, _who);
  }

  function feeInForce() public view returns (uint256) {
    return lastSetFeeEpoch == currentEpoch() ? feeNum : NOMINAL_FEE_NUM;
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

  function pause() external onlyOwner {
    _pause();
  }
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

    uint256 amountAfterFee = _amount * (FEE_DEN - feeNum) / FEE_DEN;
    amountOut = amountAfterFee * cachedReserves[_indexOut] / (amountAfterFee + cachedReserves[_indexIn]);

    require(amountOut > 0, ZeroOutput());
    require(cachedReserves[_indexOut] > amountOut, InsufficientReserve());
    require(_amount + cachedReserves[_indexIn] <= type(uint72).max, ReserveOverflow());

    uint256[3] memory afterSwapReserves = [uint256(cachedReserves[0]), cachedReserves[1], cachedReserves[2]];
    afterSwapReserves[_indexIn] = _amount + afterSwapReserves[_indexIn];
    afterSwapReserves[_indexOut] = afterSwapReserves[_indexOut] - amountOut;
    uint256 sum = afterSwapReserves[0] + afterSwapReserves[1] + afterSwapReserves[2];

    for (uint256 i; i < 3; i++) {
      require(afterSwapReserves[i] * 100 < ceiling * sum, CeilingTouched(i));
      require(afterSwapReserves[i] * 100 > floor * sum, FloorTouched(i));
    }

    require(amountOut >= _minOut, BadSlippage());

    reserves[_indexIn] += uint72(_amount);
    reserves[_indexOut] -= uint72(amountOut);

    IERC20(indexToAddress(_indexIn)).safeTransferFrom(msg.sender, address(this), _amount);
    IERC20(indexToAddress(_indexOut)).safeTransfer(msg.sender, amountOut);

    emit Swapped(msg.sender, _indexIn, _amount, _indexOut, amountOut);
  }

}
