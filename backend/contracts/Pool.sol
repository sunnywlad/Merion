// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract Pool is ERC20, Ownable, Pausable {


  address public immutable token0;
  address public immutable token1;
  address public immutable token2;

  uint72[3] public reserves;

  uint256 public feeNum;
  uint256 constant public MAX_FEE_NUM = 10;
  uint256 constant public FEE_DEN = 1000;

  uint256 public lastFeeUpdate;
  uint256 constant public MIN_SET_FEE_DELAY = 1 days;

  uint256 constant public MINIMUM_LIQUIDITY = 1000;

  error FeeTooHigh();
  error FeeUpdateTooSoon();
  error BadSlippage();
  error ReserveOverflow();
  error InsufficientReserve();
  error ZeroOutput();
  error FloorTouched(uint256 tokenIndex);
  error CeilingTouched(uint256 tokenIndex);

  event FeeSet(uint256 oldFee, uint256 newFee);
  event AddedLiquidity(address indexed provider, uint256[3] amountsIn, uint256 mintedShares);
  event RemovedLiquidity(address indexed provider, uint256[3] amountsOut, uint256 burnedShares);
  event Swapped(address indexed swapper, uint256 indexed indexIn, uint256 amountIn, uint256 indexed indexOut, uint256 amountOut);

  constructor(address[3] memory _tokens, uint256 _feeNum, address _feeSetter) ERC20("MerionLP", "MRNLP") Ownable(_feeSetter) {
    require(_feeNum <= MAX_FEE_NUM, FeeTooHigh());
    feeNum = _feeNum;
    lastFeeUpdate = block.timestamp;

    token0 = _tokens[0];
    token1 = _tokens[1];
    token2 = _tokens[2];
  }

  function decimals() public pure override returns (uint8) {
    return 8;
  }

  function setFee(uint256 _feeNum) external onlyOwner {
    require(_feeNum <= MAX_FEE_NUM, FeeTooHigh());
    require(block.timestamp - lastFeeUpdate >= MIN_SET_FEE_DELAY, FeeUpdateTooSoon());
    emit FeeSet(feeNum, _feeNum);
    feeNum = _feeNum;
    lastFeeUpdate = block.timestamp;
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

  function floorOf(uint256 _tokenIndex) internal pure returns (uint256 floor) {
    if (_tokenIndex == 0) {
      floor = 5;
    }  else if (_tokenIndex == 1) {
      floor = 15;
    } else if (_tokenIndex == 2) {
      floor = 22;
    }
  }

  function ceilingOf(uint256 _tokenIndex) internal pure returns (uint256 ceiling) {
    if (_tokenIndex == 0) {
      ceiling = 25;
    }  else if (_tokenIndex == 1) {
      ceiling = 65;
    } else if (_tokenIndex == 2) {
      ceiling = 55;
    }
  }

  function targetOf(uint256 _tokenIndex) internal pure returns (uint256 target) {
    if (_tokenIndex == 0) {
      target = 10;
    }  else if (_tokenIndex == 1) {
      target = 45;
    } else if (_tokenIndex == 2) {
      target = 45;
    }
  }

  function addLiquidity(uint256 _anchorIndex, uint256 _amount, uint256 _minShares) external whenNotPaused returns (uint256 mintedShares) {
    // tBTC, LBTC and cbBTC all return true or revert on transferFrom, and none of them is a fee-on-transfer token: no need to check balanceOf
    uint256[3] memory amounts;
    uint256 supply = totalSupply();

    if (supply == 0) {

      for (uint256 i; i < 3; i++) {
        amounts[i] = _amount * targetOf(i) / targetOf(_anchorIndex);
        require(amounts[i] <= type(uint72).max, ReserveOverflow());
      }

      mintedShares = amounts[0] + amounts[1] + amounts[2] - MINIMUM_LIQUIDITY;
      require(mintedShares >= _minShares, BadSlippage());

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
        amounts[i] = _amount * cachedReserves[i] / cachedReserves[_anchorIndex];
        require(reserves[i] + amounts[i] <= type(uint72).max, ReserveOverflow());
        reserves[i] += uint72(amounts[i]);
      }
    }
    _mint(msg.sender, mintedShares);
    for (uint256 i; i < 3; i++) {
      IERC20(indexToAddress(i)).transferFrom(msg.sender, address(this), amounts[i]);
    }
    emit AddedLiquidity(msg.sender, amounts, mintedShares);
  }

  function removeLiquidity(uint256 _burnedShares, uint256[3] calldata _minOut) external returns (uint256[3] memory amountsOut) {
    uint256 supply = totalSupply();
    uint72[3] memory cachedReserves = reserves;

    for (uint256 i; i < 3; i++) {
      amountsOut[i] = cachedReserves[i] * _burnedShares / supply;
      require(amountsOut[i] >= _minOut[i], BadSlippage());
      reserves[i] -= uint72(amountsOut[i]);
    }
    _burn(msg.sender, _burnedShares);
    for (uint256 i; i < 3; i++) {
      IERC20(indexToAddress(i)).transfer(msg.sender, amountsOut[i]);
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
      require(afterSwapReserves[i] * 100 < ceilingOf(i) * sum, CeilingTouched(i));
      require(afterSwapReserves[i] * 100 > floorOf(i) * sum, FloorTouched(i));
    }
    require(afterSwapReserves[_indexIn] * 100 < ceilingOf(_indexIn) * sum, CeilingTouched(_indexIn));
    require(afterSwapReserves[_indexOut] * 100 > floorOf(_indexOut) * sum, FloorTouched(_indexOut));

    require(amountOut >= _minOut, BadSlippage());

    reserves[_indexIn] += uint72(_amount);
    reserves[_indexOut] -= uint72(amountOut);

    IERC20(indexToAddress(_indexIn)).transferFrom(msg.sender, address(this), _amount);
    IERC20(indexToAddress(_indexOut)).transfer(msg.sender, amountOut);

    emit Swapped(msg.sender, _indexIn, _amount, _indexOut, amountOut);
  }

}
