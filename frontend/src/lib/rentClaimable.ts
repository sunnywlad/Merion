// I.5 — Le loyer réclamable par une adresse, calculé hors chaîne.
//
// LE MANQUE QU'ON CONTOURNE : le Pool n'expose aucune vue `claimable(address)`.
// `claimRent()` fait le calcul, mais il l'écrit, donc il n'est pas quotable, et
// une simulation d'appel rendrait le montant seulement pour une adresse qui a
// vraiment quelque chose à tirer (la garde `ZeroRentOwed` revert sinon). Le
// front reproduit donc les deux fonctions du contrat, `_updateRent` puis la
// tête de `claimRent`, sur des scalaires publics.
//
// LE RISQUE ASSUMÉ : cette fonction est un miroir, et un miroir se désaligne
// dès que le contrat bouge. La contrepartie serait une vue de trois lignes dans
// Pool.sol, qui rendrait ce fichier inutile. La proposer est un travail de
// backend, hors du périmètre de cette étape.

// `accPerShare` est échelonné par 1e18, et `rentRate` l'est aussi : c'est
// l'échelle du contrat, reprise à l'identique plutôt que normalisée, pour que
// la comparaison ligne à ligne avec Pool.sol reste possible.
const ACC_SCALE = 10n ** 18n;

// Le miroir de `_updateRent()` : l'accumulateur, avancé jusqu'à maintenant sans
// rien écrire. La borne haute est `rentEnd`, un stream fini ne distribue plus.
const accNow = ({
  accPerShare,
  rentRate,
  rentEnd,
  rentLastUpdate,
  supply,
  now
}: {
  accPerShare: bigint;
  rentRate: bigint;
  rentEnd: bigint;
  rentLastUpdate: bigint;
  supply: bigint;
  now: bigint;
}): bigint => {
  // Stream fini, ou jamais démarré : l'accumulateur est déjà à jour.
  if (rentLastUpdate >= rentEnd) return accPerShare;
  const end = now < rentEnd ? now : rentEnd;
  // Le tick local peut retarder d'une seconde sur la chaîne ; un `dt` négatif
  // serait absurde et gonflerait le montant par soustraction.
  if (end <= rentLastUpdate) return accPerShare;
  const dt = end - rentLastUpdate;
  if (!rentRate || !supply) return accPerShare;
  return accPerShare + dt * rentRate / supply;
};

// Le miroir de la tête de `claimRent()` : le déjà-capturé par les transferts
// passés, plus l'accru vivant du solde courant. Un LP passif n'a rien dans
// `rentPending`, tout dans l'accru ; un LP qui a bougé ses parts a les deux.
export const rentClaimable = ({
  accPerShare,
  rentRate,
  rentEnd,
  rentLastUpdate,
  supply,
  balance,
  rentDebt,
  rentPending,
  now
}: {
  accPerShare: bigint;
  rentRate: bigint;
  rentEnd: bigint;
  rentLastUpdate: bigint;
  supply: bigint;
  balance: bigint;
  rentDebt: bigint;
  rentPending: bigint;
  now: bigint;
}): bigint => {
  const acc = accNow({ accPerShare, rentRate, rentEnd, rentLastUpdate, supply, now });
  const accrued = balance * acc / ACC_SCALE;
  // La comparaison, et non une soustraction sèche : la dette peut dépasser
  // l'accru juste après un transfert de parts, et un bigint négatif ici serait
  // un montant réclamable négatif à l'écran.
  return rentPending + (accrued > rentDebt ? accrued - rentDebt : 0n);
};
