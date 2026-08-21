import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("TBTCModule", (m) => {
  const tbtc = m.contract("MockWrappedBTC", ["Threshold BTC", "tBTC"]);

  return { tbtc };
});
