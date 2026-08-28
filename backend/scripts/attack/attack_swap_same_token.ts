// SPDX-License-Identifier: MIT
//
// Tâche 9 (d) — `swap(i, i)` : envoyer et recevoir le même token.
//
// Comportement attendu (pas un bug) : la formule du swap
//   amountOut = dxAfterFee * r_out / (dxAfterFee + r_in)
// (Pool.sol:243-245) ne distingue pas l'index d'entrée de l'index de sortie
// au-delà des noms de variable. Quand `_indexIn == _indexOut`, le résultat
// est strictement inférieur à `_amount`, pour deux raisons additives :
//   - la fee du gestionnaire + protocole (Pool.sol:381), prélevée sur
//     `_amount` en `feeAmount` ;
//   - le price impact du produit constant, qui rend moins que l'entrée
//     dès que `dxAfterFee > 0`.
//
// C'est la démonstration que le pool GAGNE sur la rondeur : un swap où le
// caller semble se rendre la monnaie à lui-même se solde par un transfert
// net vers le pool, sans qu'aucune garde n'ait à s'activer. Le test ne
// cherche donc PAS un revert : il vérifie que la transaction réussit ET
// que l'`amountOut` retourné est strictement inférieur à `_amount`.

import {
  buildAttackContext,
  bootstrapPool,
  runAttack,
  resetVerdicts,
  finalize,
} from "./_harness.js";

const SWAP_AMOUNT = 5n * 10n ** 8n;

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  await bootstrapPool(ctx);

  await runAttack(
    "swap(0, 0) — même token en entrée et sortie : le pool gagne la fee + la rondeur",
    "swap réussit ET amountOut < amountIn (pas de revert attendu)",
    async () => {
      // (1) Devis attendu : get_dy(0, 0, 5e8) lit les réserves 1:1:1 et
      //     applique la formule avec fees. Le résultat est ~4,76e8, soit
      //     ~0,24e8 de moins que l'entrée — c'est ce que le pool gagne.
      const dySameToken = (await ctx.contracts.pool.read.get_dy([
        0n, 0n, SWAP_AMOUNT,
      ])) as bigint;

      // (2) Le swap lui-même. Aucune garde ne doit s'activer : on est dans
      //     la bande (réserves inchangées : on rend moins qu'on n'envoie
      //     sur la même jambe), on n'est pas sub-unitaire, et `amountOut
      //     >= 0` tient trivialement.
      const tx = await ctx.contracts.pool.write.swap(
        [0n, SWAP_AMOUNT, 0n, 0n],
        { account: ctx.attacker.account },
      );
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== "success") {
        throw new Error(
          `Le swap a reverter (status=${receipt.status}). Une garde non ` +
          `attendue s'est activée sur swap(0, 0).`,
        );
      }

      // (3) Vérification sémantique : le pool gagne. amountOut < amountIn,
      //     conformément à la formule. Si amountOut >= amountIn, soit la
      //     formule est cassée, soit la garde n'a pas filtré le cas — ce
      //     serait un défaut de la garde, pas une victoire de l'attaquant.
      if (dySameToken >= SWAP_AMOUNT) {
        throw new Error(
          `get_dy(${dySameToken}) >= input(${SWAP_AMOUNT}) : la fee n'est ` +
          `pas appliquée, c'est un défaut de garde.`,
        );
      }
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_swap_same_token :", err);
  process.exit(1);
});
