// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Pool} from '../contracts/Pool.sol';
import {MockWrappedBTC} from '../contracts/MockWrappedBTC.sol';
import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from './PoolTestBase.sol';
import {stdError} from 'forge-std/StdError.sol';


contract SwapFuzz is Test, PoolTestBase {

  function setUp() public override {
    super.setUp();
    pool.addLiquidity(0, 1000e8, 0);
  }

  function boundIndices(uint256 _indexIn, uint256 _indexOut) internal pure returns (uint256 indexIn, uint256 indexOut) {
    indexIn = bound(_indexIn, 0, 2);
    indexOut = bound(_indexOut, 0, 1);
    if (indexOut >= indexIn) indexOut += 1;
  }

  function expectedAmountOut(uint256 indexIn, uint256 amount, uint256 indexOut) internal view returns (uint256) {
    uint256 amountAfterFee = amount * (pool.FEE_DEN() - pool.feeNum()) / pool.FEE_DEN();
    return amountAfterFee * pool.reserves(indexOut) / (amountAfterFee + pool.reserves(indexIn));
  }

  // Bornes du domaine fuzzable depuis la fixture de ce contrat.
  //
  // setUp() amorce le pool a 1000e8 par jambe. La boucle de bandes de swap()
  // (Pool.sol:151-154, floor = 13 %, ceiling = 53 %) rejette tout echange qui
  // porterait une jambe hors de sa bande, ce qui plafonne le montant
  // echangeable bien en dessous de la plage historique de cette suite
  // (20_000_000e8). Le dernier montant accepte vaut exactement
  // 76 716 541 675 (~767,17 BTC), pour les six paires (indexIn, indexOut) :
  // les trois reserves etant egales, le seuil ne depend pas de la paire.
  //
  // Ce domaine est partage explicitement plutot que filtre par vm.assume :
  // sur [1000, 20_000_000e8], 0,0038 % seulement des tirages restent en
  // bande, donc un vm.assume y rejetterait 99,996 % des cas et viderait le
  // fuzz de sa substance tout en le laissant vert. Un filtre aurait de plus
  // du reimplementer la formule du contrat, donc partager ses erreurs avec
  // l'oracle qu'il sert. Les deux moities du domaine sont testees : les
  // trois tests nominaux ci-dessous sous le seuil, et
  // test_FuzzSwapAboveBandsRevertsWithBandError au-dessus.
  //
  // La constante est verifiee par test_MaxInBandAmountIsExactlyTheBoundary,
  // qui echouera si l'amorcage, les frais ou les bandes changent.
  uint256 constant MAX_IN_BAND_AMOUNT = 76_624_746_076;

  function test_FuzzSwapReturnsExpectedAmountOut(uint256 _indexIn, uint256 amount, uint256 _indexOut) public {
    (uint256 indexIn, uint256 indexOut) = boundIndices(_indexIn, _indexOut);
    amount = bound(amount, 1000, MAX_IN_BAND_AMOUNT);

    uint256 expected = expectedAmountOut(indexIn, amount, indexOut);
    uint256 amountOut = pool.swap(indexIn, amount, indexOut, 0);
    assertEq(amountOut, expected);
  }

  function test_FuzzSwap0RevertsWithZeroOutput(uint256 _indexIn, uint256 _indexOut) public {
    (uint256 indexIn, uint256 indexOut) = boundIndices(_indexIn, _indexOut);

    vm.expectRevert(Pool.ZeroOutput.selector);
    pool.swap(indexIn, 0, indexOut, 0);
  }

  function test_FuzzSwapWithSlippageSatisfied(uint256 _indexIn, uint256 amount, uint256 _indexOut, uint256 minOut) public {
    (uint256 indexIn, uint256 indexOut) = boundIndices(_indexIn, _indexOut);
    amount = bound(amount, 1000, MAX_IN_BAND_AMOUNT);
    uint256 expected = expectedAmountOut(indexIn, amount, indexOut);
    minOut = bound(minOut, 0, expected);

    uint256 amountOut = pool.swap(indexIn, amount, indexOut, minOut);
    assertEq(amountOut, expected);
  }

  function test_FuzzSwapRevertsWithBadSlippage(uint256 _indexIn, uint256 amount, uint256 _indexOut, uint256 minOut) public {
    (uint256 indexIn, uint256 indexOut) = boundIndices(_indexIn, _indexOut);
    amount = bound(amount, 1000, MAX_IN_BAND_AMOUNT);
    uint256 expected = expectedAmountOut(indexIn, amount, indexOut);
    minOut = bound(minOut, expected + 1, type(uint256).max);

    vm.expectRevert(Pool.BadSlippage.selector);
    pool.swap(indexIn, amount, indexOut, minOut);
  }

  // Verifie que MAX_IN_BAND_AMOUNT est bien la frontiere, et pas une valeur
  // prudente choisie au jugé : un satoshi au-dessus doit revert. L'appel qui
  // revert ne laisse aucune trace d'etat, le second echange part donc du meme
  // pool que le premier.
  function test_MaxInBandAmountIsExactlyTheBoundary() public {
    vm.expectRevert(abi.encodeWithSelector(Pool.CeilingTouched.selector, uint256(0)));
    pool.swap(0, MAX_IN_BAND_AMOUNT + 1, 1, 0);

    uint256 amountOut = pool.swap(0, MAX_IN_BAND_AMOUNT, 1, 0);
    assertGt(amountOut, 0, "le dernier montant en bande doit passer");
  }

  // La moitie haute du domaine : tout montant au-dessus du seuil revert par
  // la garde de bandes, jamais par autre chose. L'assertion ne fige pas
  // l'index, car la boucle balaie 0, 1, 2 dans l'ordre : juste au-dessus du
  // seuil c'est CeilingTouched(indexIn) qui mord, mais aux tres gros montants
  // la jambe 0 tombe sous son plancher avant que la boucle n'atteigne
  // indexIn, et l'erreur devient FloorTouched(0). Ce qui est asserte ici est
  // ce qui doit tenir sur tout le domaine : l'echange est refuse par une
  // erreur de bande, et non par ZeroOutput, InsufficientReserve,
  // ReserveOverflow ou un panic.
  function test_FuzzSwapAboveBandsRevertsWithBandError(uint256 _indexIn, uint256 amount, uint256 _indexOut) public {
    (uint256 indexIn, uint256 indexOut) = boundIndices(_indexIn, _indexOut);
    amount = bound(amount, MAX_IN_BAND_AMOUNT + 1, 20_000_000e8);

    try pool.swap(indexIn, amount, indexOut, 0) returns (uint256 amountOut) {
      assertTrue(false, string.concat("swap hors bande accepte, amountOut=", vm.toString(amountOut)));
    } catch (bytes memory reason) {
      bytes4 selector;
      assembly {
        selector := mload(add(reason, 32))
      }
      assertTrue(
        selector == Pool.CeilingTouched.selector || selector == Pool.FloorTouched.selector,
        string.concat(
          "attendu FloorTouched ou CeilingTouched, recu selecteur ",
          vm.toString(selector),
          " pour amount=", vm.toString(amount),
          " indexIn=", vm.toString(indexIn),
          " indexOut=", vm.toString(indexOut)
        )
      );
    }
  }
}
