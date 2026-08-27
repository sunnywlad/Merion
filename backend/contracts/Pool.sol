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
  uint256 constant public UNBALANCE_FACTOR = 2;
  uint256 constant public UNBALANCE_TOL_BPS = 200;
  uint256 constant public TOL_DEN = 10000;
  uint256 constant public PROTOCOL_FEE_BPS = 1000;
  uint256 constant public SPLIT_DEN = 10000;
  uint256 public immutable NOMINAL_FEE_NUM;

  uint256 public immutable MIN_FEE_NUM;

  uint256 public immutable GENESIS;
  uint256 public immutable EPOCH_DURATION;
  uint256 public immutable PRIORITY_WINDOW;
  address public immutable treasury;

  mapping(uint256 epoch => address) public managerOf;
  address public auction;

  // I.2 — sortie des reserves : deux registres, l'un par gestionnaire
  // (l'adresse du mandat, pas le role) et l'un global pour la part
  // protocole. L'argent reste dans le pool tant que les fonctions de tirage
  // ne l'ont pas pousse vers le manager ou vers la tresorerie, et CEI tient
  // chaque tirage : remise a zero AVANT le transfert.
  mapping(address manager => uint256[3]) public feesOwed;
  uint256[3] public protocolFeesOwed;

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
  // I.2 — appel d'un tirage alors que le registre est vide ; distincte de
  // BadSlippage parce que la cause n'est pas un seuil rate mais une
  // quantite nulle.
  error ZeroFeesOwed();

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

  // I.2 — interface Curve. C'est la seule raison pour laquelle un
  // agregateur peut coter ce pool. Reproduit EXACTEMENT la formule de swap
  // sur l'etat pre-swap, ce que la simplicity de effectiveFeeNum garantit :
  // un appel, une multiplication, une division.
  function get_dy(uint256 _indexIn, uint256 _indexOut, uint256 _dx) external view returns (uint256) {
    uint72[3] memory cachedReserves = reserves;
    uint256 effective = effectiveFeeNum(_indexIn, _indexOut);
    uint256 feeAmount = _dx * effective / FEE_DEN;
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

    // I.2 — le frais n'est plus une constante de pool, c'est une lecture
    // d'etat partagee entre la base (feeInForce) et la surcharge
    // directionnelle (effectiveFeeNum). Le calcul du partage (base, baseCut,
    // protocolCut, managerCut) est deplace apres les requires pour eviter
    // le depassement de pile : la logique est equivalente puisque ces
    // grandeurs ne conditionnent aucun require precedent.
    uint256 feeAmount = _amount * effectiveFeeNum(_indexIn, _indexOut) / FEE_DEN;
    amountOut = _getAmountOut(cachedReserves, _indexIn, _indexOut, _amount - feeAmount);

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

    // I.2 — ligne de credit des reserves (4.3, regle R5) et ecriture des
    // deux registres. Le partage est asymetrique par construction :
    // protocolCut + managerCut = baseAmount quand un gestionnaire est
    // nomme (90 % / 10 %), mais seulement protocolCut = baseAmount/10
    // sinon, le reste de la base (9/10) tombant dans les reserves par
    // defaut de gestionnaire. La surcharge (feeAmount - baseAmount) reste
    // dans les reserves dans les deux cas. Le manager ne touche JAMAIS
    // la surcharge, sinon il profiterait du desequilibre qu'il tarifie
    // (4.3 (4)). CEI tient : effets avant les transferts.
    uint256 baseAmount = _amount * feeInForce() / FEE_DEN;
    uint256 protocolCut = baseAmount * PROTOCOL_FEE_BPS / SPLIT_DEN;
    address currentManager = manager();
    uint256 managerCut = currentManager == address(0) ? 0 : baseAmount - protocolCut;
    reserves[_indexIn] += uint72(_amount - protocolCut - managerCut);
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

}
