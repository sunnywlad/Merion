import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import WBTCModule from "./wbtc.js";
import CBBTCModule from "./cbbtc.js";
import LBTCModule from "./lbtc.js";


export default buildModule("PoolModule", (m) => {
  const tokens = [m.useModule(WBTCModule).wbtc, m.useModule(CBBTCModule).cbbtc, m.useModule(LBTCModule).lbtc];

  const pool = m.contract("Pool", [tokens, 5, m.getAccount(0), 1]);

  return { pool };
});
