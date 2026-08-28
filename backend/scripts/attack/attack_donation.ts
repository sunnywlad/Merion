// SPDX-License-Identifier: MIT
//
// Tâche 10 (d) — Donation directe au Pool : invariance des réserves
// internes et du prix de swap.
//
// Garde visée : un transfert direct d'un BTC mock vers le Pool, sans passer
// par `addLiquidity`, ne doit faire bouger AUCUNE variable d'état comptable
// du contrat :
//   - `reserves[i]` (le getter uint72[3]) reste IDENTIQUE avant/après ;
//   - `get_dy(i, j, dx)` rend la MÊME valeur avant/après ;
//   - `totalSupply()` reste IDENTIQUE (aucune part LP n'est mintée) ;
//   - le solde ERC-20 du Pool, en revanche, AUGMENTE : c'est la définition
//     d'une donation, et c'est précisément la discordance qui prouve que
//     les réserves comptables ne sont pas synchronisées sur le solde réel.
//
// Mécanique : la Pool n'a aucun `receive()` ni `fallback()` ETH, et le
// transfert ERC-20 d'un token du panier (LBTC, WBTC, cbBTC) n'appelle
// aucun hook sur le contrat receveur (ERC-20 basique, sans
// `tokensReceived`). Le transfert se contente de créditer le solde ERC-20
// du Pool ; la Pool ne le voit jamais.
//
// Conséquence opérationnelle : si une IA passait un don pour un dépôt, le
// prix de swap resterait sur l'état pré-don, et le swap suivant
// sous-pondérerait le token donné. Le swap suivant calculerait l'output
// sur des réserves qui excluent la donation — c'est exactement l'angle
// mort que ce script ferme.
//
// Aucun revert attendu : c'est une DÉMONSTRATION de non-effet, pas une
// garde par exception. Le verdict « OK » est que les trois lectures
// avant/après sont identiques, à l'erreur de lecture près (bigint exact,
// pas d'arrondi).

import {
  buildAttackContext,
  bootstrapPool,
  runAttack,
  resetVerdicts,
  finalize,
  BOOTSTRAP_AMOUNT,
} from "./_harness.js";

// Don importante : 1 unité à 8 décimales au-dessus du bootstrap. Assez
// pour produire une discordance mesurable entre le solde ERC-20 du Pool
// et ses réserves internes, pas assez pour saturer quoi que ce soit.
const DONATION_AMOUNT = BOOTSTRAP_AMOUNT;

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  await bootstrapPool(ctx);

  // (1) Lecture de l'état AVANT donation. Trois grandeurs à capturer :
  //     - `reserves[i]` pour i = 0, 1, 2 (le getter uint72[3]) ;
  //     - `get_dy(i, j, dx)` sur la jambe non ancrée, pour un `dx` de
  //       référence ;
  //     - `balanceOf(pool, token)` côté ERC-20, qui AUGMENTERA.
  const [r0Before, r1Before, r2Before] = await Promise.all([
    ctx.contracts.pool.read.reserves([0n]) as Promise<bigint>,
    ctx.contracts.pool.read.reserves([1n]) as Promise<bigint>,
    ctx.contracts.pool.read.reserves([2n]) as Promise<bigint>,
  ]);
  const supplyBefore = (await ctx.contracts.pool.read.totalSupply()) as bigint;
  const wbtcBalanceBefore = (await ctx.contracts.wbtc.read.balanceOf([
    ctx.contracts.pool.address,
  ])) as bigint;
  // Le devis de référence : get_dy(0, 1, dx) sur 0,001 unité à 8 déc.
  const QUOTE_DX = 1n * 10n ** 5n;
  const dyBefore = (await ctx.contracts.pool.read.get_dy([
    0n, 1n, QUOTE_DX,
  ])) as bigint;

  // (1b) Pré-financement du déployeur. Le déployeur a déjà financé le
  //      bootstrap initial (3 × BOOTSTRAP_AMOUNT transférés à la Pool)
  //      et des scripts antérieurs ont pu entamer son solde. On mint
  //      `DONATION_AMOUNT` supplémentaires pour qu'il ait de quoi
  //      donner, sans dépendre de l'état partagé.
  const deployerBalance = (await ctx.contracts.wbtc.read.balanceOf([
    ctx.deployer.account.address,
  ])) as bigint;
  if (deployerBalance < DONATION_AMOUNT) {
    const topUp = DONATION_AMOUNT - deployerBalance;
    const txMint = await ctx.contracts.wbtc.write.mint(
      [ctx.deployer.account.address, topUp],
      { account: ctx.deployer.account },
    );
    await ctx.publicClient.waitForTransactionReceipt({ hash: txMint });
  }

  // (2) Donation directe. Le déployeur transfère `DONATION_AMOUNT` WBTC
  //     (token index 0) au Pool, SANS passer par addLiquidity. Aucun
  //     hook côté Pool : c'est un ERC-20.move(from, to, amount) banal.
  //     Le déployeur est l'émetteur (le mint a déjà financé ses 100
  //     unités au bootstrap) et le Pool est le destinataire.
  await runAttack(
    "Donation directe — reserves/get_dy/totalSupply invariants sous transfert ERC-20 hors addLiquidity",
    "reserves, get_dy, totalSupply inchangés après donation directe (seul le solde ERC-20 du Pool bouge)",
    async () => {
      // (a) Donation. Le déployeur (compte 0) émet, le Pool reçoit.
      //     Pas d'approbation nécessaire : un transfer direct ne la
      //     consomme pas.
      const txDonate = await ctx.contracts.wbtc.write.transfer(
        [ctx.contracts.pool.address, DONATION_AMOUNT],
        { account: ctx.deployer.account },
      );
      await ctx.publicClient.waitForTransactionReceipt({ hash: txDonate });

      // (b) Lecture de l'état APRÈS. Les mêmes grandeurs, sur le même
      //     nœud, dans la même transaction (pas de bloc intermédiaire
      //     où un autre acteur pourrait muter l'état).
      const [r0After, r1After, r2After] = await Promise.all([
        ctx.contracts.pool.read.reserves([0n]) as Promise<bigint>,
        ctx.contracts.pool.read.reserves([1n]) as Promise<bigint>,
        ctx.contracts.pool.read.reserves([2n]) as Promise<bigint>,
      ]);
      const supplyAfter = (await ctx.contracts.pool.read.totalSupply()) as bigint;
      const wbtcBalanceAfter = (await ctx.contracts.wbtc.read.balanceOf([
        ctx.contracts.pool.address,
      ])) as bigint;
      const dyAfter = (await ctx.contracts.pool.read.get_dy([
        0n, 1n, QUOTE_DX,
      ])) as bigint;

      // (c) Assertions. Les trois invariants doivent tenir :
      //     - reserves[i] inchangés (la Pool n'a pas vu la donation) ;
      //     - totalSupply inchangé (aucune part LP mintée) ;
      //     - get_dy inchangé (les réserves sont la seule source de prix).
      //     En revanche, le solde ERC-20 du Pool doit AVOIR augmenté du
      //     montant donné, ce qui prouve que la donation a bien eu lieu
      //     (sans ça, le test ne démontrerait rien).
      if (r0After !== r0Before || r1After !== r1Before || r2After !== r2Before) {
        throw new Error(
          `reserves ont bougé : avant=(${r0Before},${r1Before},${r2Before}) ` +
          `après=(${r0After},${r1After},${r2After}). Le don直接影响 les ` +
          `réserves comptables, ce qui contredit l'invariant du pool.`,
        );
      }
      if (supplyAfter !== supplyBefore) {
        throw new Error(
          `totalSupply a bougé : avant=${supplyBefore} après=${supplyAfter}. ` +
          `Une donation ne doit mint aucune part LP.`,
        );
      }
      if (dyAfter !== dyBefore) {
        throw new Error(
          `get_dy(0, 1, ${QUOTE_DX}) a bougé : avant=${dyBefore} après=${dyAfter}. ` +
          `Le prix de swap n'aurait pas dû changer : les réserves sont la ` +
          `seule source de prix, et elles sont invariantes.`,
        );
      }
      const wbtcDelta = wbtcBalanceAfter - wbtcBalanceBefore;
      if (wbtcDelta !== DONATION_AMOUNT) {
        throw new Error(
          `Le solde ERC-20 WBTC du Pool n'a pas augmenté de DONATION_AMOUNT : ` +
          `avant=${wbtcBalanceBefore} après=${wbtcBalanceAfter} delta=${wbtcDelta}. ` +
          `Sans cette confirmation, le test ne démontre rien (la donation ` +
          `n'a peut-être même pas eu lieu).`,
        );
      }
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_donation :", err);
  process.exit(1);
});
