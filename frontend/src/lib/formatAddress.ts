// R3/C.2 — Helper `short(address)`, extrait de `MandatePanel.tsx`.
//
// Avant : helper local à un composant, susceptible d'être ré-implémenté
// par le prochain panneau qui affiche une adresse (tooltip manager,
// frise d'enchère, etc.). Centralisé ici à côté de `parseAmount.ts`
// (autre helper de formatage).
//
// L'ellipse est un caractère U+2026 (single-character ellipsis), pas
// trois points, conformément à la note §4 du brand book.

export const short = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
