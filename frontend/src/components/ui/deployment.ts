// Local deployment constants — single source of truth for the chain the
// pool is deployed on. Six files used to hard-code `31337`; `frontend/src/
// constants/` is out of perimeter, so the value lives here, alongside the
// UI primitives that consume it.

export const EXPECTED_CHAIN_ID = 84532;
export const EXPECTED_CHAIN_NAME = 'Base Sepolia';
