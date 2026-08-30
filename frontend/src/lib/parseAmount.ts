import { parseUnits } from "viem";

// Parse une saisie decimale en bigint (8 decimales par defaut). Rend null si la chaine est invalide.
export function parseAmount(value: string, decimals=8): bigint | null {
  try {
    return parseUnits(value, decimals);
  } catch { return null; }
}
