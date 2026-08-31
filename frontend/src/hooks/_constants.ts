// R3/B.4 — Constantes partagées par plusieurs hooks applicatifs.
//
// `AUCTION_POLL_MS` est consommé par plusieurs hooks (dont
// `useManagerOf`, `useRefund`, `useRentPosition`). Le préfixe `_` suit
// la convention `_mandateStatus.ts` (interne au sous-dossier, non
// importé depuis l'extérieur).
//
// `ZERO_ADDRESS` est centralisé ici pour qu'une éventuelle évolution
// (par ex. validation runtime) n'ait qu'un point d'entrée.

export const AUCTION_POLL_MS = 15_000;    // état vivant de l'enchère
export const MANDATE_POLL_MS = 60_000;    // ce qui bouge à l'échelle du mandat (4 h) — distinct de l'état vivant d'enchère (15 s)

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
