import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import MRNModule from "./mrn.js";

// V.0 — Faucet MRN pour la démo. Approvisionné hors ignition par un script de
// seed (`scripts/seed-faucet.ts`) : 1 M MRN transférés depuis le déployeur
// vers ce contrat. L'argument est un motif faucets-BTC-2010, pas un mint :
// `merion.md` (« MRN has NO mint function »).

const DRIP_AMOUNT = 5_000n * 10n ** 18n;        // 5000 MRN par drip
const DRIP_INTERVAL = 8 * 60 * 60;              // 8 h entre drips par adresse

export default buildModule("MrnFaucetModule", (m) => {
  const { mrn } = m.useModule(MRNModule);

  const faucet = m.contract("MrnFaucet", [
    mrn,
    DRIP_AMOUNT,
    DRIP_INTERVAL,
    m.getAccount(0)
  ]);

  return { faucet };
});
