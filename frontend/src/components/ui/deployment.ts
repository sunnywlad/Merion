// Chain constants for the UI layer.
//
// The chain IDs live in `src/constants/addresses.ts`, which also carries the
// deployed addresses per chain — that file is the single source of truth, and
// `isSupportedChain` there is the only test a write path should gate on.
//
// This module exists purely to keep human-facing copy out of the components:
// it derives labels from the address table so no screen re-hardcodes an ID.
import {
  CHAIN_NAMES,
  DEFAULT_CHAIN_ID,
  SUPPORTED_CHAIN_IDS,
} from '@/constants/addresses';

/** Chain assumed during SSR and for any wallet on an unsupported chain. */
export const FALLBACK_CHAIN_ID = DEFAULT_CHAIN_ID;

/** "Base Sepolia or Hardhat (local)" — used by the wrong-network state. */
export const SUPPORTED_CHAINS_LABEL = SUPPORTED_CHAIN_IDS.map(
  (id) => CHAIN_NAMES[id],
).join(' or ');
