// SPDX-License-Identifier: MIT
//
// Audit F1 + F2 — Brique définitive de l'enchère, et règlement au profit
// du mauvais gagnant.
//
// La faille F1. `sellingEpoch` n'est jamais écrit qu'avec
// `currentEpoch() + 1`. Un `pendingEpoch` capturé par la réinitialisation
// de `placeBid` est donc TOUJOURS `<= currentEpoch()`. `_settle` appelait
// `pool.setManager(pendingEpoch, ...)`, le Pool exige `_epoch >
// currentEpoch()`, et le revert `EpochAlreadyStarted` arrivait AVANT la
// remise à zéro du slot en fin de fonction. Le slot n'était donc jamais
// purgé : chaque `settle()` ultérieur rejouait le même revert. Ce n'était
// pas une gêne, c'était la mort du mécanisme — plus aucun mandat nommé,
// plus aucune rente versée aux LP, et les MRN du gagnant capturé
// immobilisés sans aucun chemin de sortie, `refunds` n'ayant jamais été
// crédité pour lui.
//
// La faille F2. `settle()` passait `highBidder` à `_settle` : le meneur
// de l'enchère COURANTE, pas le gagnant de `pendingEpoch`. Masquée par
// F1 (le revert arrivait avant), elle aurait transformé la brique en vol
// de mandat une fois F1 corrigée : le dernier enchérisseur d'une enchère
// en cours aurait été nommé pour le mandat d'un autre.
//
// Gardes visées. `Auction._settle`, branche `if (epoch_ <=
// currentEpoch())` : crédit intégral de `refunds[pendingBidder]`, purge
// du slot, événement `SettlementExpired`, retour sans rien brûler ni
// verser. Et le champ d'état `Auction.pendingBidder`, écrit aux deux
// points de capture (`placeBid` et `settle`) et purgé avec le reste du
// slot.
//
// Verdict attendu. Le mandat périmé est remboursé à SON enchérisseur (A),
// rien n'est crédité au meneur de l'enchère vivante (B), le slot est
// purgé, et l'enchère reste vivante : le mandat suivant se règle
// normalement.
//
// État partagé. Le script déploie sa propre paire Pool/Auction. La
// séquence exige de faire tourner deux epochs entières et de régler de
// vrais mandats ; la jouer sur l'enchère du nœud d'audit consommerait
// l'état des scripts suivants de façon irréversible, et redémarrer le
// nœud est interdit.

import {
  buildAttackContext,
  runAttack,
  resetVerdicts,
  finalize,
  warpTo,
  type AttackContext,
} from "./_harness.js";

const EPOCH_DURATION = 14400n; // 4 h
const PRIORITY_WINDOW = 12n;
const MIN_FEE_NUM = 1n;
const NOMINAL_FEE_NUM = 5n;
const AUCTION_WINDOW = 900n; // 15 min
const MAX_EXTENSION = 0n;
const BID_SILENCE = 60n;
const MIN_OPENING_BID = 10n * 10n ** 18n;
// Mise de A : au-dessus du plancher, pour que le remboursement attendu
// soit un montant distinct du plancher et qu'une confusion entre les deux
// mises se voie dans l'assertion.
const A_BID = 105n * 10n ** 17n; // 10,5 MRN
const TREASURY = "0x00000000000000000000000000000000000beef0" as const;
const ZERO = "0x0000000000000000000000000000000000000000";

async function deployFreshPair(ctx: AttackContext) {
  const { addresses, deployer } = ctx;
  const pool = await ctx.viem.deployContract("Pool", [
    [addresses.wbtc, addresses.cbBtc, addresses.lbtc],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    NOMINAL_FEE_NUM,
    TREASURY,
    addresses.mrn,
    deployer.account.address,
  ]);
  const auction = await ctx.viem.deployContract("Auction", [
    pool.address,
    addresses.mrn,
    AUCTION_WINDOW,
    MAX_EXTENSION,
    BID_SILENCE,
    MIN_OPENING_BID,
  ]);
  const tx = await pool.write.setAuction([auction.address], { account: deployer.account });
  await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
  return { pool, auction };
}

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  const { pool, auction } = await deployFreshPair(ctx);
  ctx.contracts.pool = pool;
  ctx.contracts.auction = auction;

  const { mrn } = ctx.contracts;
  const bidderA = ctx.deployer;   // détient tout le MRN pré-minté
  const bidderB = ctx.attacker;   // financé ci-dessous

  const genesis = (await pool.read.GENESIS()) as bigint;
  const wait = (hash: `0x${string}`) => ctx.publicClient.waitForTransactionReceipt({ hash });

  // Financement et approbations. B reçoit largement de quoi ouvrir une
  // enchère au plancher.
  await wait(await mrn.write.transfer([bidderB.account.address, MIN_OPENING_BID * 10n], {
    account: bidderA.account,
  }));
  await wait(await mrn.write.approve([auction.address, A_BID * 100n], {
    account: bidderA.account,
  }));
  await wait(await mrn.write.approve([auction.address, MIN_OPENING_BID * 10n], {
    account: bidderB.account,
  }));

  // (1) Epoch 0 : A gagne l'enchère du mandat 1.
  await wait(await auction.write.placeBid([A_BID], { account: bidderA.account }));

  // (2) Deux epochs passent sans que personne ne règle. Le mandat 1 a
  //     démarré ET fini. C'est le scénario d'une simple panne du bot :
  //     aucune malveillance n'est requise pour déclencher F1.
  await warpTo(ctx, genesis + 2n * EPOCH_DURATION);

  // (3) B ouvre l'enchère du mandat 3. La réinitialisation par
  //     comparaison capture A dans le slot pending.
  await wait(await auction.write.placeBid([MIN_OPENING_BID], { account: bidderB.account }));

  await runAttack(
    "Brique d'enchère — la capture enregistre bien le mandat périmé (préalable)",
    "pendingEpoch == 1 et pendingBidder == A après la réinitialisation de placeBid",
    async () => {
      const pendingEpoch = (await auction.read.pendingEpoch()) as bigint;
      const pendingBidder = (await auction.read.pendingBidder()) as string;
      if (pendingEpoch !== 1n) {
        throw new Error(
          `pendingEpoch vaut ${pendingEpoch}, attendu 1. La séquence n'a pas ` +
          `produit l'état que les tests suivants interrogent.`,
        );
      }
      if (pendingBidder.toLowerCase() !== bidderA.account.address.toLowerCase()) {
        throw new Error(
          `pendingBidder vaut ${pendingBidder}, attendu ${bidderA.account.address}. ` +
          `C'est F2 : la capture n'a pas mémorisé le gagnant du mandat périmé.`,
        );
      }
    },
  );

  // (4) Le règlement du mandat périmé. Avant, cet appel revertait
  //     `EpochAlreadyStarted` pour toujours.
  const refundABefore = (await auction.read.refunds([bidderA.account.address])) as bigint;
  await runAttack(
    "Brique d'enchère — settle() sur un mandat périmé passe et rembourse le bon enchérisseur",
    `refunds[A] augmente de ${A_BID} (F1 : le mandat est perdu, l'argent revient à son propriétaire)`,
    async () => {
      await wait(await auction.write.settle({ account: bidderB.account }));

      const refundA = (await auction.read.refunds([bidderA.account.address])) as bigint;
      if (refundA - refundABefore !== A_BID) {
        throw new Error(
          `refunds[A] a bougé de ${refundA - refundABefore}, attendu ${A_BID}. ` +
          `Le gagnant du mandat périmé n'a pas récupéré sa mise : le MRN est ` +
          `de nouveau piégé dans l'Auction, sans chemin de sortie.`,
        );
      }
    },
  );

  await runAttack(
    "Brique d'enchère — le meneur de l'enchère vivante ne reçoit rien (F2)",
    "refunds[B] == 0 : B n'a rien à voir avec le mandat périmé de A",
    async () => {
      const refundB = (await auction.read.refunds([bidderB.account.address])) as bigint;
      if (refundB !== 0n) {
        throw new Error(
          `refunds[B] vaut ${refundB}, attendu 0. Le règlement a servi le ` +
          `meneur de l'enchère COURANTE au lieu du gagnant capturé : ` +
          `c'est le vol de mandat de F2.`,
        );
      }
    },
  );

  await runAttack(
    "Brique d'enchère — le slot pending est purgé et le mandat périmé n'a nommé personne",
    "pendingEpoch == 0 et managerOf[1] == 0x0",
    async () => {
      const pendingEpoch = (await auction.read.pendingEpoch()) as bigint;
      if (pendingEpoch !== 0n) {
        throw new Error(
          `pendingEpoch vaut ${pendingEpoch}, attendu 0. Le slot n'est pas ` +
          `purgé : le prochain règlement rejouera le même chemin, la brique ` +
          `se reconstitue.`,
        );
      }
      const managerOfOne = (await pool.read.managerOf([1n])) as string;
      if (managerOfOne !== ZERO) {
        throw new Error(
          `managerOf[1] vaut ${managerOfOne}, attendu l'adresse nulle. Un ` +
          `mandat déjà écoulé ne doit nommer personne.`,
        );
      }
    },
  );

  // (5) La preuve de vie. Le mandat 3, celui de B, se règle normalement
  //     une fois sa fenêtre fermée. Avant, ce règlement était impossible
  //     pour toujours.
  await runAttack(
    "Brique d'enchère — l'enchère reste vivante : le mandat suivant se règle",
    "managerOf[3] == B après la clôture de la fenêtre du mandat 3",
    async () => {
      await warpTo(ctx, genesis + 2n * EPOCH_DURATION + AUCTION_WINDOW);
      await wait(await auction.write.settle({ account: bidderA.account }));

      const managerOfThree = (await pool.read.managerOf([3n])) as string;
      if (managerOfThree.toLowerCase() !== bidderB.account.address.toLowerCase()) {
        throw new Error(
          `managerOf[3] vaut ${managerOfThree}, attendu ${bidderB.account.address}. ` +
          `L'enchère n'a pas survécu au mandat périmé : c'est la brique de F1.`,
        );
      }
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_auction_brick :", err);
  process.exit(1);
});
