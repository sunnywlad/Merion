// Constantes de chaine pour la couche UI.
//
// Les chain IDs vivent dans `src/constants/addresses.ts`, qui porte aussi les adresses deployees
// par chaine : ce fichier est la source de verite unique, et `isSupportedChain` y est le seul
// test qu'une ecriture doit garder.
//
// Ce module ne sert qu'a sortir le texte affichable des composants : il derive les libelles de
// la table d'adresses pour qu'aucun ecran ne recode un ID en dur.
import {
  CHAIN_NAMES,
  DEFAULT_CHAIN_ID,
  SUPPORTED_CHAIN_IDS,
} from '@/constants/addresses';

/** Chaine supposee pendant le SSR et pour tout wallet sur une chaine non supportee. */
export const FALLBACK_CHAIN_ID = DEFAULT_CHAIN_ID;

/** « Base Sepolia or Hardhat (local) » — utilise par l'etat mauvais-reseau. */
export const SUPPORTED_CHAINS_LABEL = SUPPORTED_CHAIN_IDS.map(
  (id) => CHAIN_NAMES[id],
).join(' or ');
