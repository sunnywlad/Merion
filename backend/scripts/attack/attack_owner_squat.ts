// SPDX-License-Identifier: MIT
//
// Audit F6 — L'owner préempte tous les mandats.
//
// La faille. Tant que `auction` vaut `address(0)`, `Pool.setManager`
// acceptait l'owner pour N'IMPORTE QUELLE epoch future, autant de fois
// qu'il le voulait, et `managerOf` n'est jamais réécrivable. Un owner
// malveillant réservait les dix prochains mandats avant de brancher
// l'enchère ; chaque règlement de ces epochs heurtait ensuite
// `ManagerAlreadySet` à l'intérieur de `_settle`, ce qui rejouait la
// brique de F1 avec un autre déclencheur. Le protocole se retrouvait
// avec dix mandats vendus à personne et une enchère morte.
//
// Garde visée. `Pool.setManager` (Pool.sol, branche `if (!isAuction)`) :
// quand l'appelant est l'owner, `_epoch <= currentEpoch() + 1`. La voie
// de l'enchère reste inchangée — elle ne dérive `pendingEpoch` que de
// son propre `sellingEpoch`, toujours égal à `currentEpoch() + 1`.
//
// Verdict attendu. `OwnerEpochTooFar(currentEpoch() + 1)` sur la
// tentative lointaine, et succès sur `currentEpoch() + 1`, qui prouve
// que la garde borne l'amorçage sans le fermer.
//
// Note sur l'état partagé. Sur le nœud d'audit, `setAuction` a déjà été
// appelé par le déploiement Ignition : la voie owner est donc DÉJÀ fermée
// par `NotAuctionOrOwner`, qui parle avant `OwnerEpochTooFar`. Le script
// déploie donc son propre Pool, non branché à une enchère, pour
// interroger la garde F6 en isolation. C'est le seul moyen d'atteindre
// la branche owner, et c'est aussi ce qui rend le script rejouable sans
// redémarrer le nœud.

import {
  buildAttackContext,
  expectRevert,
  runAttack,
  resetVerdicts,
  finalize,
  chainNow,
  type AttackContext,
} from "./_harness.js";

const EPOCH_DURATION = 14400n;
const PRIORITY_WINDOW = 12n;
const MIN_FEE_NUM = 1n;
const NOMINAL_FEE_NUM = 5n;
const TREASURY = "0x00000000000000000000000000000000000beef0" as const;

// Déploie un Pool neuf dont `auction` vaut encore address(0), la seule
// configuration où la branche owner de `setManager` est atteignable.
async function deployFreshPool(ctx: AttackContext) {
  const { addresses, deployer } = ctx;
  // `viem.deployContract` déploie depuis le premier wallet client, qui est
  // aussi `ctx.deployer` (cf. `connectToLocalNode`). L'owner du pool est
  // passé explicitement en dernier argument du constructeur.
  return ctx.viem.deployContract("Pool", [
    [addresses.wbtc, addresses.cbBtc, addresses.lbtc],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    NOMINAL_FEE_NUM,
    TREASURY,
    addresses.mrn,
    deployer.account.address,
  ]);
}

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();

  const freshPool = await deployFreshPool(ctx);
  // Le registre d'erreurs du harnais décode via `ctx.contracts.pool`.
  // On y substitue le pool fraîchement déployé : c'est la MÊME ABI, donc
  // le décodage de `OwnerEpochTooFar` est identique, et l'assertion
  // continue de passer par `revertWithCustomError`, jamais par une
  // comparaison de chaîne.
  ctx.contracts.pool = freshPool;

  const genesis = (await freshPool.read.GENESIS()) as bigint;
  const now = await chainNow(ctx);
  const currentEpoch = (now - genesis) / EPOCH_DURATION;
  const farEpoch = currentEpoch + 10n;

  // Test 1 — le squat proprement dit : l'owner vise dix mandats d'avance.
  await runAttack(
    `Squat de mandats — l'owner tente setManager(currentEpoch + 10 = ${farEpoch}) revert avec OwnerEpochTooFar`,
    `revert OwnerEpochTooFar(${currentEpoch + 1n}) (borne de la voie d'amorçage, Pool.setManager)`,
    async () => {
      await expectRevert(
        ctx,
        freshPool.write.setManager([farEpoch, ctx.attacker.account.address], {
          account: ctx.deployer.account,
        }),
        "OwnerEpochTooFar",
      );
    },
  );

  // Test 2 — la contrepartie. Une garde qui fermerait aussi l'epoch
  // suivante rendrait l'amorçage impossible : le premier mandat ne
  // pourrait plus être posé avant que l'enchère ne soit branchée.
  await runAttack(
    "Squat de mandats — l'owner peut toujours nommer currentEpoch + 1",
    "managerOf[currentEpoch + 1] == attaquant après setManager (la voie d'amorçage reste ouverte)",
    async () => {
      const nextEpoch = currentEpoch + 1n;
      const tx = await freshPool.write.setManager(
        [nextEpoch, ctx.attacker.account.address],
        { account: ctx.deployer.account },
      );
      await ctx.publicClient.waitForTransactionReceipt({ hash: tx });

      const stored = (await freshPool.read.managerOf([nextEpoch])) as string;
      if (stored.toLowerCase() !== ctx.attacker.account.address.toLowerCase()) {
        throw new Error(
          `managerOf[${nextEpoch}] vaut ${stored}, attendu ` +
          `${ctx.attacker.account.address}. La garde F6 a fermé l'amorçage ` +
          `au lieu de le borner : plus aucun premier mandat ne peut être posé.`,
        );
      }
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_owner_squat :", err);
  process.exit(1);
});
