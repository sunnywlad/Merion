# Revue de l'application des deux plans

Revue **en lecture seule** (aucune modification du code).
Branche vérifiée : `front/designAndErrors`.
Date : 30 août 2026.

But : vérifier que le code de `frontend/src` applique bien les deux plans
`plan-appels-rpc.md` et `plan-perf-frontend.md`.

---

## Méthode

Lecture directe des fichiers cibles + grep d'audit (intervalles de poll,
`staleTime`, `useMemo`/`useCallback`, providers, code mort). Aucun `build`/
`measure` lancé (ceux-ci modifient `.next` / nécessitent un runtime ; la revue
est statique). Les charnières runtime (Étape 0 du plan RPC, Étape 0 du plan
perf) ne sont pas vérifiables par inspection de code — voir §« Non vérifiable ».

---

## Plan 1 — `plan-appels-rpc.md`

| Étape | Attendu (plan) | État dans le code | Preuve | Statut |
|---|---|---|---|---|
| 0 | Mesurer la référence (runtime) | — | Process, pas du code | ⚪ Non vérifiable (statique) |
| 1 | `pollingInterval` per-chain `{baseSepolia:12_000, hardhat:4_000}` dans la config wagmi | Appliqué (forme per-chain recommandée 3a) | `config/index.ts:40` | ✅ |
| 2 | `useFeeRouting` : multicall 3 entrées, epoch via `useAuctionState`, `scopeKey` sur epoch, `staleTime:Infinity`, `enabled: epoch!==undefined`, suppression `FEE_ROUTING_POLL_MS` | Appliqué | `hooks/useFeeRouting.ts:43-59` ; `FEE_ROUTING_POLL_MS` absent de `_constants.ts` | ✅ |
| 3 | `AUCTION_POLL_MS` (15s, inchangé) + `MANDATE_POLL_MS` (60s) ; les 4 hooks mandat basculent à 60s ; `usePoolPaused` littéral `15000` → constante | Appliqué | `hooks/_constants.ts:14-15` ; `useManagerOf.ts:28`, `useRefund.ts:18`, `useClaimableRent.ts:36`, `usePoolPaused.ts:23` ; `useAuctionState.ts:38` reste 15s | ✅ |
| 4 | `staleTime` au focus sur `useReserves`/`useUserBalances`/`useLpBalance`/`useEffectiveFees` | Appliqué (`staleTime:5_000` sur les 4) | `useReserves.ts:24`, `useUserBalances.ts:59`, `useLpBalance.ts:17`, `useEffectiveFees.ts:37` | ✅ |
| 5 | `chainNow` source unique (provider singleton `useSyncExternalStore`/contexte) | Appliqué via contexte React (provider monté dans `(app)/layout`) | `hooks/useChainNow.tsx` (`ChainNowProvider`, `useChainNowSource` unique) ; `app/(app)/layout.tsx` monte `<ChainNowProvider>` | ✅ |

**Corrections du §0 du doc source — reflétées dans le code :**
- §0.3 littéral `15000` non dérivé → corrigé (`usePoolPaused` utilise `MANDATE_POLL_MS`). ✅

---

## Plan 2 — `plan-perf-frontend.md`

| Étape | Attendu (plan) | État dans le code | Preuve | Statut |
|---|---|---|---|---|
| 0 | Profiler React (runtime) | — | Process | ⚪ Non vérifiable (statique) |
| A | `Disclosure` : enfants montés seulement à l'ouverture `{open ? children : null}` | Appliqué (repli CSS conservé) | `components/ui/Disclosure.tsx:107` | ✅ |
| B | Horloge chaîne singleton (recouvre RPC Étape 5) | Appliqué — **même travail que RPC Étape 5**, non dupliqué | `hooks/useChainNow.tsx` (provider) | ✅ |
| C | Landing hors `Providers` + `Navbar` server/coque + feuille client `appkit-button` | Appliqué : root `layout.tsx` sans web3 ; `(app)/layout.tsx` monte `Providers`+`Navbar` ; groupe `(marketing)` ; `Navbar.tsx` server + `NavbarClient.tsx`/`AppkitButton.tsx` client | `app/layout.tsx`, `app/(app)/layout.tsx`, `app/(marketing)/`, `components/Navbar.tsx` | ✅ |
| D | `QueryClient` en `useState` + `staleTime` global `5_000` | Appliqué | `app/providers.tsx:14-16` | ✅ |
| E | `useMemo` sur `useReserves` (tuple), `useFeeRouting` (`routing`), `useEffectiveFees` (fermetures `feeFor`/`errorFor` via `useCallback`), `useUserBalances` (`btcBalances`) ; `Swap` `useMemo` `getQuote`/`reservesAfter`/`breachedBand` ; `NAME_OF` module-level | Appliqué (4 hooks + `Swap` + `NAME_OF`) | `useReserves.ts:35`, `useFeeRouting.ts:79`, `useEffectiveFees.ts:47/59`, `useUserBalances.ts:66`, `Swap.tsx:197/294/308`, `Swap.tsx:50` `NAME_OF: Record<number,string>` | ✅ |
| F | Supprimer code mort (`useNow.ts`, `Table.tsx`, `Chip.tsx`, `ReadErrors.tsx`, `Connection.tsx`, `lib/mandateWindow.ts`, `useAddresses.ts`) | Appliqué — 7 fichiers supprimés, aucun import résiduel (restent des commentaires historiques uniquement) | `ls` + grep : tous `gone` ; pas d'import live | ✅ |
| G | `invalidateQueries()` ciblé dans `AuctionPanel` (clés précises / `refetch`) | Appliqué | `components/AuctionPanel.tsx:206, 249-251, 281-282` (`queryKey` + `refetch` ciblés) | ✅ |
| H | Déclarer Multicall3 sur Hardhat (adresse canonique) | Appliqué (+ complément `deployless` sur 31337) | `config/index.ts:19-26` + `hooks/useMerionReadContracts.ts` (deployless) | ✅ |
| I | Peinture : `transform:translateX()` curseur, `transition-[width,background-color]` ReservesBar, `Button.tsx` sans `'use client'`, `Swap` memo du panneau Decomposition | Appliqué | `globals.css:237-240`, `ReservesBar.tsx:66`, `Button.tsx:1-2` (pas de directive), `Swap.tsx:191-308` | ✅ |

---

## Observations (hors périmètre direct des plans, mais notables)

1. **Abstraction `useMerionReadContracts` (nouvelle, non listée dans les plans).**
   Wrapper de `useReadContracts` wagmi qui (a) ajoute `deployless:true` sur Hardhat
   (31337) et (b) expose `queryKey` — ce dernier est ce qui rend l'Étape G
   (invalidation ciblée) possible. Changement de support cohérent, à documenter.
2. **`deployless` Hardhat en plus de l'adresse Multicall3 (Étape H).** Le commit
   `655ccdf front: multicall deployless sur Hardhat` ajoute une seconde parade pour
   31337. Les deux approches coexistent ; aucune contradiction.
3. **`MrnGrant.tsx:61` garde `refetchInterval: 30000`.** Hors périmètre des deux
   plans (le budget RPC mentionnait `lastDripAt` mais n'avait pas d'étape de
   modification). Reste tel quel — non bloquant, signalé pour info.
4. **Renommage `useAddresses` → `useDeployedChainId`** (Perf F final). Le plan RPC
   Étape 2 écrivait `useAddresses` ; le code utilise `useDeployedChainId`. C'est la
   conséquence de la suppression de `useAddresses` (Perf F), donc cohérent entre les
   deux plans.
5. **`useChainNow.ts` → `useChainNow.tsx`** (extension changée, contenu = plan).
6. Étape 0 (mesure RPC) et Étape 0 (profiler) des deux plans : **non jouées ici**.
   Elles sont des étapes de validation runtime. Leur critère de succès
   (`eth_blockNumber` ~5/min, compte à rebours fluide, `/` allégée) n'est pas
   confirmable par inspection statique — à rejouer avec `measure-rpc.js` + React
   Profiler pour clore la preuve de gain.

---

## Conclusion

- **Plan RPC : 6/6 étapes de code appliquées** (Étape 0 = mesure runtime, non
  vérifiable statiquement). Les 4 « écarts » du §0 du doc source sont bien reflétés
  (notamment le littéral `15000` corrigé).
- **Plan perf : 10/10 étapes appliquées** (Étapes 0 profiler = runtime). Aucune
  étape manquante, aucune divergence de comportement vs plan. Le recouvrement
  `RPC Étape 5 = Perf B` n'a pas été dupliqué (une seule implémentation).
- **Aucune modification visible en dehors des plans** si ce n'est le support
  `useMerionReadContracts` (nécessaire à l'Étape G) et le `deployless` Hardhat
  (complément de l'Étape H) — tous deux cohérents.
- **Reste à faire pour clore la preuve** : rejouer les mesures runtime (Étapes 0 des
  deux plans) afin de confirmer les gains chiffrés (−84 % RPC, −127 KB `/`, 5→1
  commit/s).
