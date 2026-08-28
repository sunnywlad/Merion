import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import PoolModule from "./pool.js";
import MRNModule from "./mrn.js";
import AuctionModule from "./auction.js";
import MrnFaucetModule from "./mrnFaucet.js";

// I.3 / Tache 16 (V.3, voie deploiement) — Module orchestrateur qui impose
// l'ordre de deploiement merion.ts == ordre logique exige par la tache 16.
// L'ordre des `useModule` ci-dessous reflete l'ordre de deploiement logique :
//
//   1. Trois mocks (WBTC, CBBTC, LBTC) deployes via PoolModule (pas de
//      dependance, paralleles).
//   2. MRNModule#MRN (pas de dependance).
//   3. MrnFaucetModule#MrnFaucet (ne depend que de MRN ; pourrait tourner
//      en parallele de Pool, mais on le pose ici par souci de lecture
//      sequentielle).
//   4. PoolModule#Pool (depend des 3 mocks + MRN).
//   5. AuctionModule#Auction (depend de Pool + MRN).
//   6. m.call(pool, "setAuction", [auction]) — branche l'enchere au pool
//      (un seul coup, nonce garanti par Ignition).
//
// Le graphe de dependances sous-jacent est inchange : `useModule(MRNModule)`
// n'est pas duplique ici, chaque sous-module l'importe par lui-meme et
// Ignition reconcilie l'identite du deploiement MRN. Pourquoi un module
// separe plutot qu'une dependance ajoutee dans pool.ts : pool.ts reste pur,
// sans dependance circulaire sur auction.ts, et l'ordre de deploiement
// reste explicite dans le module dedie.
//
// V.0 — `MrnFaucetModule` est ajoute pour la demo : approvisionne hors
// ignition par `scripts/seed-faucet.ts`, sert les jurés et les consultants.

export default buildModule("MerionModule", (m) => {
  const { mrn } = m.useModule(MRNModule);
  const { faucet } = m.useModule(MrnFaucetModule);
  const { pool } = m.useModule(PoolModule);
  const { auction } = m.useModule(AuctionModule);

  m.call(pool, "setAuction", [auction], { from: m.getAccount(0) });

  return { mrn, pool, auction, faucet };
});
