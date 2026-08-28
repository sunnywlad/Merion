import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import PoolModule from "./pool.js";
import MRNModule from "./mrn.js";
import AuctionModule from "./auction.js";
import MrnFaucetModule from "./mrnFaucet.js";

// I.3 — Module orchestrateur qui impose l'ordre de deploiement (MRN, Pool,
// Auction, Faucet) puis branche l'enchere sur le pool via `pool.setAuction`.
// Pourquoi un module separe plutot qu'une dependance ajoutee dans pool.ts :
// pool.ts reste pur, sans dependance circulaire sur auction.ts, et l'ordre
// de deploiement reste explicite dans le module dedie. `m.call` sur
// `pool.setAuction(auction)` force Ignition a deployer Auction AVANT
// l'appel, et la levee de AuctionModule par le module orchestrateur garantit
// que Auction est dans le graphe de deploiement.
//
// V.0 — `MrnFaucetModule` est ajoute pour la demo : approvisionne hors
// ignition par `scripts/seed-faucet.ts`, sert les jurés et les consultants.

export default buildModule("MerionModule", (m) => {
  const { mrn } = m.useModule(MRNModule);
  const { pool } = m.useModule(PoolModule);
  const { auction } = m.useModule(AuctionModule);
  const { faucet } = m.useModule(MrnFaucetModule);

  m.call(pool, "setAuction", [auction], { from: m.getAccount(0) });

  return { mrn, pool, auction, faucet };
});
