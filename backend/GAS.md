# Coût en gaz — banc de mesure et historique

## À quoi sert ce banc

`contracts/Pool.gas.t.sol` **n'est pas une suite de tests.** La correction du
contrat est vérifiée ailleurs : `test/Pool.addLiquidity.test.ts` pour le
fonctionnel, les tests de fuzz et d'invariants à venir pour la sûreté. Ce
fichier répond à une autre question : *combien coûte chaque fonction, et ce
coût a-t-il bougé depuis la dernière fois ?*

Une suite verte ne dit rien d'un remaniement qui ajoute 30 000 de gaz à
`addLiquidity` : le comportement est identique, seul l'utilisateur paie. Sans
banc figé, une régression de coût passe inaperçue.

## Comment il fonctionne

Le banc exécute des scénarios aux montants **gelés** (`SEED`, `DEPOSIT`,
`SWAP_IN` dans le fichier). Hardhat enregistre le gaz de chaque fonction de
test dans `.gas-snapshot`, qui est **versionné** — c'est la référence.

```bash
# Mesurer et rafraîchir la référence (à faire à chaque jalon, volontairement)
npx hardhat test solidity contracts/Pool.gas.t.sol --snapshot

# Vérifier qu'aucun coût n'a bougé (CI)
npx hardhat test solidity contracts/Pool.gas.t.sol --snapshot-check

# Tableau détaillé par fonction, lisible à l'écran
npx hardhat test solidity contracts/Pool.gas.t.sol --gas-stats
```

### Règle d'or

Les montants du banc **ne se modifient jamais.** Les changer ne casse aucun
test, mais rend toutes les mesures antérieures incomparables, et cette rupture
est silencieuse. **Ajouter** un scénario est en revanche sans danger :
vérifié, une entrée absente de `.gas-snapshot` ne fait pas échouer
`--snapshot-check`, seule une valeur qui dévie le fait.

### Comportement de `--snapshot-check`, vérifié

| Situation | Résultat |
|---|---|
| Aucun changement | `Snapshot check passed` |
| Une valeur dévie | Échec, avec l'écart chiffré : `Expected 24000 / Actual 24289 (+1.20%, Δ+289)` |
| Nouveau scénario sans référence | Passe, la nouvelle entrée est ignorée |

L'égalité est **stricte**, il n'existe pas d'option de tolérance. C'est
délibéré : toute modification de contrat cassera le check, et la référence
doit être rafraîchie **consciemment**, dans le même commit, en disant dans le
message que le coût a changé et pourquoi.

## Deux mesures à ne pas confondre

`.gas-snapshot` mesure une **fonction de test entière**, mise en situation
comprise. `test_gas_AddLiquidity_SeededPool` inclut donc l'amorçage du pool.
Ces nombres sont faits pour être comparés **entre eux dans le temps**, pas
pour être cités comme le prix d'un appel.

Le tableau `--gas-stats` mesure chaque **appel** au contrat, mais il agrège
tous les appels d'une même fonction, tous scénarios confondus : sa moyenne
mélange un premier dépôt en pool vide et un dépôt courant, et n'est donc pas
comparable d'une version à l'autre si le jeu de tests a changé.

**Ne jamais comparer un chiffre issu des tests Solidity avec un chiffre issu
des tests TypeScript.** Les deux couches ne rapportent pas la même chose pour
le même contrat : la couche Solidity annonce 10 160 octets et 2 391 505 de
déploiement, la couche TypeScript 12 795 octets et 2 971 950. L'écart n'est
pas expliqué à ce jour et reste à investiguer ; en attendant, une série
historique ne mélange pas les deux sources.

## Réserve à lever

Les tests s'exécutent sur le profil de compilation `default`, **sans
optimiseur**. Le profil `production` (optimiseur, 200 runs) est celui qui
sera déployé. Les chiffres ci-dessous sont donc des coûts non optimisés et ne
doivent pas être présentés comme le coût réel du contrat en production.
À trancher avant le prochain jalon : figer le banc sur un profil et s'y tenir.

---

## Jalon 1 — 2026-08-12 — cœur à produit constant

Commit de base : `11d2c38`. Solidity 0.8.36, profil `default` (sans
optimiseur). Périmètre : `Pool.sol` à invariant produit constant, avant
StableSwap, avant les gardes de sécurité.

### Référence versionnée (`.gas-snapshot`)

| Scénario | Gaz |
|---|---|
| `addLiquidity` — pool vide | 227 042 |
| `addLiquidity` — pool amorcé | 261 849 |
| `addLiquidity` — pool déséquilibré | 283 903 |
| `removeLiquidity` — partiel | 260 546 |
| `removeLiquidity` — total | 240 512 |
| `swap` — pool équilibré | 253 352 |
| `swap` — pool déséquilibré | 273 516 |
| `setFee` | 24 289 |

### Coût par appel (`--gas-stats`, banc seul)

| Fonction | Min | Moyenne | Max | Appels |
|---|---|---|---|---|
| `addLiquidity` | 119 492 | 214 316 | 241 409 | 9 |
| `removeLiquidity` | 95 532 | 97 932 | 100 332 | 2 |
| `swap` | 76 057 | 76 057 | 76 057 | 4 |
| `setFee` | 35 742 | 35 742 | 35 742 | 1 |

Déploiement du pool : 2 391 505. Taille du bytecode : **10 160 octets**, à
comparer au plafond de 24 576 imposé par EIP-170. StableSwap et ses
résolutions par la méthode de Newton consommeront une part notable de la
marge restante : c'est ce chiffre-là qu'il faudra surveiller au jalon 2.

### Lectures

- Le premier dépôt est **moins** cher que les suivants dans la référence
  (227 042 contre 261 849), alors qu'il écrit trois emplacements de stockage
  depuis zéro, au tarif plein. L'explication est dans la mise en situation :
  le scénario « pool amorcé » exécute l'amorçage **puis** le dépôt mesuré.
  C'est précisément le piège des mesures par fonction de test, et la raison
  pour laquelle ces nombres ne se citent pas hors contexte.
- Le coût par appel de `addLiquidity` va de 119 492 à 241 409, un facteur
  deux. L'écart vient du passage d'un emplacement de stockage nul à non nul :
  20 000 la première écriture, 5 000 les suivantes, sur trois réserves.
- `swap` est remarquablement stable, 76 057 quel que soit l'état du pool :
  il écrit deux réserves déjà non nulles, sans branche conditionnelle.
