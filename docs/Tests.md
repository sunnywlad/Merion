# Tests Merion — état final

## Stratégie

Deux couches, deux questions distinctes :

- **Solidity (`*.t.sol`, forge-std)** : la SPECIFICATION. Une fonction isolée respecte-t-elle sa spec pour toute entrée ? Terrain naturel du fuzz et des invariants.
- **TypeScript (`*.test.ts`, Hardhat + viem)** : le PARCOURS. Le contrat se comporte-t-il correctement quand on l'appelle *exactement comme le front*, à travers l'ABI générée, avec de vrais comptes et de vrais transferts ?

Un test Solidity peut appeler `addLiquidity` depuis le contrat de test (lui-même `msg.sender` et token holder). Un test TypeScript reproduit le parcours réel : un compte possède les tokens, les approuve, envoie la transaction. Sur `addLiquidity`, c'est de l'orchestration multi-contrats (trois ERC-20, trois `approve`, trois `transferFrom`). Sur `currentEpoch` ou `feeInForce`, c'est une lecture par `eth_call` à travers l'ABI.

La règle : TypeScript pour le parcours, Solidity pour la formule et l'état forgeable. Un fichier TypeScript qui prétendrait prouver la formule ne prouverait rien (il réimplémenterait le code qu'il teste). Un fichier Solidity qui prétendrait prouver le parcours multi-comptes ne prouverait rien non plus (le contrat de test serait à la fois appelant, porteur et déclencheur).

Fichier détaillé : backend/README.md

## Compteurs

| Métrique | Valeur |
|---|---|
| Tests verts | **492** |
| TypeScript | **303** |
| Solidity | **189** |
| Invariants Foundry | **8** (7 Pool dont 2 gardes de vacuité + 1 Auction) |
| Tests skipped (volontaires) | 3 |
| Scripts d'attaque (`scripts/attack/`) | 16 fichiers (15 scripts + `_harness.ts`) ; 9 fichiers armés, 24 appels `expectRevert(...)` hors `_harness.ts` : `attack_bands.ts` (4), `attack_owner_power.ts` (3), `attack_pause_asymmetric.ts` (3), `attack_safe_erc20.ts` (4), `attack_auction_snipe.ts` (2), `attack_bad_slippage_frontrun.ts` (2), `attack_ceil_div.ts` (2), `attack_owner_squat.ts` (2), `attack_zero_output.ts` (2). 6 scripts d'observation sans `expectRevert` : `attack_rent_burn.ts`, `attack_swap_same_token.ts`, `attack_first_depositor.ts`, `attack_donation.ts`, `attack_insufficient_reserve.ts`, `attack_auction_brick.ts`. |

Les 3 skipped : `FEE_DEN` migration dans `Pool.feeSplit.t.sol` (constante non modifiable sans toucher `Pool.sol`, hors périmètre I.2) ; `BID_SILENCE` dans `Auction.test.ts` (`bidSilence` n'est pas une garde on-chain, l'AUDIT F3 l'a explicité comme consigne d'ordonnancement pour le bot, et `BID_SILENCE == 0` est la valeur livrée à I.3, gate A4 roadmap).

Les scripts d'attaque rejouent les failles d'audit contre un nœud local, sur des contrats déployés par Ignition. Ils interrogent un DEPLOIEMENT, pas une spécification : ils ne comptent dans aucun des deux totaux ci-dessus, et c'est voulu.

## Couverture par couche

### Foundry (Solidity, 189 tests + 8 invariants)

```
test/Pool.addLiquidity.t.sol      fuzz des deux branches (pool vide, pool amorce)
test/Pool.removeLiquidity.t.sol   fuzz du pool vierge et du pool amorce
test/Pool.swap.t.sol              fuzz, domaine partagé par MAX_IN_BAND_AMOUNT
test/Pool.safeERC20.t.sol         les 4 sites SafeERC20 qui portent le panier
test/Pool.forgedState.t.sol       propriétés atteintes par forge d'état (vm.store)
test/Pool.feeInForce.t.sol        packing du slot + lecture paresseuse, par vm.store
test/Pool.setFee.t.sol            fuzz des cinq axes de setFee (bande, appelant, instant, epoch)
test/Pool.depeg.t.sol             les bandes face à une décote réelle d'un wrapper
test/Pool.invariant.t.sol         handler (dont chemin gestionnaire) + 7 invariants + garde de vacuité afterInvariant + 2 tests ciblés unitaires (test_managerPathIsActiveAndConserves, test_InsufficientReserveReachedViaForgedState)
test/Pool.feeSplit.t.sol          bornes croisées + invariant I1 de conservation des frais (I.2)
test/Pool.rent.t.sol              formule de l'accumulateur + ordre de _update (I.4)
test/Pool.security.t.sol          non-régression audit F5/F6/F7/F8 (vm.warp, vm.store, pool hors panier)
test/Auction.security.t.sol       non-régression audit F1/F2/F3 (vm.warp à la seconde et sur deux epochs)
test/Auction.invariant.t.sol      handler placeBid/settle/withdrawRefund/warp + invariant I4 + six tests cibles
contracts/Auction.t.sol           Auction, couche Solidity I.3 (4 contrats de test)
contracts/Pool.t.sol              decimals()
contracts/Pool.gas.t.sol          mesures de gaz (rapport dans GAS.md)
contracts/MockWrappedBTC.t.sol    le mock ERC20Capped du panier
contracts/MRN.t.sol               le jeton natif MRN
contracts/MrnFaucet.t.sol         unit MrnFaucet (constructor, drip, intervalle, events)
```

### Hardhat (TypeScript, 303 tests)

```
test/Pool.constructor.test.ts     déploiement : 8 args, gardes de frais/horloge, cas limites
test/Pool.currentEpoch.test.ts    horloge d'enchère, frontières à la seconde
test/Pool.feeInForce.test.ts      vue lecture pure (ce que TypeScript PEUT dire)
test/Pool.addLiquidity.test.ts    addLiquidity, pool vide + amorcé + déséquilibré
test/Pool.removeLiquidity.test.ts removeLiquidity, conservation aller-retour
test/Pool.swap.test.ts            swap, 6 paires, bandes plancher/plafond
test/Pool.pause.test.ts           pause/unpause, effet sur les 3 entrées + setFee
test/Pool.manager.test.ts         manager/setAuction/setManager, voie bootstrap vs nominal
test/Pool.setFee.test.ts          setFee, 4 gardes, fenêtre de priorité à la seconde
test/Pool.feeSplit.test.ts        surface I.2 (effectiveFeeNum, get_dy, partage, tirage)
test/Pool.rent.test.ts            parcours réel de la rente LP (I.4)
test/Pool.reentrancy.test.ts      AUDIT F4, non-régression re-entrance addLiquidity
test/Pool.audit.test.ts           autres chemins d'audit résiduels
test/Auction.test.ts              Auction côté parcours : placeBid, refunds, settle, withdrawRefund, vues
```

Couverture actuelle : 98,44 % (Pool) / 98,63 % (Auction), vérifiée à chaque push par `npx hardhat test --coverage`.

## Catégories de tests

| Catégorie | Couche | Question posée |
|---|---|---|
| Unit | Solidity | Une fonction respecte-t-elle sa spec isolément ? |
| Integration | TypeScript | Le contrat se comporte-t-il comme attendu à travers l'ABI, avec de vrais comptes ? |
| Fuzz | Solidity (forge-std) | La spec tient-elle sur un domaine d'entrées ? |
| Invariant | Solidity (forge-std) | Une propriété d'état tient-elle à travers toute séquence d'appels ? |
| Audit (non-régression) | Les deux | F1-F8 (audit externe) ne réapparaissent-ils pas ? |
| E2E (attack scripts) | Hardhat + Ignition | La faille tient-elle contre un vrai déploiement ? |

Les **8 invariants** Foundry (par appel, après chaque séquence du handler) :

| # | Fichier | Invariant |
|---|---|---|
| 1 | `Pool.invariant.t.sol` | `reservesNeverExceedBalances` — le solde ERC-20 couvre la réserve |
| 2 | `Pool.invariant.t.sol` | `reservesTrackBalancesExactly` — forme forte : `reserves + protocolFeesOwed + feesOwed[m][i] == balanceOf(pool, i)` |
| 3 | `Pool.invariant.t.sol` | `shareValueNeverDecreases` — la valeur unitaire des parts ne baisse jamais |
| 4 | `Pool.invariant.t.sol` | `addLiquidityDeliversAllThreeLegs` — chaque réserve grossit d'au moins une unité (Math.ceilDiv) |
| 5 | `Pool.invariant.t.sol` | `bandsAlwaysRespected` — chaque ratio reste strictement entre 13 % et 53 % |
| 6 | `Pool.invariant.t.sol` | `campaignDidSomething` — garde de vacuité, par appel (100 appels → pool amorcé) |
| 7 | `Pool.invariant.t.sol` | `managerPathWasExercised` — garde de vacuité, par chemin (au moins un swap sous manager) |
| 8 | `Auction.invariant.t.sol` | `mrnCoversObligations` — le MRN détenu par l'Auction couvre en permanence `Σ refunds + pendingAmount + highBid + deadMrn` (`deadMrn` = MRN figé par double reset de `pendingAmount`, correctif F1 non appliqué) |

Invariants 6 et 7 n'affirment rien du contrat : ils affirment que la campagne a exercé ce qu'elle prétend exercer. Un invariant de couverture qui passe sur une campagne vide est un faux vert.

## CI

`.github/workflows/ci.yml` — gates à chaque push sur `master` et chaque PR :

**Backend** :
1. `npm ci`
2. `npx hardhat test --coverage --gas-stats --gas-stats-json gas-stats.json` (suite complète TS + Solidity, couverture, statistiques de gaz)
3. Contrôle de non-régression du gaz — **PR uniquement** (l'égalité est stricte, l'imposer à chaque push forcerait à rafraîchir la référence en cours de développement) : `npx hardhat test solidity contracts/Pool.gas.t.sol --snapshot-check --build-profile production`
4. Publication du rapport de gaz dans le résumé du run (si le JSON existe)

**Frontend** :
1. `npm ci`
2. `npm run build` (avec `NEXT_PUBLIC_PROJECT_ID` depuis les variables de dépôt)
3. `npx tsc --noEmit`

Le profil de build doit être le même qu'à la génération du snapshot, sinon les chiffres ne veulent rien dire (voir `backend/GAS.md`).

## Périmètre et règles de duplication

Cette suite couvre `Pool.sol` et `Auction.sol` uniquement. Les dépendances OpenZeppelin (`ERC20`, `Ownable`, `Pausable`, `SafeERC20`, `Math`) sont hors périmètre : on suppose leur comportement correct, on ne teste que ce que `Pool.sol` fait avec elles. L'exception assumée est `SafeERC20`, dont la promesse elle-même est vérifiée sur les quatre sites d'appel qui portent les jetons du panier.

Le panier est figé à trois wrappers de BTC à cibles EGALES, un tiers chacun : WBTC en indice 0, cbBTC en indice 1, LBTC en indice 2. Il n'y a plus ni quatrième jeton ni poids cibles différenciés.

Les fixtures (`deployTokensAndPool`, `mintAndApprove`, `readReserves`, `deploySeededPoolFixture`, `deployImbalancedPoolFixture`...) sont **dupliquées** entre les fichiers TypeScript plutôt qu'importées d'un module partagé. C'est délibéré : chaque fichier ouvre sa propre connexion réseau via son propre `network.create()`, et un module partagé devrait soit se lier à une connexion arbitraire, soit reconstruire à chaque import. Dans les deux cas, un fichier qui échoue peut casser l'autre sans lien logique.

## Hors périmètre (atomicité EVM)

L'atomicité de la transaction `removeLiquidity` quand le `_burn` échoue après que la boucle de décrément des réserves a déjà tourné est **hors** périmètre des deux couches. C'est l'EVM qui efface l'état modifié en cas de revert, pas une garde de `Pool.sol`. Répondre à cette question vérifierait l'EVM, pas le contrat.