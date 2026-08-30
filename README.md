# Merion

DEX Bitcoin sans oracle sur Base, adossé à une enchère de mandat.

Merion échange trois wrappers de BTC à cibles égales, WBTC, cbBTC et LBTC, sur
une courbe à produit constant. Le pool ne lit jamais de prix externe : il price
par ses réserves. Ce que le protocole vend, c'est le flux de frais : toutes les
4 heures, le droit de fixer le tarif de swap du mandat suivant est vendu au plus
offrant, payé d'avance dans le token natif MRN. Les fournisseurs de liquidité
cèdent un flux de frais stochastique contre un paiement certain reçu ex ante.
30 % du produit de l'enchère sont brûlés, 70 % leur sont reversés sous forme de
loyer streamé sur le mandat.

Le mécanisme d'enchère est l'**am-AMM** (Adams & Moallemi, 2024, arXiv 2403.03367),
déjà livré en production par Bunni v2. Le différenciateur de Merion est le couple
LBTC + enchère : une enchère sur trois wrappers non-productifs n'aurait rien à
vendre. C'est la jambe productive qui crée l'objet économique.

Projet de certification **RS6515** (Alyra, développeur blockchain). Version 1,
déployée sur Base Sepolia, non auditée, non destinée à la production.

---

## Layout du dépôt

Monorepo à deux paquets npm indépendants, plus la documentation de référence.

| Dossier | Contenu |
|---|---|
| `backend/` | Contrats Solidity, suite de tests deux couches (Hardhat + Foundry), modules de déploiement Ignition, scripts d'attaque. |
| `frontend/` | dApp Next.js 16 / React 19 / wagmi 3, câblée sur Hardhat local (31337) et Base Sepolia (84532). |
| `docs/` | Documentation de référence v1 (architecture, constantes, mécanique d'enchère, tests, roadmap). Point d'entrée : `docs/README.md`. |
| `.github/workflows/` | CI : tests + couverture + non-régression de gaz au backend, `build` + `tsc` au frontend. |

---

## Les cinq contrats

Solidity `0.8.36`, `viaIR`, OpenZeppelin `^5.6.1`. Sources dans `backend/contracts/`.

| Contrat | Rôle |
|---|---|
| `Pool.sol` | AMM à produit constant sur trois actifs. Parts LP en ERC-20, frais modulables par epoch, bandes de composition, loyer LP streamé en MRN. Cœur du protocole. |
| `Auction.sol` | Enchère ascendante ouverte en MRN sur la nomination du gestionnaire du mandat suivant. Seul appelant de `setManager` et `notifyRent` une fois câblée. |
| `MRN.sol` | ERC-20 natif, 100 M frappés au constructeur, `ERC20Burnable`. **Aucune fonction de mint** post-déploiement. |
| `MockWrappedBTC.sol` | WBTC, cbBTC, LBTC pour le test et le testnet. 8 décimales, `ERC20Capped` à 21 M par instance. `mint` sans permission (mock seulement). |
| `MrnFaucet.sol` | Réservoir pré-financé de 10 M MRN, `drip()` à cadence limitée par adresse. Démo et jury, pas production. |

Couplage : l'Auction appelle le Pool (câblage `setAuction`, un seul coup) ; le
Pool tire le MRN du loyer en PULL sur l'approbation posée au constructeur de
l'Auction.

### Paramètres livrés

Source de vérité : `backend/ignition/modules/pool.ts` et `auction.ts`, puis les
contrats. Le carnet de projet argumente, le code tranche. Détail et
justifications dans `docs/Détermination des constantes.md`.

| Constante | Valeur | Note |
|---|---|---|
| `EPOCH_DURATION` | 14 400 s (4 h) | Durée du mandat. |
| `AUCTION_WINDOW` | 900 s (15 min) | Fenêtre d'enchère, au début de l'epoch. |
| `PRIORITY_WINDOW` | 240 s (4 min) | Fenêtre exclusive du manager élu pour poser sa surcharge via `setFee`. |
| `BID_SILENCE` | 60 s | Indice de cadencement pour le bot `settle`, pas une garde on-chain. |
| `MAX_EXTENSION` | 0 | Soft-close (A1) non livré en v1. |
| `NOMINAL_FEE_NUM` | 5 bp | Tarif de base, cas nominal (mandat sans acheteur). |
| `MIN_FEE_NUM` / `MAX_FEE_NUM` | 1 bp / 50 bp | Bornes ; cap effectif du manager = 25 bp (`MAX_FEE_NUM / UNBALANCE_FACTOR`). |
| `PROTOCOL_FEE_BPS` | 1 000 (10 %) | Part trésorerie, sur les deux régimes. |
| bandes de composition | `floor = 13`, `ceiling = 53` (`constant`) | Chaque réserve reste strictement entre 13 % et 53 % de la somme. |
| `MIN_OPENING_BID` | 10 MRN (10 × 10¹⁸) | Anti-clôture-à-vide, pas anti-spam. |
| `HIGH_BID_BPS` | 11 000 | Surenchère minimale +10 %. |
| `BURN_BPS` / `LP_BPS` | 3 000 / 7 000 | 30 % brûlés, 70 % au loyer LP (dont 0,1 % au caller de `settle`). |
| `MINIMUM_LIQUIDITY` | 1 000 parts | Anti-inflation du premier déposant, envoyées à `0x…dEaD`. |

---

## Déploiement Base Sepolia (chainId 84532)

Redéploiement du 2026-08-30. Adresses dans
`backend/ignition/deployments/chain-84532/deployed_addresses.json` et
`frontend/src/constants/addresses.ts`.

| Contrat | Adresse |
|---|---|
| Pool | `0xd281B06b09589C12b70F9a52fcFa1aC71B2E953B` |
| Auction | `0xa8BaF80093AA00EBB5416E10c908450124F8109f` |
| MRN | `0x28670e3EEb7801B053f4E9Ea808D45567698Ef03` |
| MrnFaucet | `0xd8C7aa392d43C045dCfd9E561111969495EACf31` |
| WBTC (mock, index 0) | `0x7A03f5560d04743194bBfD303D8345f8dAad4c72` |
| cbBTC (mock, index 1) | `0xA913a98e22b05d335b3DAa441CCDbb582F5af265` |
| LBTC (mock, index 2) | `0xdb87ACd86d4b06D637a206E1924818b1154420A3` |

---

## Démarrer

### Backend

```bash
cd backend
npm ci
npx hardhat test                 # suite complète (TypeScript + Solidity)
npx hardhat test solidity        # Foundry seul (fuzz + invariants)
npx hardhat test --coverage      # couverture
```

Déploiement local (nœud Hardhat) ou Base Sepolia via le module orchestrateur
`merion.ts`, qui impose l'ordre : trois mocks, MRN, faucet, Pool, Auction, puis
`pool.setAuction(auction)`.

```bash
npx hardhat ignition deploy ignition/modules/merion.ts --network baseSepolia
npx hardhat run scripts/seed-faucet.ts --network baseSepolia   # approvisionne le faucet
```

Variables attendues (voir `hardhat.config.ts`, résolues par `configVariable`) :
`BASE_SEPOLIA_RPC_URL`, `BASE_SEPOLIA_PRIVATE_KEY`, `ETHERSCAN_API_KEY`.

### Frontend

```bash
cd frontend
npm ci
cp .env.example .env.local       # renseigner NEXT_PUBLIC_PROJECT_ID (Reown)
npm run dev
```

Le front résout ses adresses dynamiquement à partir de la chaîne connectée
(31337 ou 84532) ; toute autre chaîne retombe sur Base Sepolia en lecture seule.

---

## Tests

Deux couches, deux questions. Détail dans `docs/Tests.md` et `backend/test/README.md`.

- **Solidity (`*.t.sol`, forge-std)** : la spécification. Une fonction isolée
  respecte-t-elle sa spec sur tout le domaine d'entrées ? Terrain du fuzz et des
  invariants.
- **TypeScript (`*.test.ts`, Hardhat + viem)** : le parcours. Le contrat se
  comporte-t-il correctement appelé exactement comme par le front, à travers
  l'ABI, avec de vrais comptes et de vrais transferts ?

| Métrique | Valeur |
|---|---|
| Tests verts | 492 (303 TypeScript, 189 Solidity) |
| Invariants Foundry | 8 (7 Pool, 1 Auction) |
| Couverture | 98,44 % Pool, 98,63 % Auction |
| Scripts d'attaque (`scripts/attack/`) | 16 fichiers, rejouent les failles d'audit F1-F8 contre un déploiement local |

CI (`.github/workflows/ci.yml`), à chaque push sur `master` et chaque PR :
`npm ci`, suite complète avec couverture et stats de gaz, contrôle strict de
non-régression du gaz (PR seulement), `next build` puis `tsc --noEmit` au
frontend.

---

## Documentation

`docs/` tient la documentation de référence v1, arrêtée au 2026-08-30.

- **`Logique des smart contracts.md`** — architecture des cinq contrats et
  raisons des choix. Le pourquoi.
- **`Détermination des constantes.md`** — chaque chiffre livré, son argument, sa
  source dans le code.
- **`Principes de l'enchère.md`** — cycle de mandat, `placeBid` / `settle` /
  `withdrawRefund`, gardes F1/F2/F3.
- **`Tests.md`** — stratégie deux couches, huit invariants, compteurs.
- **`Roadmap.md`** — travail post-soutenance, hors MVP. Chaque item porte sa
  raison de différé : StableSwap Newton, fee asymptotique, paiement du loyer en
  BTC, hook Uniswap v4, enchère Vickrey commit-reveal, corridor de bandes,
  gouvernance en trois étapes.

---

## Licence

MIT (`SPDX-License-Identifier: MIT` sur chaque contrat).
