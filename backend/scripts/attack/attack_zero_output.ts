// SPDX-License-Identifier: MIT
//
// Tâche 9 (c) — Démonstration de la garde `ZeroOutput` sur le swap.
//
// Mécanique : la formule `getAmountOut = dxAfterFee * r_out / (dxAfterFee +
// r_in)` (Pool.sol:243-245) est en division entière. Avec un `_amount`
// sub-unitaire (1 wei à 8 décimales = 0,00000001 unité), le numérateur
// `1 * 100e8 = 10^10` divisé par le dénominateur `(1 + 100e8) = 10000000001`
// donne 0 en arithmétique entière. La garde `require(amountOut > 0,
// ZeroOutput())` (Pool.sol:384) attrape le cas.
//
// Pourquoi pas un montant plus gros : avec `_amount = 100` à 8 décimales,
// `feeAmount = ceilDiv(100 * 5, 10000) = 1`, `dxAfterFee = 99`, et
// `amountOut = 99 * 100e8 / (99 + 100e8) ≈ 98` — non nul. Il faut rester
// sous le wei près pour déclencher ZeroOutput, ce qui est exactement la
// granularité défendue par la garde.

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

  await runAttack(
    "ZeroOutput — swap(0, 1, 1, 0) avec 1 wei à 8 décimales rend 0 en division entière",
    "revert ZeroOutput() : amountOut == 0 (granularité du produit constant)",
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

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_zero_output :", err);
  process.exit(1);
});
