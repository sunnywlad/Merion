// R3/C.2 — Helper `short(address)`. Centralisé à côté de `parseAmount.ts`
// (autre helper de formatage).
//
// L'ellipse est un caractère U+2026 (single-character ellipsis), pas
// trois points.

export const short = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
