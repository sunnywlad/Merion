// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Pool} from "../contracts/Pool.sol";
import {MockWrappedBTC} from "../contracts/MockWrappedBTC.sol";
import {MockMisbehavingBTC} from "../contracts/MockMisbehavingBTC.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Couvre G1 : Pool utilise `SafeERC20` (using SafeERC20 for IERC20, Pool.sol:7)
// sur ses quatre sites d'appel (safeTransferFrom dans addLiquidity, safeTransfer
// dans removeLiquidity, safeTransferFrom puis safeTransfer dans swap). La
// promesse de SafeERC20, telle que lue dans le SafeERC20.sol installe
// (node_modules/@openzeppelin/contracts, v5.6) : un jeton dont l'appel reussit
// mais renvoie explicitement `false` doit faire revert (SafeERC20FailedOperation),
// alors qu'un jeton dont l'appel reussit mais ne renvoie AUCUNE donnee (le cas
// USDT) doit etre accepte comme un succes. Ce n'est PAS "les deux revertent" :
// c'est cette distinction precise que SafeERC20 existe pour trancher, et que
// ces tests etablissent des deux cotes, sur chacun des quatre sites.
//
// `misbehaving` joue le role de token0 (a la place de wBTC) : les trois autres
// legs restent des MockWrappedBTC ordinaires, pour isoler le comportement de
// SafeERC20 sur un seul site a la fois plutot que de le diluer sur les trois
// jambes en meme temps.
contract PoolSafeERC20Test is Test {

  MockMisbehavingBTC public misbehaving;
  MockWrappedBTC public cbbtc;
  MockWrappedBTC public lbtc;
  Pool public pool;

  uint256 constant SEED = 1000e8;
  uint256 constant MINT_HEADROOM = 21_000_000e8;

  function setUp() public {
    misbehaving = new MockMisbehavingBTC("Misbehaving BTC", "mBTC");
    cbbtc = new MockWrappedBTC("Coinbase BTC", "cbBTC");
    lbtc = new MockWrappedBTC("Lombard BTC", "lBTC");

    address[3] memory tokens = [address(misbehaving), address(cbbtc), address(lbtc)];
    pool = new Pool(tokens, 14400, 12, 1, 5, address(0xBEEF), address(this));

    misbehaving.mint(address(this), MINT_HEADROOM);
    cbbtc.mint(address(this), MINT_HEADROOM);
    lbtc.mint(address(this), MINT_HEADROOM);

    misbehaving.approve(address(pool), MINT_HEADROOM);
    cbbtc.approve(address(pool), MINT_HEADROOM);
    lbtc.approve(address(pool), MINT_HEADROOM);
  }

  function expectSafeERC20Revert() internal {
    vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(misbehaving)));
  }

  // ---------------------------------------------------------------------
  // I) addLiquidity : safeTransferFrom (Pool.sol:114-116, jambe token0)
  // ---------------------------------------------------------------------

  function test_AddLiquidity_TransferFromReturningFalse_Reverts() public {
    misbehaving.setTransferFromMode(MockMisbehavingBTC.ReturnMode.False);

    expectSafeERC20Revert();
    pool.addLiquidity(0, SEED, 0);
  }

  function test_AddLiquidity_TransferFromReturningNothing_Succeeds() public {
    misbehaving.setTransferFromMode(MockMisbehavingBTC.ReturnMode.Nothing);

    uint256 mintedShares = pool.addLiquidity(0, SEED, 0);

    // Amorcage a montants egaux (Pool.sol:93) : mintedShares = 3 * SEED -
    // MINIMUM_LIQUIDITY, exactement comme un jeton conforme l'aurait donne.
    // L'absence de valeur de retour sur transferFrom n'a rien change au
    // resultat : SafeERC20 l'a traitee comme un succes.
    assertEq(mintedShares, 3 * SEED - pool.MINIMUM_LIQUIDITY());
    assertEq(pool.reserves(0), SEED);
    assertEq(misbehaving.balanceOf(address(pool)), SEED);
  }

  // ---------------------------------------------------------------------
  // II) removeLiquidity : safeTransfer (Pool.sol:130-132, jambe token0)
  // ---------------------------------------------------------------------

  function test_RemoveLiquidity_TransferReturningFalse_Reverts() public {
    pool.addLiquidity(0, SEED, 0);
    misbehaving.setTransferMode(MockMisbehavingBTC.ReturnMode.False);
    // burnedShares est lu AVANT d'armer expectRevert : vm.expectRevert porte
    // sur le tout PROCHAIN appel externe, et pool.balanceOf(...) en est un
    // (meme si c'est une lecture sur `pool` lui-meme). L'evaluer comme
    // argument de removeLiquidity, apres expectSafeERC20Revert(), ferait de
    // CET appel-la le "prochain appel" attendu en echec, alors qu'il reussit
    // toujours : la ligne suivante echouerait alors par surprise.
    uint256 burnedShares = pool.balanceOf(address(this));

    expectSafeERC20Revert();
    uint256[3] memory minOut;
    pool.removeLiquidity(burnedShares, minOut);
  }

  function test_RemoveLiquidity_TransferReturningNothing_Succeeds() public {
    pool.addLiquidity(0, SEED, 0);
    misbehaving.setTransferMode(MockMisbehavingBTC.ReturnMode.Nothing);
    uint256 burnedShares = pool.balanceOf(address(this));
    // La totalite du solde "libre" du deposant (hors MINIMUM_LIQUIDITY,
    // acquis a l'adresse morte) : amountsOut[0] = reserves[0] * burnedShares
    // / totalSupply().
    uint256 expectedOut = uint256(pool.reserves(0)) * burnedShares / pool.totalSupply();

    uint256[3] memory minOut;
    uint256[3] memory amountsOut = pool.removeLiquidity(burnedShares, minOut);

    assertEq(amountsOut[0], expectedOut);
    assertEq(misbehaving.balanceOf(address(this)), MINT_HEADROOM - SEED + expectedOut);
  }

  // ---------------------------------------------------------------------
  // III) swap, jambe entrante : safeTransferFrom (Pool.sol:161)
  // ---------------------------------------------------------------------

  function test_Swap_IndexInTransferFromReturningFalse_Reverts() public {
    pool.addLiquidity(0, SEED, 0);
    misbehaving.setTransferFromMode(MockMisbehavingBTC.ReturnMode.False);

    expectSafeERC20Revert();
    pool.swap(0, 100e8, 1, 0);
  }

  function test_Swap_IndexInTransferFromReturningNothing_Succeeds() public {
    pool.addLiquidity(0, SEED, 0);
    misbehaving.setTransferFromMode(MockMisbehavingBTC.ReturnMode.Nothing);
    uint256 amount = 100e8;
    uint256 amountAfterFee = amount * (pool.FEE_DEN() - pool.feeNum()) / pool.FEE_DEN();
    uint256 expectedOut = amountAfterFee * pool.reserves(1) / (amountAfterFee + pool.reserves(0));

    uint256 amountOut = pool.swap(0, amount, 1, 0);

    assertEq(amountOut, expectedOut);
    assertEq(pool.reserves(0), SEED + amount);
  }

  // ---------------------------------------------------------------------
  // IV) swap, jambe sortante : safeTransfer (Pool.sol:162)
  // ---------------------------------------------------------------------

  function test_Swap_IndexOutTransferReturningFalse_Reverts() public {
    pool.addLiquidity(0, SEED, 0);
    misbehaving.setTransferMode(MockMisbehavingBTC.ReturnMode.False);

    expectSafeERC20Revert();
    pool.swap(1, 100e8, 0, 0);
  }

  function test_Swap_IndexOutTransferReturningNothing_Succeeds() public {
    pool.addLiquidity(0, SEED, 0);
    misbehaving.setTransferMode(MockMisbehavingBTC.ReturnMode.Nothing);
    uint256 amount = 100e8;
    uint256 amountAfterFee = amount * (pool.FEE_DEN() - pool.feeNum()) / pool.FEE_DEN();
    uint256 expectedOut = amountAfterFee * pool.reserves(0) / (amountAfterFee + pool.reserves(1));

    uint256 amountOut = pool.swap(1, amount, 0, 0);

    assertEq(amountOut, expectedOut);
    assertEq(misbehaving.balanceOf(address(this)), MINT_HEADROOM - SEED + expectedOut);
  }
}
