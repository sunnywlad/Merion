import { parseUnits } from "viem";

export function parseAmount(value: string, decimals=8): bigint | null {
  try {
    return parseUnits(value, decimals);
  } catch { return null; }
}
