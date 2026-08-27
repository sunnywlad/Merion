import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import WBTCModule from "./wbtc.js";
import CBBTCModule from "./cbbtc.js";
import LBTCModule from "./lbtc.js";
import MRNModule from "./mrn.js";

const EPOCH_DURATION = 14400;
const PRIORITY_WINDOW = 12;
const MIN_FEE_NUM = 1;
const NOMINAL_FEE_NUM = 5;
const TREASURY = "0xE280AD145C1ab859A05D7a4b1Ba2E6AC208A1a85";

if (NOMINAL_FEE_NUM < MIN_FEE_NUM) {
  throw new Error("nominal sous le plancher du gestionnaire");
}

export default buildModule("PoolModule", (m) => {
  const tokens = [m.useModule(WBTCModule).wbtc, m.useModule(CBBTCModule).cbbtc, m.useModule(LBTCModule).lbtc];
  const { mrn } = m.useModule(MRNModule);

  const pool = m.contract("Pool", [
    tokens,
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    NOMINAL_FEE_NUM,
    TREASURY,
    mrn,
    m.getAccount(0),
  ]);

  return { pool };
});
