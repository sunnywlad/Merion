# Documentation Merion v1

Documentation de référence du protocole Merion, arrêtée au 2026-08-30.
Cinq documents substantifs, un point d'entrée.

## Les cinq documents

- **[Logique des smart contracts.md](<Logique des smart contracts.md>)** — architecture générale des cinq contrats et raisons des choix de conception. Le POURQUOI.
- **[Détermination des constantes.md](<Détermination des constantes.md>)** — chiffres et barèmes livrés (`EPOCH_DURATION`, `PRIORITY_WINDOW`, `MIN_OPENING_BID`, etc.) avec leurs arguments et leurs sources dans le code.
- **[Principes de l'enchère.md](<Principes de l'enchère.md>)** — mécanique de l'enchère ouverte ascendante, cycle de mandat, opérations `placeBid` / `settle` / `withdrawRefund`. La mécanique seule.
- **[Roadmap.md](Roadmap.md)** — travail post-Phase 2, hors MVP et hors soutenance (2026-09-02). Chaque item porte sa raison de différé.
- **[Tests.md](Tests.md)** — état final des tests (492 verts, 303 TypeScript / 189 Solidity), stratégie deux couches, huit invariants Foundry.

## Sources

Contrats `Pool.sol`, `Auction.sol`, `MRN.sol`, `MrnFaucet.sol`, `MockWrappedBTC.sol` ;
modules Ignition `pool.ts` et `auction.ts` ; carnet de projet Merion (RS6515) pour
les arguments tokenomics et sécurité. Le code tranche, le carnet argumente.
