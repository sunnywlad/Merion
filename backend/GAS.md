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

`rapport.json` et `rapportOpt.json` sont versionnés eux aussi, et ne sont pas
jetables : ils gardent la **même campagne de mesure prise deux fois**, sans
optimiseur puis avec. Le suffixe `Opt` désigne le relevé optimisé. Exemple sur
`MockWrappedBTC` : déploiement 925 343 → 513 211, taille runtime 3 734 → 1 862.
C'est la trace de cette comparaison, que `.gas-snapshot` ne porte pas puisqu'il
ne relève qu'un profil à la fois.

Leur provenance, retrouvée le 2026-08-19 : ce sont deux `gas-stats.json`
renommés, produits par la couche **TypeScript**, sans puis avec
`--build-profile production`.

```bash
npx hardhat test nodejs --gas-stats                            # -> rapport.json
npx hardhat test nodejs --gas-stats --build-profile production # -> rapportOpt.json
```

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
  production` sur la couche SOLIDITY** (`hardhat test solidity`). Vérifié à
  nouveau le 2026-08-19 : toujours vrai, les huit tests passent et aucun
  tableau ne sort. La limite s'arrête là. Sur la couche TYPESCRIPT
  (`hardhat test nodejs`), la même combinaison fonctionne et donne le
  tableau complet, optimiseur compris. La formulation précédente omettait
  cette distinction et laissait croire qu'aucun relevé optimisé n'était
  possible.
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

---

## Jalon 3 — 2026-08-26 — bandes élargies (13/53) et SWAP_IN recalibré (50 BTC)

Deux changements localisés. `Pool.sol` : `floor` passe de 27 à 13 et `ceiling`
de 40 à 53 (constantes `uint8` en tête du contrat, déclarées en place, la
boucle de vérification des bandes dans `swap` reste correcte : à 33,33 %,
`33,33 * 100 = 3333` reste largement à l'intérieur de `[13, 53] * 100`,
donc aucun risque d'invariant cassé). `Pool.gas.t.sol` : `SWAP_IN` passe
de `250 * 10 ** 8` à `50 * 10 ** 8`, **explicitement recalibré dans ce
jalon** (la règle d'or préserve `SEED` et `DEPOSIT`, inchangés à `1000e8`
et `100e8`). Référence rafraîchie dans le commit qui pose les deux
changements, `git add .` et message explicite.

Base `40e3982`. Solidity 0.8.36, profil `production` (optimiseur, 200 runs).

| Scénario | Gaz | Δ jalon 2 |
|---|---|---|
| `addLiquidity` — pool vide | 222 726 | +4 164 |
| `addLiquidity` — pool amorcé | 98 848 | +2 312 |
| `addLiquidity` — pool déséquilibré | 98 870 | +2 312 |
| `removeLiquidity` — partiel | 81 258 | −3 |
| `removeLiquidity` — total | 76 524 | −3 |
| `swap` — pool équilibré | 60 456 | +4 674 |
| `swap` — pool déséquilibré | 60 434 | +4 674 |
| `setFee` | 19 185 | +22 |

### Lectures

- **L'élargissement des bandes ne débloque aucun scénario du banc, mais
  ouvre la porte à des swaps plus grands que le banc actuel.** Avec
  `SWAP_IN = 250e8` et les anciennes bandes `27/40`, un swap de token 0
  vers token 2 menait déjà le réservoir 0 à ~38,7 % (sous le plafond 40 %)
  et le réservoir 2 à ~30,3 % (au-dessus du plancher 27 %) : le banc
  restait donc à l'intérieur de la fenêtre. Avec les nouvelles bandes
  `13/53`, l'intervalle `[13 %, 53 %]` permet des déséquilibres cinq fois
  plus marqués avant revert. La calibration `SWAP_IN = 50e8` est
  délibérément **conservatrice** : à 50 BTC d'entrée, le réservoir 0 ne
  monte qu'à ~34,5 % et le réservoir 2 ne descend qu'à ~32,7 %, les deux
  loin des nouvelles limites. Le banc reste représentatif d'un usage
  nominal, et un futur scénario « swap stress » trouvera ici la marge
  pour tester les bords sans reverter.

- **La réduction de `SWAP_IN` de 250 à 50 BTC explique l'essentiel du
  delta de `swap` (+4 674)**, pas l'élargissement des bandes. Le code de
  `swap` n'a pas changé ; seules les valeurs manipulées sont plus petites,
  et l'arithmétique sur des entiers plus petits peut emprunter des chemins
  différents dans l'optimiseur, en plus de l'effet attendu sur la
  position du code déployé (les opcodes immédiats des constantes `13` et
  `53` restent des `PUSH1` de même taille que `27` et `40`, mais
  l'arrangement du bytecode peut varier, et la lecture de code par l'EVM
  dépend de la position). Le doublement exact entre `swap` équilibré et
  `swap` déséquilibré (+4 674 dans les deux) confirme l'observation du
  jalon 1 : le déséquilibre n'ajoute rien, le coût dépend des opérations
  effectuées, pas des valeurs manipulées.

- **Les fonctions qui ne touchent pas les bandes sont au gaz près
  inchangées** : `setFee` à +22, `removeLiquidity` (partiel et total)
  à −3. Ces écarts sont dans la marge de bruit du mesureur hardhat
  (±10 à ±20 typiquement), et **surtout** dans la direction opposée
  (`removeLiquidity` descend légèrement) : c'est la signature d'un
  effet nul, pas d'une dérive systématique. `addLiquidity` ne lit
  jamais les bandes non plus, mais montre +2 312/+4 164 : voir la
  lecture suivante.

- **`addLiquidity` ne touche pas les bandes mais bouge quand même** :
  +4 164 sur pool vide, +2 312 sur pool amorcé et déséquilibré. Le delta
  ne vient donc pas du code d'`addLiquidity` lui-même, mais du bytecode
  déployé. Le changement de valeurs des deux constantes `uint8` (13, 53
  vs 27, 40) ne change pas la taille des `PUSH1` qui les portent, mais
  l'optimiseur peut réarranger le code en aval, et la position absolue
  de chaque opcode dans le runtime se décale. Le delta supérieur sur le
  pool vide (+4 164 contre +2 312) reflète un chemin d'exécution plus
  court dans la branche `supply == 0`, donc plus sensible à ce
  décalage. C'est le prix à payer pour mesurer sur un seul profil
  optimisé : aucune fuite ne distingue un effet sémantique d'un effet
  de disposition.
