// SPDX-License-Identifier: MIT
//
// Tâche 10 (f) — Parade à la troncature `a * b / c` par `Math.ceilDiv`.
//
// Garde visée : la Pool utilise `Math.ceilDiv` d'OpenZeppelin à toutes
// les divisions arithmétiques de l'AMM où la troncature pourrait profiter
// à l'appelant au détriment du pool. Deux sites load-bearing :
//   1. `Math.ceilDiv(_amount * effectiveFeeNum(...), FEE_DEN)` (Pool.sol:381)
//      → le frais du swap est arrondi AU-DESSUS, jamais en-dessous.
//   2. `Math.ceilDiv(_amount * cachedReserves[i], cachedReserves[_anchor])`
//      (Pool.sol:345) → les montants pris à l'appelant d'`addLiquidity`
//      sont arrondis AU-DESSUS, jamais en-dessous.
//
// L'attaque Solidity 2 : un swap où la multiplication `_amount * effective`
// donne un produit < FEE_DEN, la troncature entière rendrait `fee = 0`,
// l'appelant paierait 0 de frais et le pool perdrait de la valeur à
// chaque transaction. Avec `ceilDiv`, le frais est au minimum 1 wei
// (pour tout `_amount > 0`), et le swap se comporte comme prévu.
//
// Justification du test :
//   Test 1 — `_amount = 1` wei à 8 décimales. La multiplication
//            `1 * 5 = 5` (effective = 5 au nominal), divisée par
//            `FEE_DEN = 10000`, donne 0 en division tronquée. SANS
//            ceilDiv, `feeAmount = 0`, `_amount - 0 = 1`, `amountOut >
//            0`, le swap réussissait. AVEC ceilDiv, `feeAmount = 1`,
//            `_amount - 1 = 0`, `amountOut = 0`, le swap reverte
//            `ZeroOutput()`. Le test affirme ce revert : c'est la preuve
//            directe que ceilDiv est appliqué, parce que le swap n'a
//            réussi à extraire aucune valeur de la Pool.
//   Test 2 — un swap plus gros où la troncature ne joue pas (montant
//            tel que `_amount * effective / FEE_DEN >= 1`). Le swap
//            doit réussir et la cohérence comptable du Pool doit
//            vérifier : `balanceOf(Pool, tokenIn) - balanceOf(Pool,
//            tokenIn)_before == _amount` ET `balanceOf(Pool, tokenOut)`
//            doit avoir diminué de `amountOut`. Si le frais avait été
//            tronqué vers le bas, le solde du Pool en tokenIn serait
//            inférieur à `_amount` et le siphonnage serait silencieux.
//
// Sensibilité au starting state : le test 1 ne dépend pas de l'état des
// réserves (1 wei de fee reste 1 wei, quel que soit le supply).
// Le test 2 utilise un montant modeste (1 unité à 8 décimales) qui
// reste dans la bande (13 %, 53 %) sur n'importe quel état partagé.

import {
  buildAttackContext,
  bootstrapPool,
  expectRevert,
  runAttack,
  resetVerdicts,
  finalize,
} from "./_harness.js";

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  await bootstrapPool(ctx);

  // (1) Test 1 — `_amount = 1` wei. La troncature sans ceilDiv
  //     rendrait fee = 0, le swap extrairait de la valeur. AVEC
  //     ceilDiv, fee = 1, dxAfterFee = 0, amountOut = 0, revert
  //     ZeroOutput.
  await runAttack(
    "ceilDiv sur fee — swap(0, 1, 1, 0) revert avec ZeroOutput (fee ceiled à 1, input entièrement consommé)",
    "revert ZeroOutput() (Math.ceilDiv au Pool.sol:381, fee = 1 sur _amount = 1)",
    async () => {
      await expectRevert(
        ctx,
        ctx.contracts.pool.write.swap(
          [0n, 1n, 1n, 0n],
          { account: ctx.attacker.account },
        ),
        "ZeroOutput",
      );
    },
  );

  // (2) Test 2 — un swap plus gros où la troncature ne joue pas
  //     (`_amount * 5 / 10000 >= 1`, soit `_amount >= 2000`). La
  //     cohérence comptable doit vérifier : (a) le pool reçoit
  //     EXACTEMENT `_amount` en tokenIn ; (b) le pool perd EXACTEMENT
  //     `amountOut` en tokenOut ; (c) le swap ne fait pas apparaître
  //     de parts orphelines. Si le frais avait été tronqué vers le bas
  //     au lieu de ceiled, le solde ERC-20 du Pool en tokenIn serait
  //     inférieur de 1 wei à `_amount`, et c'est précisément ce qu'on
  //     vérifie ici.
  //
  //     Sensibilité au starting state : on swap cbBTC → WBTC
  //     (index 1 → 0) plutôt que WBTC → cbBTC : sur l'état partagé
  //     (reserves[0] ≈ 47,5 % après scripts précédents), pousser
  //     WBTC au-delà de 53 % de la somme ferait reverter le swap
  //     sur CeilingTouched(0) avant d'atteindre la garde ceilDiv.
  //     Drainer WBTC en lui envoyant du cbBTC reste dans la bande.
  await runAttack(
    "ceilDiv sur fee — swap(1, 1e8, 0, 0) cohérent : Pool reçoit _amount, perd amountOut, aucune part orpheline",
    "balanceOf(Pool, cbBtc) après = avant + 1e8, balanceOf(Pool, wbtc) après = avant - amountOut",
    async () => {
      // (a) Snapshot des soldes ERC-20 du Pool avant le swap.
      const cbBtcBefore = (await ctx.contracts.cbBtc.read.balanceOf([
        ctx.contracts.pool.address,
      ])) as bigint;
      const wbtcBefore = (await ctx.contracts.wbtc.read.balanceOf([
        ctx.contracts.pool.address,
      ])) as bigint;
      // Et du supply LP, qui ne doit PAS bouger (le swap ne mint pas
      // de parts, contrairement à addLiquidity).
      const supplyBefore = (await ctx.contracts.pool.read.totalSupply()) as bigint;

      // (b) Snapshot du devis de swap pour récupérer l'amountOut réel.
      //     Le swap peut glitcher d'1 wei à cause des arrondis de bloc
      //     (le devis est lu avant le swap), on accepte un écart de 1
      //     wei côté tokenOut.
      const SWAP_AMOUNT = 1n * 10n ** 8n; // 1 unité à 8 décimales
      const expectedOut = (await ctx.contracts.pool.read.get_dy([
        1n, 0n, SWAP_AMOUNT,
      ])) as bigint;

      // (c) Exécution du swap. L'attaquant a 5e8 cbBTC après bootstrap,
      //     SWAP_AMOUNT = 1e8 : aucun mint supplémentaire requis.
      const tx = await ctx.contracts.pool.write.swap(
        [1n, SWAP_AMOUNT, 0n, 0n],
        { account: ctx.attacker.account },
      );
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== "success") {
        throw new Error(
          `swap a reverter (status=${receipt.status}). Le test 2 de ` +
          `cohérence comptable n'a pas pu être exécuté.`,
        );
      }

      // (d) Lecture APRÈS. Vérification de la cohérence.
      const cbBtcAfter = (await ctx.contracts.cbBtc.read.balanceOf([
        ctx.contracts.pool.address,
      ])) as bigint;
      const wbtcAfter = (await ctx.contracts.wbtc.read.balanceOf([
        ctx.contracts.pool.address,
      ])) as bigint;
      const supplyAfter = (await ctx.contracts.pool.read.totalSupply()) as bigint;

      // (e) Le pool a reçu EXACTEMENT SWAP_AMOUNT cbBTC (et pas
      //     SWAP_AMOUNT - 1, ce qui serait le signe d'un frais tronqué).
      const cbBtcDelta = cbBtcAfter - cbBtcBefore;
      if (cbBtcDelta !== SWAP_AMOUNT) {
        throw new Error(
          `Pool cbBTC delta = ${cbBtcDelta}, attendu exactement ${SWAP_AMOUNT}. ` +
          `Si delta < SWAP_AMOUNT, le frais a été tronqué au lieu d'être ` +
          `ceiled, et le pool a perdu de la valeur au profit de l'appelant.`,
        );
      }
      // (f) Le pool a perdu EXACTEMENT amountOut WBTC (à 1 wei près,
      //     pour absorber le devis pré-swap).
      const wbtcDelta = wbtcBefore - wbtcAfter;
      if (wbtcDelta < expectedOut - 1n || wbtcDelta > expectedOut + 1n) {
        throw new Error(
          `Pool WBTC delta = ${wbtcDelta}, attendu ≈ ${expectedOut} (à 1 wei près). ` +
          `Le swap a livré un montant incohérent avec le devis.`,
        );
      }
      // (g) Le supply LP ne doit pas avoir bougé : le swap ne mint pas
      //     de parts, contrairement à addLiquidity. Si supplyAfter !=
      //     supplyBefore, c'est que la garde `a * b / c` a laissé
      //     apparaître des parts orphelines.
      if (supplyAfter !== supplyBefore) {
        throw new Error(
          `totalSupply a bougé : avant=${supplyBefore} après=${supplyAfter}. ` +
          `Un swap ne doit pas mint de parts LP ; si le supply a bougé, ` +
          `c'est le signe d'un minted-without-delivery côté swap.`,
        );
      }
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_ceil_div :", err);
  process.exit(1);
});
