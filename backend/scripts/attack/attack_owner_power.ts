// SPDX-License-Identifier: MIT
//
// Tâche 10 (b) — Pouvoir de l'owner (et du manager, que le brief confond
// avec l'owner).
//
// Garde visée : le levier `pause` est `onlyOwner` (Pool.sol:305) ; le
// levier `setFee` exige `msg.sender == manager()` (Pool.sol:281). Le
// contrat sépare ces deux rôles :
//   - `owner`       : posé au constructeur, peut pause / unpause / setAuction.
//   - `manager`     : désigné epoch par epoch via l'Auction (setManager),
//                     peut setFee (la base de frais de l'epoch en cours).
// Le brief de la tâche les a confondus (« l'owner tente setFee »). Le
// script ci-dessous TESTE LE CONTRAT, pas le brief : le non-owner comme
// le non-manager tentent les leviers qui ne leur appartiennent pas et le
// revert documenté est celui qui correspond à la garde réelle du contrat.
//
//   Test 1 : un non-owner tente `pause()`        → OwnableUnauthorizedAccount
//   Test 2 : un non-manager tente `setFee(5)`    → NotManager
//
// Les deux reverts sont distincts : le premier vient du modificateur
// `onlyOwner` d'OpenZeppelin (hérité par Pool), le second d'un
// `require(msg.sender == manager(), NotManager())` interne à `setFee`.
// C'est précisément la séparation des rôles que la garde tient ; la
// fusionner reviendrait à priver le gestionnaire de son levier ou à
// donner à l'owner un droit qu'il ne doit pas avoir.
//
// Le test des gardes suivantes (FeeOutOfBand, FeeAlreadySetThisEpoch)
// exige un manager actif, qui ne peut être posé qu'à travers le flux
// Auction (placeBid → settle). Ce flux modifie profondément l'état
// partagé et n'est pas couvert par cette tâche : voir le rapport pour
// la décision de scope.

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

  // Test 1 : un non-owner tente `pause()`. Le déployeur (compte 0) est
  // l'owner, l'attaquant (compte 1) ne l'est pas. Le modificateur
  // `onlyOwner` d'OZ v5 revert avec `OwnableUnauthorizedAccount(address)`,
  // mappé dans le harnais via `ERROR_OWNER` à la ligne 346.
  await runAttack(
    "Pouvoir — non-owner tente pause() revert avec OwnableUnauthorizedAccount",
    "revert OwnableUnauthorizedAccount(address) (onlyOwner sur pause, Pool.sol:305)",
    async () => {
      await expectRevert(
        ctx,
        ctx.contracts.pool.write.pause({ account: ctx.attacker.account }),
        "OwnableUnauthorizedAccount",
      );
    },
  );

  // Test 2 : un non-manager tente `setFee()`. Le déployeur n'est PAS le
  // manager (managerOf est vide, donc `manager()` rend address(0)). La
  // garde est `require(msg.sender == manager(), NotManager())` à
  // Pool.sol:281, et son revert est `NotManager` (mappé dans le harnais
  // via `ERROR_OWNER` à la ligne 323). C'est ici que le brief de la
  // tâche attendait `OwnableUnauthorizedAccount` : c'est l'erreur que
  // donnerait un contrat où setFee serait `onlyOwner`, mais ce n'est
  // PAS le design de Merion. La garde réelle est plus stricte : pas
  // seulement l'owner, mais le manager du mandate en cours.
  await runAttack(
    "Pouvoir — non-manager tente setFee(5) revert avec NotManager",
    "revert NotManager() (msg.sender == manager() sur setFee, Pool.sol:281)",
    async () => {
      // _feeNum = 5 (le nominal) est in-band : la garde FeeOutOfBand
      // (Pool.sol:295-298) ne se déclencherait pas. Ce qu'on teste ici
      // est strictement la garde d'accès, pas la garde de bande.
      await expectRevert(
        ctx,
        ctx.contracts.pool.write.setFee([5n], { account: ctx.attacker.account }),
        "NotManager",
      );
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_owner_power :", err);
  process.exit(1);
});
