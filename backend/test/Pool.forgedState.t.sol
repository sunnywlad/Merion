// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from "./PoolTestBase.sol";
import {Pool} from "../contracts/Pool.sol";

// Deux comportements qui ne sont observables qu'en forgeant l'etat des
// reserves par `vm.store`, parce qu'aucune sequence d'appels ABI legitime ne
// peut les produire :
//
//   - G2 (ceilDiv) : une jambe a 1 satoshi face a une ancre enorme.
//     L'amorcage est desormais a montants egaux (Pool.sol:93) et les bandes
//     (floor = 13 %, Pool.sol:20) empechent tout swap de vider une jambe en
//     dessous de 13 % de la somme des trois reserves : sur un pool de taille
//     realiste, "13 % de la somme" reste tres au-dessus de 1 satoshi. Le seul
//     moyen d'obtenir une jambe a 1 face a une ancre bien plus grosse est donc
//     de forcer l'etat.
//
//   - Bandes depuis un etat deja hors bande : addLiquidity et removeLiquidity
//     sont proportionnels mais jamais gardes (aucune boucle de bandes n'y
//     existe), donc un pool qui serait hors bande resterait hors bande apres
//     l'un ou l'autre, sans que rien ne le signale. Cet etat de depart
//     lui-meme n'est jamais atteignable en nominal (voir le raisonnement
//     ci-dessus) : il faut le forcer pour observer comment swap() reagit face
//     a lui.
//
// La technique de recherche du slot de `reserves` est dupliquee depuis
// test/Pool.invariant.t.sol plutot que partagee : ce fichier n'a pas besoin du
// PoolHandler ni du reste de l'appareillage d'invariants, et la convention du
// projet est de dupliquer ce genre de petit helper plutot que de forcer un
// import croise entre suites independantes (voir test/README.md).
contract PoolForgedStateTest is Test, PoolTestBase {

  function _findReservesSlot() internal returns (bytes32) {
    pool.addLiquidity(0, 1000e8, 0);

    uint256 r0 = pool.reserves(0);
    uint256 r1 = pool.reserves(1);
    uint256 r2 = pool.reserves(2);
    require(r0 == r1 && r1 == r2, "seed reserves not equal; bootstrap changed shape");
    uint256 packed = (r2 << 144) | (r1 << 72) | r0;

    for (uint256 i = 0; i < 20; i++) {
      bytes32 slot = bytes32(i);
      bytes32 value = vm.load(address(pool), slot);
      if (uint256(value) == packed) {
        return slot;
      }
    }
    revert("reserves slot not found in slots 0..19");
  }

  function _forgeReserves(bytes32 slot, uint256 r0, uint256 r1, uint256 r2) internal {
    uint256 packed = (r2 << 144) | (r1 << 72) | r0;
    vm.store(address(pool), slot, bytes32(packed));
    require(pool.reserves(0) == r0, "forge: reserves[0] mismatch");
    require(pool.reserves(1) == r1, "forge: reserves[1] mismatch");
    require(pool.reserves(2) == r2, "forge: reserves[2] mismatch");
  }

  // ---------------------------------------------------------------------
  // G2 : ceilDiv livre au moins 1 unite a la jambe poussiere
  // ---------------------------------------------------------------------

  function test_AddLiquidityCeilDivDeliversAtLeastOneUnitOnDustLeg() public {
    bytes32 slot = _findReservesSlot();
    // totalSupply() = 3 * 1000e8 (mintedShares du depositor + MINIMUM_LIQUIDITY
    // brulee vers l'adresse morte, Pool.sol:91-98) : inchange par le forgeage,
    // qui ne touche que le slot de `reserves`.
    uint256 supplyBefore = pool.totalSupply();
    assertEq(supplyBefore, 3 * 1000e8, "supplyBefore inattendu apres l'amorcage");

    uint256 anchorReserve = 1_000_000e8; // la "grosse jambe" (ancre = token0)
    uint256 dustReserve = 1;             // la "jambe tres petite (1 satoshi)" (token1)
    _forgeReserves(slot, anchorReserve, dustReserve, anchorReserve);

    uint256 amount = 1e8; // 1 BTC, ancre sur token0
    // amounts[1] = ceilDiv(amount * dustReserve, anchorReserve)
    //            = ceilDiv(1e8 * 1, 1_000_000e8) = ceilDiv(1e8, 1e14)
    // Une troncature (division entiere ordinaire) donnerait 1e8 / 1e14 = 0 :
    // la jambe ne recevrait rien, alors que mintedShares, lui, resterait
    // strictement positif (calcul ci-dessous) : des parts frappees contre
    // rien depose sur cette jambe. ceilDiv, lui, arrondit vers le haut des
    // que le reste est non nul : le resultat est 1, jamais 0.
    //
    // mintedShares = supplyBefore * amount / anchorReserve
    //              = 300 000 000 000 * 1e8 / 1e14
    //              = 300 000 000 000 / 1 000 000
    //              = 300 000 (division exacte)
    uint256 expectedMintedShares = 300_000;

    uint256 mintedShares = pool.addLiquidity(0, amount, 0);

    assertEq(mintedShares, expectedMintedShares, "mintedShares ne correspond pas au calcul a la main");
    assertEq(
      pool.reserves(1),
      dustReserve + 1,
      "ceilDiv doit livrer au moins 1 unite a la jambe poussiere, jamais 0 comme une troncature l'aurait fait"
    );
  }

  // ---------------------------------------------------------------------
  // Bandes : la garde de swap() ne "pardonne" jamais un etat deja hors bande
  // ---------------------------------------------------------------------

  function test_SwapRejectsAnyArrivalStateEvenFromAnAlreadyOutOfBandForgedState() public {
    bytes32 slot = _findReservesSlot();

    // reserves = [1000e8, 50e8, 1000e8], sum = 2050e8. token1 = 50/2050 =
    // 2,44 %, tres sous son plancher (13 %) ; token0 et token2 = 1000/2050 =
    // 48,78 %, chacun a l'interieur de sa bande. Etat inatteignable en
    // nominal (bootstrap egal, add/remove proportionnels, swap garde) :
    // observable uniquement force.
    _forgeReserves(slot, 1000e8, 50e8, 1000e8);

    // Un swap modeste entre les jambes 0 et 2 (token1 n'est ni l'entree ni
    // la sortie, et ne bouge donc pas en valeur absolue) : calcul a la main
    // (feeNum = 5, amount = 1e8) :
    //   amountAfterFee = 1e8 * 995 / 1000 = 99 500 000
    //   amountOut ~= 99 401 000 (amountAfterFee * 1000e8 / (amountAfterFee + 1000e8))
    //   afterSwapReserves ~= [100 100 000 000, 5 000 000 000, 99 900 599 000]
    //   sum ~= 205 000 599 000
    //   token0 ~= 48,83 % (5-53 OK), token1 ~= 2,44 % (< 13, en defaut)
    // La boucle de Pool.sol (lignes 151-154) traite l'indice 0 en premier :
    // il passe ses deux controles (plafond et plancher), donc c'est bien
    // l'indice 1 qui interrompt l'appel, avec FloorTouched(1) — jamais
    // CeilingTouched(0), et jamais un defaut sur l'indice 2 (jamais atteint).
    vm.expectRevert(abi.encodeWithSelector(Pool.FloorTouched.selector, 1));
    pool.swap(0, 1e8, 2, 0);
  }

  function test_AddAndRemoveLiquidityStayUnguardedWhilePoolIsForgedOutOfBand() public {
    bytes32 slot = _findReservesSlot();
    _forgeReserves(slot, 1000e8, 50e8, 1000e8);

    // Ni addLiquidity ni removeLiquidity ne portent la boucle de bandes
    // (elle vit seulement dans swap(), Pool.sol:151-154) : contrairement a
    // swap(), un depot ou un retrait proportionnel restent appelables sur ce
    // pool deja hors bande. Ils ne la corrigent pas (ils restent
    // proportionnels, donc preservent le ratio hors bande), mais ils ne la
    // voient simplement pas : c'est le piege que le fuzzing doit pouvoir
    // reveler (voir Pool.invariant.t.sol, invariant_bandsAlwaysRespected).
    uint256 mintedShares = pool.addLiquidity(0, 100e8, 0);
    assertGt(mintedShares, 0, "addLiquidity doit rester appelable sur un pool force hors bande");

    uint256[3] memory minOut;
    uint256[3] memory amountsOut = pool.removeLiquidity(mintedShares, minOut);
    assertGt(
      amountsOut[0] + amountsOut[1] + amountsOut[2],
      0,
      "removeLiquidity doit rester appelable sur un pool force hors bande"
    );
  }
}
