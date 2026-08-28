// SPDX-License-Identifier: MIT
//
// Tâche 10 (c) — SafeERC20 contre `MockMisbehavingBTC`.
//
// Garde visée : la Pool utilise `SafeERC20.safeTransferFrom` (Pool.sol:352
// et :442) sur les trois tokens du panier. `SafeERC20` d'OpenZeppelin v5
// est l'unique librairie qui ferme les deux pièges d'un token
// `ERC-20` non standard :
//   1. un `transfer` / `transferFrom` qui retourne `false` au lieu de
//      revert → revert `SafeERC20FailedOperation` ;
//   2. un `transfer` / `transferFrom` qui ne retourne RIEN (USDT-style)
//      → toléré (SafeERC20 lit `returndatasize() == 0`).
//
// `MockMisbehavingBTC` (MockMisbehavingBTC.sol) couvre les deux modes
// via `ReturnMode { Normal, False, Nothing }`. La Pool étant déployée
// avec les `MockWrappedBTC` (qui suivent strictement l'interface, mode
// `Normal`), l'attaque ne peut PAS se brancher sur la Pool réelle : les
// tokens du panier sont immuables (Pool.sol:159-161), et la Pool
// n'acceptera jamais un `MockMisbehavingBTC` à leur place.
//
// Le test ci-dessous déploie donc une instance fraîche de
// `MockMisbehavingBTC` et exerce DIRECTEMENT les deux `require` qui
// déclenchent les reverts chaîne enregistrés dans le harnais
// (`STRING_REVERT_OWNER` lignes 356-359 de `_harness.ts`). Ce sont ces
// deux messages que la Pool propagerait vers l'appelant si l'un des
// trois tokens du panier se mettait à les émettre — la chaîne de
// confiance SafeERC20 est ce qui rend la propagation correcte.
//
//   Test 1 : allowance 0, balance > 0              → "insufficient allowance"
//   Test 2 : allowance > 0, balance < amount       → "insufficient balance"
//
// Source des messages : MockMisbehavingBTC.sol:65 ("insufficient balance"
// depuis `_move`) et MockMisbehavingBTC.sol:86 ("insufficient allowance"
// depuis le `require` en tête de `transferFrom`). Le harnais a
// EXACTEMENT ces deux messages ; un troisième message côté contrat ferait
// jeter `expectRevert` avec une erreur explicite, ce qui est l'autre
// moitié de la démonstration (le harnais a la liste fermée, le contrat
// est la source de vérité).

import {
  buildAttackContext,
  expectRevert,
  runAttack,
  resetVerdicts,
  finalize,
} from "./_harness.js";

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  // Pas de bootstrapPool : ce script n'interagit pas avec la Pool, il
  // exerce directement le MockMisbehavingBTC.

  // (1) Déploiement d'une instance fraîche de MockMisbehavingBTC. Le
  //     déployeur est le compte 0 du réseau local ; il finance le gaz.
  const mock = await ctx.viem.deployContract("MockMisbehavingBTC", [
    "MisbehavingMock",
    "mBTC",
  ]);

  // (2) Test 1 — allowance 0, balance > 0. L'attaquant reçoit 100
  //     jetons mais n'approuve personne. `transferFrom` revert avec
  //     "insufficient allowance" AVANT tout mouvement de solde.
  await runAttack(
    "SafeERC20 — transferFrom avec allowance 0 revert avec « insufficient allowance »",
    "revert chaîne \"MockMisbehavingBTC: insufficient allowance\" (MockMisbehavingBTC.sol:86)",
    async () => {
      // Mint 100 (à 8 décimales, peu importe ici) à l'attaquant.
      const txMint = await mock.write.mint(
        [ctx.attacker.account.address, 100n * 10n ** 8n],
        { account: ctx.deployer.account },
      );
      await ctx.publicClient.waitForTransactionReceipt({ hash: txMint });

      // L'attaquant appelle directement transferFrom sans avoir approuvé.
      // On consomme la promesse avec un .catch pour éviter
      // l'unhandledRejection (cf. _harness.ts:371).
      await expectRevert(
        ctx,
        (async () => {
          const tx = await mock.write.transferFrom(
            [ctx.attacker.account.address, ctx.contracts.pool.address, 1n],
            { account: ctx.attacker.account },
          );
          await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
        })(),
        "MockMisbehavingInsufficientAllowance",
      );
    },
  );

  // (3) Test 2 — allowance > 0, balance < amount. On approuve largement,
  //     mais le solde de l'attaquant est inférieur au montant demandé :
  //     `_move` reverte avec "insufficient balance".
  await runAttack(
    "SafeERC20 — transferFrom avec balance < amount revert avec « insufficient balance »",
    "revert chaîne \"MockMisbehavingBTC: insufficient balance\" (MockMisbehavingBTC.sol:65)",
    async () => {
      // L'attaquant a déjà 100 du test précédent ; on approuve 1 000
      // directement à lui-même (allowance[attacker][attacker], parce
      // que le msg.sender du transferFrom ci-dessous est l'attaquant
      // lui-même — c'est l'attaquant qui mime le rôle d'un spender),
      // puis on demande 200 (au-dessus de son solde de 100).
      const txApprove = await mock.write.approve(
        [ctx.attacker.account.address, 1000n * 10n ** 8n],
        { account: ctx.attacker.account },
      );
      await ctx.publicClient.waitForTransactionReceipt({ hash: txApprove });

      await expectRevert(
        ctx,
        (async () => {
          const tx = await mock.write.transferFrom(
            [ctx.attacker.account.address, ctx.contracts.pool.address, 200n * 10n ** 8n],
            { account: ctx.attacker.account },
          );
          await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
        })(),
        "MockMisbehavingInsufficientBalance",
      );
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_safe_erc20 :", err);
  process.exit(1);
});
