// SPDX-License-Identifier: MIT
//
// Tâche 10 (a) — Pause asymétrique du Pool.
//
// Garde visée : sous pause, les fonctions qui DÉPLACENT de la valeur entre
// les jambes du pool (swap, addLiquidity) doivent revert, mais la SORTIE
// (removeLiquidity) doit rester ouverte. C'est ce qui réfute la lecture
// « bank-run » : un LP qui a déjà déposé peut toujours sortir, même quand
// l'owner a posé le pause d'urgence.
//
// Source : Pool.sol, `whenNotPaused` est posé sur `swap` (ligne 374) et
// `addLiquidity` (ligne 322), PAS sur `removeLiquidity` (ligne 357). Le
// modifieur vient d'OpenZeppelin v5 (`Pausable._whenNotPaused`, qui revert
// avec `EnforcedPause()`), donc la garde est l'erreur custom héritée.
//
// Trois vérifications :
//   1. `swap` revert avec `EnforcedPause` une fois la pause posée.
//   2. `addLiquidity` revert avec `EnforcedPause` une fois la pause posée.
//   3. `removeLiquidity` PASSE — c'est l'asymétrie qui prouve la sortie
//      toujours possible. C'est l'assertion load-bearing du script.
//
// Préparation : l'attaquant n'a aucun LP en sortie d'amorçage. On lui en
// fait minted avant la pause (addLiquidity depuis le déployeur, qui a déjà
// abondonné la Pool au bootstrap), pour que le test (3) ait un appelant
// capable de brûler des parts. La séquence complète est :
//   (0) attacker addLiquidity → mintedShares (réussi, la pause n'est pas
//       encore posée)
//   (1) owner pause()
//   (2) attacker swap         → revert EnforcedPause
//   (3) attacker addLiquidity → revert EnforcedPause
//   (4) attacker removeLiquidity → réussi (asymétrie)
//   (5) owner unpause() pour rendre l'état propre
//
// Sensibilité au starting state : l'addLiquidity de l'étape (0) modifie
// les réserves. Le swap de l'étape (2) ne touche jamais les réserves
// (revert avant `reserves[i] +=`). L'addLiquidity de l'étape (3) non
// plus. Le removeLiquidity de l'étape (4) brûle 1 wei de LP, ce qui est
// négligeable sur un supply de 1,5e9. La garde (5) remet la Pool en
// service pour le script suivant.

import {
  buildAttackContext,
  bootstrapPool,
  expectRevert,
  runAttack,
  resetVerdicts,
  finalize,
} from "./_harness.js";

// Montant de l'addLiquidity préparatoire : 0,001 unité à 8 décimales, soit
// 1e5 wei. Assez pour mintedShares > 0 sur n'importe quel état partagé
// (le test s'exécute après les scripts précédents, donc les réserves sont
// arbitraires), pas assez pour déplacer une jambe au-delà de 53 % de la
// somme.
const SEED_AMOUNT = 1n * 10n ** 5n;

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  await bootstrapPool(ctx);

  // (0) Préparation : l'attaquant dépose pour avoir des parts LP.
  //     addLiquidity est exécuté AVANT la pause, donc la garde
  //     `whenNotPaused` ne mord pas. L'ancre 0 (WBTC) est arbitraire.
  //     _minShares = 0 pour absorber tout `BadSlippage` résiduel.
  const txSeed = await ctx.contracts.pool.write.addLiquidity(
    [0n, SEED_AMOUNT, 0n],
    { account: ctx.attacker.account },
  );
  await ctx.publicClient.waitForTransactionReceipt({ hash: txSeed });

  // (1) L'owner pose la pause.
  const txPause = await ctx.contracts.pool.write.pause({
    account: ctx.deployer.account,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: txPause });

  // (2) swap reverte avec EnforcedPause.
  await runAttack(
    "Pause asymétrique — swap revert avec EnforcedPause",
    "revert EnforcedPause() (whenNotPaused sur swap, Pool.sol:374)",
    async () => {
      await expectRevert(
        ctx,
        ctx.contracts.pool.write.swap(
          [0n, SEED_AMOUNT, 1n, 0n],
          { account: ctx.attacker.account },
        ),
        "EnforcedPause",
      );
    },
  );

  // (3) addLiquidity reverte avec EnforcedPause.
  await runAttack(
    "Pause asymétrique — addLiquidity revert avec EnforcedPause",
    "revert EnforcedPause() (whenNotPaused sur addLiquidity, Pool.sol:322)",
    async () => {
      await expectRevert(
        ctx,
        ctx.contracts.pool.write.addLiquidity(
          [0n, SEED_AMOUNT, 0n],
          { account: ctx.attacker.account },
        ),
        "EnforcedPause",
      );
    },
  );

  // (4) removeLiquidity PASSE — c'est l'asymétrie. On brûle 1 wei de LP,
  //     _minOut à 0 pour absorber tout `BadSlippage`. La transaction doit
  //     explicitement réussir (status === 'success'). Si elle reverte,
  //     c'est que la garde OZ a migré ou que la lecture du contrat est
  //     fausse — c'est `ÉCHEC`.
  await runAttack(
    "Pause asymétrique — removeLiquidity PASSE (sortie toujours possible)",
    "removeLiquidity réussit (PAS de whenNotPaused sur removeLiquidity, Pool.sol:357)",
    async () => {
      const tx = await ctx.contracts.pool.write.removeLiquidity(
        [1n, [0n, 0n, 0n]],
        { account: ctx.attacker.account },
      );
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== "success") {
        throw new Error(
          `removeLiquidity a reverter (status=${receipt.status}). La garde ` +
          `asymétrique ne tient pas : la sortie est bloquée sous pause.`,
        );
      }
    },
  );

  // (5) Owner unpause pour rendre l'état propre aux scripts suivants.
  const txUnpause = await ctx.contracts.pool.write.unpause({
    account: ctx.deployer.account,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: txUnpause });

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_pause_asymmetric :", err);
  process.exit(1);
});
