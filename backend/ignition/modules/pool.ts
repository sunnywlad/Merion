import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import TBTCModule from "./tbtc.js";
import CBBTCModule from "./cbbtc.js";
import LBTCModule from "./lbtc.js";


export default buildModule("PoolModule", (m) => {
  const tokens = [m.useModule(TBTCModule).tbtc, m.useModule(CBBTCModule).cbbtc, m.useModule(LBTCModule).lbtc];

  const pool = m.contract("Pool", [tokens, 5, m.getAccount(0)]);

  return { pool };
});
