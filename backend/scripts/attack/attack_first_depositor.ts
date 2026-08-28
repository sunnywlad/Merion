// SPDX-License-Identifier: MIT
//
// Tâche 10 (e) — Parade à l'inflation du premier déposant.
//
// Garde visée : la parade `MINIMUM_LIQUIDITY` au bootstrap de la Pool
// (Pool.sol:335). Sans elle, un attaquant peut amorcer le pool avec 1
// wei, recevoir un nombre de parts non nul, puis doper le prix d'une
// jambe par un swap massif pour siphonner les parts du premier
// déposant légitime. La parade brûle 1 000 parts à 0x000...dEaD au
// bootstrap, ce qui rend la première part vivante coûteuse à émettre
// (la branche bootstrap force `3 * amount - MINIMUM_LIQUIDITY > 0`, soit
// `amount > 333`).
//
// Justification de la stratégie de test :
// Le bootstrap partagé a déjà tourné (totalSupply ≈ 1,5 × 10^9 sur le
// nœud partagé après les scripts précédents, le déployeur détient ses
// parts du bootstrap 100/100/100). Refaire un bootstrap avec 1 wei
// exigerait de redémarrer le nœud, ce qui est INTERDIT. Le test porte
// donc sur la PROPRIÉTÉ observable sur l'état partagé :
//   1. `balanceOf(0x...dEaD) == MINIMUM_LIQUIDITY` — les 1 000 parts
//      mortes sont toujours là, intactes depuis le bootstrap. C'est la
//      trace directe de la parade : c'est par elles que l'inflation du
//      premier déposant est fermée.
//   2. La valeur des parts mortes est strictement positive : si elle
//      était nulle, la parade ne servirait à rien. On calcule
//      `balanceOf(0x...dEaD) * reserves[i] / totalSupply` pour chaque
//      jambe i et on vérifie que c'est > 0.
//   3. Le premier déposant (déployeur) détient une part non triviale
//      du supply total, supérieure à 1 %. Sans MINIMUM_LIQUIDITY, un
//      attaquant pourrait bootstrapper à 1 wei (reçoit 3 parts), puis
//      déposer massivement, et le déployeur serait siphonné à 0 %.
// Avec MINIMUM_LIQUIDITY, le déployeur détient 3 × BOOTSTRAP_AMOUNT -
// MINIMUM_LIQUIDITY parts au bootstrap (Pool.sol:328), et un dépôt
// massif de l'attaquant ne peut pas ramener cette part à zéro.

import {
  buildAttackContext,
  bootstrapPool,
  runAttack,
  resetVerdicts,
  finalize,
} from "./_harness.js";

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;
// MINIMUM_LIQUIDITY = 1000 (Pool.sol:85). On l'inline pour le rendre
// visible dans le verdict et l'écart à la constante du contrat.
const MINIMUM_LIQUIDITY = 1000n;

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  await bootstrapPool(ctx);

  // (1) Test 1 — la parade a tenu : MINIMUM_LIQUIDITY a été brûlée à
  //     0x...dEaD au bootstrap, et ces parts sont toujours là. Sans
  //     elles, le premier déposant pourrait être siphonné.
  await runAttack(
    "Inflation du premier déposant — MINIMUM_LIQUIDITY brûlée à 0x...dEaD au bootstrap",
    "balanceOf(0x...dEaD) == MINIMUM_LIQUIDITY (Pool.sol:335), invariant du bootstrap",
    async () => {
      const totalSupply = (await ctx.contracts.pool.read.totalSupply()) as bigint;
      const deadShares = (await ctx.contracts.pool.read.balanceOf([DEAD_ADDRESS])) as bigint;

      // La propriété : la Pool a mint EXACTEMENT MINIMUM_LIQUIDITY parts
      // à l'adresse morte, et aucune transaction ultérieure n'a touché
      // ce solde (aucun mint, aucun burn de 0x...dEaD n'est exposé
      // publiquement, et le harnais n'en a pas fait). On exige l'égalité
      // stricte : plus de 1 000 prouverait un bug (mint fantôme), moins
      // de 1 000 prouverait que la garde n'a pas tourné.
      if (deadShares !== MINIMUM_LIQUIDITY) {
        throw new Error(
          `balanceOf(0x...dEaD) = ${deadShares}, attendu exactement ` +
          `MINIMUM_LIQUIDITY = ${MINIMUM_LIQUIDITY}. La parade n'a pas ` +
          `brûlé les 1 000 parts attendues au bootstrap.`,
        );
      }
      // Sanity check : totalSupply >= MINIMUM_LIQUIDITY (sinon le pool
      // n'a que les parts mortes et aucun déposant vivant).
      if (totalSupply < MINIMUM_LIQUIDITY) {
        throw new Error(
          `totalSupply = ${totalSupply} < MINIMUM_LIQUIDITY = ${MINIMUM_LIQUIDITY}. ` +
          `Le pool ne contient que des parts mortes, ce qui contredit ` +
          `l'invariant du bootstrap.`,
        );
      }
    },
  );

  // (2) Test 2 — la parade a un effet observable : les parts mortes
  //     détiennent une part non nulle des réserves du pool, et le
  //     premier déposant (déployeur) détient une part non triviale du
  //     supply total. C'est la propriété d'anti-siphonnage : sans
  //     MINIMUM_LIQUIDITY, un attaquant pourrait amorcer avec 1 wei et
  //     siphonner le premier déposant. Avec MINIMUM_LIQUIDITY, le
  //     déployeur garde une part significative.
  await runAttack(
    "Inflation du premier déposant — parts mortes et parts du déployeur ont une valeur non nulle",
    "value(0x...dEaD, i) > 0 ET balanceOf(deployer) / totalSupply > 1 %",
    async () => {
      // (a) Snapshot de l'état partagé.
      const totalSupply = (await ctx.contracts.pool.read.totalSupply()) as bigint;
      const deadShares = (await ctx.contracts.pool.read.balanceOf([DEAD_ADDRESS])) as bigint;
      const deployerShares = (await ctx.contracts.pool.read.balanceOf([
        ctx.deployer.account.address,
      ])) as bigint;
      const [r0, r1, r2] = await Promise.all([
        ctx.contracts.pool.read.reserves([0n]) as Promise<bigint>,
        ctx.contracts.pool.read.reserves([1n]) as Promise<bigint>,
        ctx.contracts.pool.read.reserves([2n]) as Promise<bigint>,
      ]);

      // (b) Valeur des parts mortes, par jambe. Si l'une des trois
      //     valeurs est nulle, c'est que la parade a échoué à ancrer
      //     une jambe — le pool serait « mort » sur cette jambe.
      const deadValue = (i: number): bigint => deadShares * [r0, r1, r2][i] / totalSupply;
      if (deadValue(0) === 0n || deadValue(1) === 0n || deadValue(2) === 0n) {
        throw new Error(
          `Les parts mortes 0x...dEaD ont une valeur nulle sur au moins ` +
          `une jambe : value[0]=${deadValue(0)} value[1]=${deadValue(1)} ` +
          `value[2]=${deadValue(2)}. La parade n'ancre pas les trois ` +
          `réserves, ce qui ouvre un angle d'attaque par siphonnage.`,
        );
      }

      // (c) Part relative du déployeur. La parade MINIMUM_LIQUIDITY
      //     protège le premier déposant en verrouillant le ratio :
      //     sans elle, un bootstrap à 1 wei donnerait 3 parts au
      //     déployeur, et un attaquant pourrait siphonner. Avec
      //     MINIMUM_LIQUIDITY, le déployeur détient une part non
      //     triviale. On vérifie qu'elle reste > 1 % : un effondrement
      //     sous 1 % signalerait que la parade a été contournée (par
      //     exemple si quelqu'un avait brûlé les 1 000 parts dEaD
      //     ailleurs, ou si le bootstrap avait re-tourné à 1 wei).
      const deployerRatioBps = deployerShares * 10000n / totalSupply;
      if (deployerRatioBps < 100n) {
        throw new Error(
          `Part du déployeur = ${deployerRatioBps} bps (< 1 %). ` +
          `Le déployeur a été siphonné : soit MINIMUM_LIQUIDITY n'a ` +
          `pas été brûlée, soit le pool a été rebootstrappé à 1 wei.`,
        );
      }

      // (d) Cohérence comptable : parts mortes + parts du déployeur
      //     + parts d'autres = totalSupply. On vérifie au moins que
      //     les parts du déployeur sont non nulles et >= 1 (sinon
      //     l'initialisation du bootstrap n'a pas eu lieu).
      if (deployerShares < 1n) {
        throw new Error(
          `balanceOf(deployer) = ${deployerShares}, attendu >= 1. ` +
          `Le déployeur n'a aucune part LP, le bootstrap a échoué.`,
        );
      }
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_first_depositor :", err);
  process.exit(1);
});
