// SPDX-License-Identifier: MIT
//
// Tâche 9 (b) — Démonstration du revert `BadSlippage` par front-run.
//
// Mécanique : un swap est annoncé avec un `_minOut` calculé sur l'état
// courant du pool (via `get_dy`). Une transaction concurrente (ici jouée
// séquentiellement dans le même script, ce qui suffit à démontrer la
// mécanique) modifie les réserves entre la lecture et l'exécution du swap
// victime. Le swap victime recalcule l'`amountOut` au moment de
// l'exécution et trouve une valeur inférieure à `_minOut`, ce qui déclenche
// la garde `BadSlippage` en Pool.sol:422.
//
// Le front-run vide `reserves[1]` (cbBTC, la jambe de sortie de la victime
// 0 → 1) en opérant le swap inverse : il envoie LBTC (index 2, l'INPUT du
// front-run, qui gonfle `reserves[2]` de `amountInToReserves`) et reçoit
// cbBTC (index 1, l'OUTPUT du front-run, qui DIMINUE `reserves[1]` de
// `amountOut`). Conséquence sur la victime : son swap 0 → 1 tire
// `reserves[1]` encore plus bas que ce que son `get_dy` initial prévoyait,
// et son `amountOut` recalculé tombe sous son `_minOut`. La garde
// `amountOut >= _minOut` (Pool.sol:422) attrape le cas avec `BadSlippage`.
//
// Sensibilité au starting state : le pool sur le nœud partagé peut avoir
// des réserves arbitraires au moment où ce script tourne (chaque script
// d'attaque modifie l'état en exécutant ses propres swaps). Le script ne
// suppose PAS un état 1:1:1 — il choisit un montant de front-run
// suffisamment petit pour rester dans les bandes (13 %, 53 %) quel que
// soit l'état de départ, et suffisamment grand pour faire passer la
// victime sous son `_minOut`.

import {
  buildAttackContext,
  bootstrapPool,
  expectRevert,
  runAttack,
  resetVerdicts,
  finalize,
} from "./_harness.js";

// Montant du swap victime : 0,5 unité à 8 décimales. Le nœud partagé
// (n'importe quelle exécution antérieure de la suite d'attaque) peut avoir
// n'importe quel état de réserves ; on choisit un montant victime assez
// petit pour ne JAMAIS déclencher les gardes de bandes lui-même, quel que
// soit l'état de départ. Sur l'état observé (828/416/500 après plusieurs
// scripts) :
//   - pré-front-run `get_dy(0, 1, 5e7) ≈ 2,37e6` ;
//   - le swap victime ajoute ~5e7 à reserves[0] (de 828e8 à 878e8), tire
//     ~2,15e7 de reserves[1] (de 378e8 à 356e8) — bandes tenues.
const VICTIM_AMOUNT = 5n * 10n ** 7n;

// Montant du front-run : 0,5 unité à 8 décimales. Équivalent au montant
// victime, pour rester symétrique : la dégradation de `get_dy` est
// suffisante (de ~2,37e6 à ~2,15e6, soit ~9 %) pour faire passer la
// victime sous son `_minOut`, mais pas assez pour pousser reserves[1] sous
// le floor. Le bootstrap fournit 5e8 LBTC à l'attaquant, on n'en consomme
// que 5e7 — aucun mint supplémentaire n'est nécessaire.
const FRONT_RUN_AMOUNT = 5n * 10n ** 7n;

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  await bootstrapPool(ctx);

  await runAttack(
    "BadSlippage — front-run envoie LBTC→cbBTC, drainant la sortie du swap victime 0→1",
    "revert BadSlippage() : amountOut recalculé < _minOut capturé avant front-run",
    async () => {
      // (1) La victime calcule son `_minOut` SUR L'ÉTAT INITIAL.
      //     get_dy est une vue (Pool.sol:261), elle rend le devis au point
      //     milieu avant tout swap.
      const dyInitial = (await ctx.contracts.pool.read.get_dy([
        0n, 1n, VICTIM_AMOUNT,
      ])) as bigint;
      const minOut = dyInitial - 1n; // juste à la limite : on exige strictement
      // moins que dyInitial, pour qu'une légère dégradation suffise à faire
      // échouer.

      // (2) Le front-run. swap(2, FRONT_RUN_AMOUNT, 1, 0) envoie LBTC
      //     (index 2, INPUT) et reçoit cbBTC (index 1, OUTPUT) :
      //     `reserves[2]` gonfle de `amountInToReserves`, `reserves[1]`
      //     DIMINUE de `amountOut`. C'est précisément ce retrait sur
      //     `reserves[1]` qui fait chuter l'`amountOut` de la victime
      //     sous son `_minOut` capturé sur l'état pré-front-run.
      //     Aucun mint supplémentaire n'est nécessaire : le bootstrap a
      //     déjà financé l'attaquant de 5e8 LBTC, le front-run n'en
      //     consomme que 5e7.
      const txFrontRun = await ctx.contracts.pool.write.swap(
        [2n, FRONT_RUN_AMOUNT, 1n, 0n],
        { account: ctx.attacker.account },
      );
      await ctx.publicClient.waitForTransactionReceipt({ hash: txFrontRun });

      // (3) Le swap victime avec son `_minOut` stale. Le `get_dy` après
      //     front-run rend nettement moins que `minOut`. La garde
      //     `amountOut >= _minOut` (Pool.sol:422) doit échouer.
      await expectRevert(
        ctx,
        ctx.contracts.pool.write.swap(
          [0n, VICTIM_AMOUNT, 1n, minOut],
          { account: ctx.attacker.account },
        ),
        "BadSlippage",
      );
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_bad_slippage_frontrun :", err);
  process.exit(1);
});
