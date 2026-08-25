import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("WBTCModule", (m) => {
  const wbtc = m.contract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);

  return { wbtc };
});
