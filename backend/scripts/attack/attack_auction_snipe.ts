// SPDX-License-Identifier: MIT
//
// Audit F3 — Capture du mandat au prix plancher par règlement anticipé.
//
// La faille. `Auction.settle` n'avait aucune garde temporelle. N'importe
// qui pouvait, dans UNE SEULE transaction, appeler
// `placeBid(minOpeningBid)` puis `settle()` à la première seconde de la
// fenêtre d'enchère : il devenait gestionnaire du mandat suivant au prix
// plancher, et plus personne ne pouvait surenchérir utilement, puisqu'un
// second `settle` sur la même epoch heurte `Pool.ManagerAlreadySet`. Le
// commentaire du contrat reconnaissait la garde « A4 » comme un FIXME.
// Ce que le snipe volait, ce n'était pas de l'argent : c'était la
// CONTESTABILITÉ du mandat, donc tout l'écart entre le prix plancher et
// le prix de marché — un écart qui revient aux LP sous forme de rente.
//
// Garde visée. `Auction.settle`, branche de capture d'une enchère vive :
// `require(block.timestamp >= startOfEpoch(sellingEpoch - 1) +
// auctionWindow, WindowStillOpen(closesAt))`. La frontière est la MÊME
// expression que celle de `placeBid`, en `>=` d'un côté et en `<` de
// l'autre : la phase de mise et la phase de règlement sont disjointes,
// sans trou ni recouvrement. Le chemin de règlement d'un `pendingEpoch`
// déjà capturé n'est délibérément PAS soumis à cette garde, sinon F1
// reviendrait par la porte de derrière.
//
// Verdict attendu. `WindowStillOpen(closesAt)` sur le règlement anticipé,
// puis succès du règlement à la seconde exacte de fermeture.
//
// État partagé. Le script déploie sa propre paire Pool/Auction : régler
// l'enchère du nœud d'audit consommerait un vrai mandat et laisserait
// l'état irréversible pour les scripts suivants. La paire fraîche rend le
// script rejouable sans redémarrer le nœud, ce qui est interdit.

import {
  buildAttackContext,
  expectRevert,
  runAttack,
  resetVerdicts,
  finalize,
  chainNow,
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
const TREASURY = "0x00000000000000000000000000000000000beef0" as const;

// Déploie une paire Pool/Auction neuve, branchée, à l'epoch 0 de son
// propre GENESIS. Aucune liquidité n'est amorcée : `notifyRent` sur un
// pool vide part dans `rentLeftOver` sans reverter, ce qui suffit au
// chemin de règlement testé ici.
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

  // Le harnais décode les erreurs custom via `ctx.contracts.auction` et
  // `ctx.contracts.pool`. On y substitue la paire fraîche : même ABI,
  // donc `revertWithCustomError` continue de décoder `WindowStillOpen`
  // par son sélecteur, jamais par une comparaison de chaîne.
  ctx.contracts.pool = pool;
  ctx.contracts.auction = auction;

  const genesis = (await pool.read.GENESIS()) as bigint;
  const closesAt = genesis + AUCTION_WINDOW; // fenêtre du mandat 1

  // Le sniper approuve puis pose la mise plancher, à l'ouverture.
  const txApprove = await ctx.contracts.mrn.write.approve(
    [auction.address, MIN_OPENING_BID * 100n],
    { account: ctx.deployer.account },
  );
  await ctx.publicClient.waitForTransactionReceipt({ hash: txApprove });

  const txBid = await auction.write.placeBid([MIN_OPENING_BID], {
    account: ctx.deployer.account,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: txBid });

  // Test 1 — le snipe : régler dans la foulée de la mise plancher.
  await runAttack(
    "Snipe d'enchère — placeBid(minOpeningBid) puis settle() immédiat revert avec WindowStillOpen",
    `revert WindowStillOpen(${closesAt}) (fenêtre de mise encore ouverte, Auction.settle)`,
    async () => {
      const now = await chainNow(ctx);
      if (now >= closesAt) {
        throw new Error(
          `L'horloge du nœud vaut ${now}, déjà au-delà de la fermeture ` +
          `${closesAt} : le snipe n'est plus reproductible sur cet état. ` +
          `Le script déploie pourtant sa propre paire à l'instant courant, ` +
          `donc ce cas signale une AUCTION_WINDOW de production différente ` +
          `de la valeur ${AUCTION_WINDOW} codée ici.`,
        );
      }
      await expectRevert(ctx, auction.write.settle(), "WindowStillOpen");
    },
  );

  // Test 2 — le mandat reste libre. C'est la conséquence utile de la
  // garde, dite du côté du Pool : avant, `managerOf[1]` valait déjà le
  // sniper à cet instant, et la surenchère devenait sans objet.
  await runAttack(
    "Snipe d'enchère — le mandat visé reste sans gestionnaire pendant la fenêtre",
    "managerOf[1] == 0x0 tant que la fenêtre de mise est ouverte",
    async () => {
      const stored = (await pool.read.managerOf([1n])) as string;
      if (stored !== "0x0000000000000000000000000000000000000000") {
        throw new Error(
          `managerOf[1] vaut ${stored} pendant la fenêtre de mise, attendu ` +
          `l'adresse nulle. Le mandat a été attribué avant la clôture : la ` +
          `surenchère est devenue inutile, c'est exactement F3.`,
        );
      }
    },
  );

  // Test 3 — la contrepartie, sans laquelle la garde serait un verrou et
  // non un ordonnancement : à la seconde EXACTE de fermeture, le
  // règlement passe et nomme le gagnant.
  await runAttack(
    "Snipe d'enchère — à la seconde de fermeture, settle() nomme le gagnant",
    "managerOf[1] == le seul enchérisseur, une fois la fenêtre close",
    async () => {
      await warpTo(ctx, closesAt);
      const txSettle = await auction.write.settle({ account: ctx.deployer.account });
      await ctx.publicClient.waitForTransactionReceipt({ hash: txSettle });

      const stored = (await pool.read.managerOf([1n])) as string;
      if (stored.toLowerCase() !== ctx.deployer.account.address.toLowerCase()) {
        throw new Error(
          `managerOf[1] vaut ${stored} après la clôture, attendu ` +
          `${ctx.deployer.account.address}. La garde F3 a fermé le règlement ` +
          `au lieu de le décaler : plus aucun mandat ne peut être attribué.`,
        );
      }
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_auction_snipe :", err);
  process.exit(1);
});
