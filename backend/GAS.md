# Coût en gaz — banc de mesure et historique

## À quoi sert ce banc

`contracts/Pool.gas.t.sol` **n'est pas une suite de tests.** La correction du
contrat est vérifiée ailleurs. Ce fichier répond à une autre question :
*combien coûte chaque fonction, et ce coût a-t-il bougé depuis la dernière
fois ?* Une suite verte ne dit rien d'un remaniement qui ajoute 30 000 de gaz à
`addLiquidity` : le comportement est identique, seul l'utilisateur paie.

## Principe de mesure

**Un chiffre = un appel.** Toute la mise en situation vit dans `setUp()`, que
l'instantané exclut ; le corps de chaque fonction de test ne contient que
l'appel mesuré. D'où les trois contrats du fichier, un état de pool par
contrat, plutôt qu'un amorçage en tête de test qui gonflerait le relevé.

L'assertion porte sur la **valeur de retour**, déjà en mémoire : coût
négligeable et constant. Aucune lecture externe dans un corps mesuré, un
`totalSupply()` ajouterait ~2 500 de gaz à chaque chiffre.

## Commandes

Le profil `production` (optimiseur, 200 runs) est celui qui sera déployé.
**Toutes les commandes du banc le passent explicitement** ; un relevé pris sur
un autre profil n'est comparable à rien dans ce document.

```bash
# Rafraîchir la référence — à chaque jalon, volontairement
npx hardhat test solidity contracts/Pool.gas.t.sol --snapshot --build-profile production

# Vérifier qu'aucun coût n'a bougé — exécuté en CI sur les PR
npx hardhat test solidity contracts/Pool.gas.t.sol --snapshot-check --build-profile production
```

`.gas-snapshot` est **versionné**, c'est la référence. `gas-stats.json` est un
produit d'exécution jetable, ignoré par git.

### Règle d'or

Les montants du banc (`SEED`, `DEPOSIT`, `SWAP_IN`) **ne se modifient jamais.**
Les changer ne casse aucun test, mais rend toutes les mesures antérieures
incomparables, et cette rupture est silencieuse. **Ajouter** un scénario est
sans danger.

### Comportement de `--snapshot-check`, vérifié

| Situation | Résultat |
|---|---|
| Aucun changement | `Snapshot check passed` |
| Une valeur dévie | Échec : `Expected 24000 / Actual 24289 (+1.20%, Δ+289)` |
| Nouveau scénario sans référence | Passe, l'entrée neuve est ignorée |

Égalité **stricte**, aucune option de tolérance. Toute modification de contrat
cassera le contrôle, et la référence doit être rafraîchie **consciemment**,
dans le même commit, en disant dans le message que le coût a changé et
pourquoi.

## Limites connues

- **`--gas-stats` ne produit aucune sortie combiné à `--build-profile
  production`.** Le tableau détaillé par fonction et la taille du bytecode ne
  sont donc lisibles que sur le profil `default`, non optimisé. Non résolu.
- **Ne jamais comparer un chiffre issu des tests Solidity avec un chiffre issu
  des tests TypeScript.** Sur le profil `default`, les deux couches annoncent
  des tailles et des coûts de déploiement différents pour le même contrat
  (10 160 octets / 2 391 505 côté Solidity, 12 795 / 2 971 950 côté
  TypeScript). Écart non expliqué à ce jour.

---

## Jalon 1 — 2026-08-12 — cœur à produit constant

Base `11d2c38`. Solidity 0.8.36, profil `production` (optimiseur, 200 runs).
Périmètre : `Pool.sol` à invariant produit constant, avant StableSwap, avant
les gardes de sécurité.

| Scénario | Gaz |
|---|---|
| `addLiquidity` — pool vide | 218 562 |
| `addLiquidity` — pool amorcé | 96 514 |
| `addLiquidity` — pool déséquilibré | 96 536 |
| `removeLiquidity` — partiel | 81 261 |
| `removeLiquidity` — total | 76 527 |
| `swap` — pool équilibré | 55 679 |
| `swap` — pool déséquilibré | 55 657 |
| `setFee` | 19 163 |

### Lectures

- **Le premier dépôt coûte 2,3 fois un dépôt courant** (218 562 contre
  96 514). Il fait passer trois emplacements de réserve de zéro à non nul :
  20 000 par écriture au tarif plein, contre 5 000 ensuite. Ce surcoût est payé
  une seule fois dans la vie du pool, par le premier fournisseur de liquidité.
- **Le déséquilibre du pool ne coûte rien**, ±22 de gaz sur `addLiquidity`
  comme sur `swap`. Attendu, et vérifié plutôt que supposé : le gaz dépend des
  opérations effectuées, pas des valeurs manipulées, et les emplacements de
  stockage sont déjà non nuls dans les deux états.
- **Le retrait total est moins cher que le retrait partiel** (76 527 contre
  81 261), ce qui surprend jusqu'à ce qu'on regarde `_burn` : brûler la
  totalité d'un solde le ramène à zéro, ce qui déclenche un remboursement de
  remise à zéro de l'emplacement. Les réserves du pool, elles, ne tombent
  jamais à zéro, retenues par les parts brûlées vers l'adresse morte.
- `swap` est la fonction la moins chère du contrat, 55 679, contre 96 514 pour
  un dépôt : elle écrit deux réserves quand `addLiquidity` en écrit trois et
  mint en plus des parts.

---

## Jalon 2 — 2026-08-15 — gardes `ZeroOutput` et `InsufficientReserve`

Branche `test/swap`. Même périmètre et même profil qu'au jalon 1, à trois
`require` près : `amountOut > 0` et `cachedReserves[_indexOut] > amountOut`
dans `swap`, `mintedShares > 0` dans la branche `supply != 0` d'`addLiquidity`.
Référence rafraîchie dans le commit qui pose les gardes.

| Scénario | Gaz | Δ jalon 1 |
|---|---|---|
| `addLiquidity` — pool vide | 218 562 | — |
| `addLiquidity` — pool amorcé | 96 536 | +22 |
| `addLiquidity` — pool déséquilibré | 96 558 | +22 |
| `removeLiquidity` — partiel | 81 261 | — |
| `removeLiquidity` — total | 76 527 | — |
| `swap` — pool équilibré | 55 782 | +103 |
| `swap` — pool déséquilibré | 55 760 | +103 |
| `setFee` | 19 163 | — |

### Lectures

- **Le prix des deux gardes de `swap` est de 103 de gaz**, soit 0,18 % du coût
  de la fonction. Les deux comparaisons portent sur des valeurs déjà en
  mémoire (`amountOut` est une variable locale, `cachedReserves` a été copiée
  au premier `SLOAD`) : aucune lecture de stockage supplémentaire, seulement
  de l'arithmétique et deux sauts. C'est le chiffre à donner si le jury
  demande ce que coûte de garder le contrat plutôt que le front.
- **`addLiquidity` ne paie que 22 de gaz** pour sa garde, et **le dépôt sur
  pool vide n'en paie aucun** : `require(mintedShares > 0)` vit dans la
  branche `supply != 0`, que le premier dépôt ne traverse jamais. Le relevé
  confirme le placement, il ne le suppose pas.
- **`removeLiquidity` et `setFee` sont au gaz près identiques au jalon 1**,
  comme attendu : aucune des trois gardes ne les touche. Une dérive sur ces
  lignes aurait signalé un effet de bord, par exemple un décalage
  d'emplacements de stockage.
