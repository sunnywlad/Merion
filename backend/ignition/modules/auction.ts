import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import PoolModule from "./pool.js";
import MRNModule from "./mrn.js";

// I.3 — Enchere ascendante ouverte, branchee sur le pool deja deploye. Le
// module est laisse en deux exports (Pool et MRN par leurs modules
// respectifs) pour qu'un module orchestrateur ulterieur puisse les
// brancher tous les trois, et l'ordre des `useModule` n'a aucune incidence
// sur l'ordre de deploiement final — c'est Ignition qui decide, et un
// deployer de MRN isole a IV.2 (build-auction.md 5.0 (1)) n'importe pas
// AuctionModule du tout.

const AUCTION_WINDOW = 900; // 15 min, build-auction.md 2.2 / 5.0 bis
const MAX_EXTENSION = 0; // A1 roadmap, pas livre a I.3
const BID_SILENCE = 60; // 60 s, fenetre de settle avant la fin de l'epoch
const MIN_OPENING_BID = 10_000_000_000_000_000_000n; // 10 MRN a 18 decimales (restated 2026-08-28, MRN target moved from $0.10 to $0.01, dollar floor unchanged at $0.10)

export default buildModule("AuctionModule", (m) => {
  const { pool } = m.useModule(PoolModule);
  const { mrn } = m.useModule(MRNModule);

  const auction = m.contract("Auction", [
    pool,
    mrn,
    AUCTION_WINDOW,
    MAX_EXTENSION,
    BID_SILENCE,
    MIN_OPENING_BID,
  ]);

  return { auction };
});
