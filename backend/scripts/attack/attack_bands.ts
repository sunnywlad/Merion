// SPDX-License-Identifier: MIT
//
// Tâche 9 (a) — Démonstration des gardes `CeilingTouched` et `FloorTouched`
// sur le swap du Pool.
//
// Le swap passe par la boucle de garde en Pool.sol:417-420, qui compare
// chaque réserve au pourcentage `ceiling/floor` de la somme des trois
// réserves (la somme est recalculée À CHAQUE tour de boucle, sur l'état
// post-swap). Les pourcentages sont les constantes `FLOOR_PCT = 13` et
// `CEILING_PCT = 53` du contrat, exposées par le harnais. La boucle
// itère i = 0, 1, 2 et teste la ceiling AVANT le floor sur chaque
// jambe : si le floor de la jambe 0 échoue, on reverte avec
// `FloorTouched(0)` sans avoir inspecté les jambes 1 et 2.
//
// Trois conventions ici :
//   1. `swap(indexIn, amount, indexOut, minOut)` : quatre arguments positionnels
//      dans cet ordre, conformément à Pool.sol:374.
//   2. Pour pousser `reserves[i]` AU-DESSUS de `ceiling`, on envoie un autre
//      token dans le pool (swap entrant sur l'index i). Pour pousser en
//      DESSOUS de `floor`, on fait sortir le token i (swap i → j, où i est
//      l'index qu'on draine).
//   3. L'attaquant a 5 unités de chaque BTC mock après bootstrap. C'est
//      insuffisant pour pousser une jambe au-delà de 53 % de la somme
//      (test 1) ou sous 13 % (test 2) sur l'état observé 828/416/500 :
//      la note du brief de tâche 9 chiffre à ~+59 unités pour le ceiling
//      test et à ~+867 unités pour le floor test (à 8 décimales). On mint
//      donc un complément via `MockWrappedBTC.mint` (permissionless,
//      MockWrappedBTC.sol:16) avant chaque swap hors-bande. La garde
//      s'exécute AVANT `safeTransferFrom` (Pool.sol:417-420 vs :441),
//      donc l'allowance n'est jamais sollicitée pour ces tests.

import {
  buildAttackContext,
  bootstrapPool,
  expectRevert,
  runAttack,
  resetVerdicts,
  finalize,
} from "./_harness.js";

// 200 unités à 8 décimales, soit 2 × 10^10. Robuste sur l'état observé
// 828/416/500 : la jambe d'entrée (reserves[0]) part à 828/1744 = 47,5 %
// (sous 53 %), passe à 1028/1809 = 56,8 % après swap, donc ceiling
// touché. Robuste aussi sur l'état frais 100/100/100 (passe de 33,3 % à
// 69,2 %).
const CEILING_PUSH = 200n * 10n ** 8n;

// Racine carrée entière par la méthode de Newton, tronquée à l'inférieur.
// 4 à 5 itérations suffisent pour des valeurs dans la gamme 10^12. La
// fonction n'est utilisée que par le test (2) et n'a pas besoin d'être
// exportée.
function isqrt(n: bigint): bigint {
  if (n < 0n) {
    throw new Error("isqrt : argument négatif");
  }
  if (n < 2n) {
    return n;
  }
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  await bootstrapPool(ctx);

  // (1) CeilingTouched(0) — envoyer 200 unités de WBTC (index 0) pour porter
  //     reserves[0] au-dessus de 53 % de la somme après swap.
  await runAttack(
    "CeilingTouched(0) — swap(0, 200e8, 1, 0) pousse WBTC > 53 %",
    "revert CeilingTouched(uint256) sur l'index 0",
    async () => {
      // Mint complémentaire WBTC : l'attaquant a 5e8 après bootstrap,
      // 200e8 - 5e8 = 195e8 supplémentaires.
      const extra = CEILING_PUSH - 5n * 10n ** 8n;
      const txMint = await ctx.contracts.wbtc.write.mint(
        [ctx.attacker.account.address, extra],
        { account: ctx.deployer.account },
      );
      await ctx.publicClient.waitForTransactionReceipt({ hash: txMint });

      await expectRevert(
        ctx,
        ctx.contracts.pool.write.swap(
          [0n, CEILING_PUSH, 1n, 0n],
          { account: ctx.attacker.account },
        ),
        "CeilingTouched",
      );
    },
  );

  // (2) FloorTouched(0) — envoyer cbBTC (index 1) pour drainer WBTC
  //     (index 0) sous 13 % de la somme après swap. État-agnostique :
  //     on relit les réserves, on résout analytiquement le swap minimum
  //     qui force `reserves[0] * 100 <= 13 * sum` (le floor du contrat
  //     est strict : `>`, donc l'inégalité post-swap est `<=`), on
  //     applique une marge ×1.5 pour absorber les fees et les cuts
  //     négligés dans la résolution, puis on mint le complément si
  //     l'attaquant n'a pas assez de cbBTC.
  await runAttack(
    "FloorTouched(0) — swap(1, x, 0, 0) pousse WBTC < 13 %",
    "revert FloorTouched(uint256) sur l'index 0",
    async () => {
      // Lecture de l'état (uint72[3] public reserves, getter auto-généré
      // `reserves(uint256)` en Solidity ; viem l'expose en
      // `pool.read.reserves([index])`).
      const [r0, r1, r2] = await Promise.all([
        ctx.contracts.pool.read.reserves([0n]) as Promise<bigint>,
        ctx.contracts.pool.read.reserves([1n]) as Promise<bigint>,
        ctx.contracts.pool.read.reserves([2n]) as Promise<bigint>,
      ]);
      const sum = r0 + r1 + r2;
      // Si le floor est déjà touché (reserves[0] <= 13 % de la somme),
      // un swap d'une seule unité le maintient : la jambe de sortie
      // reste sous 13 % et la garde `FloorTouched(0)` part immédiatement.
      if (100n * r0 <= 13n * sum) {
        await expectRevert(
          ctx,
          ctx.contracts.pool.write.swap(
            [1n, 1n, 0n, 0n],
            { account: ctx.attacker.account },
          ),
          "FloorTouched",
        );
        return;
      }
      // Résolution analytique. Borne recherchée : x tel que
      //   r0 - x * r0 / (x + r1) <= 0.13 * (r0 + r1 + r2 + x - x * r0 / (x + r1))
      // soit, en notant d = 13/100 :
      //   0.13 * x^2 + 0.13 * (2 r1 + r2) * x + 0.13 * r1 * (r1 + r2) - 0.87 * r0 * r1 > 0
      // On multiplie par 100 pour rester en bigint entier :
      //   13 * x^2 + 13 * (2 r1 + r2) * x + 13 * r1 * (r1 + r2) - 87 * r0 * r1 > 0
      // Discrimination : on isole la racine du polynôme.
      //   disc = 169 * (2 r1 + r2)^2 + 52 * r1 * (100 r0 - 13 * sum)
      //   xMin = (sqrt(disc) - 13 * (2 r1 + r2)) / 26
      const linear = 13n * (2n * r1 + r2);
      const constant = 13n * linear * (2n * r1 + r2);
      const r1Times = 4n * 13n * r1 * (100n * r0 - 13n * sum);
      const disc = constant + r1Times;
      const xMin = (isqrt(disc) - linear) / 26n;
      // Marge ×1.5 pour absorber la fee (~0,05 %) et le protocol cut
      // (~0,5 % sur la base, soit ~0,025 % de l'input). +1 pour franchir
      // la borne stricte `r0 * 100 > 13 * sum`.
      const xTarget = (xMin * 3n) / 2n + 1n;
      // L'attaquant a 5e8 cbBTC après le bootstrap (le harnais rejoue
      // l'étape (b) à chaque appel). On mint le delta si besoin.
      const currentBalance = (await ctx.contracts.cbBtc.read.balanceOf([
        ctx.attacker.account.address,
      ])) as bigint;
      if (xTarget > currentBalance) {
        const extra = xTarget - currentBalance;
        const txMint = await ctx.contracts.cbBtc.write.mint(
          [ctx.attacker.account.address, extra],
          { account: ctx.deployer.account },
        );
        await ctx.publicClient.waitForTransactionReceipt({ hash: txMint });
      }
      await expectRevert(
        ctx,
        ctx.contracts.pool.write.swap(
          [1n, xTarget, 0n, 0n],
          { account: ctx.attacker.account },
        ),
        "FloorTouched",
      );
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_bands :", err);
  process.exit(1);
});
