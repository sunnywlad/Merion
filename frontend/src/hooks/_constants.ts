// R3/B.4 — Constantes partagées par plusieurs hooks applicatifs.
//
// Avant : `AUCTION_POLL_MS` était exporté de `useAuctionState.ts` et
// importé par 3 autres hooks (`useManagerOf`, `useRefund`,
// `useRentPosition`). C'est un anti-pattern : un hook applicatif
// servait de module de constantes et masquait la nature constante
// du scalaire. Le préfixe `_` suit la convention `_mandateStatus.ts`
// (interne au sous-dossier, non importé depuis l'extérieur).
//
// `ZERO_ADDRESS` était redéclaré dans `AuctionPanel` et `MandatePanel`
// comme littéral local. Centralisé ici pour qu'une éventuelle
// évolution (par ex. validation runtime) n'ait qu'un point d'entrée.

export const AUCTION_POLL_MS = 15_000;

// Le routage des frais (`feeNum`, `lastSetFeeEpoch`, mandat courant) ne bouge
// qu'aux frontières de mandat, soit toutes les 4 h. Le rafraîchir à la minute
// est déjà 240 fois plus fréquent que le changement sous-jacent ; le caler sur
// `AUCTION_POLL_MS` serait quatre fois le trafic RPC pour rien.
export const FEE_ROUTING_POLL_MS = 60_000;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
