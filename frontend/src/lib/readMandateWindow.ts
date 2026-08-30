// I.5 — La lecture d'état du mandat, isolée des hooks pour rester pure : elle
// ne prend que des scalaires déjà lus sur la chaîne, et rend l'état que le
// panneau affiche. Aucun appel, aucun `Date.now()` ici, l'instant arrive en
// argument, ce qui rend la fonction testable seconde par seconde.

// `open` et `closed` ne se déduisent PAS du temps local : c'est `windowOpen()`
// qui tranche, et lui seul. Recalculer la borne côté front dupliquerait la
// logique du contrat, et les deux versions divergeraient au premier
// changement de `auctionWindow`. Le temps local ne sert qu'au décompte et à
// la fenêtre de silence, que le contrat n'expose pas en vue.
export type MandatePhase =
  // Aucune enchère ouverte pour le mandat suivant : `sellingEpoch` appartient à
  // une enchère finie, et la première mise rouvrira le créneau à zéro. C'est
  // l'état nominal la plupart du temps, pas une anomalie.
  | 'idle'
  | 'open'
  | 'closed';

export type MandateWindow = {
  phase: MandatePhase;
  // La fenêtre de silence, les dernières secondes du mandat en cours, pendant
  // lesquelles le settle nomme le gestionnaire du mandat suivant. Orthogonale
  // à la phase : à `bidSilence` court et `auctionWindow` large, une enchère
  // encore ouverte peut déjà être en silence, et le panneau doit dire les deux.
  inSilence: boolean;
  // L'instant que le décompte vise, ou `null` quand il n'y a rien à décompter.
  // Enchère ouverte, on décompte sa clôture ; enchère fermée, on décompte la
  // prise d'office, c'est-à-dire le début du mandat vendu.
  countdownTo: bigint | null;
  // Le début du mandat mis en vente, donc la fin du mandat en cours.
  nextMandateStartsAt: bigint | null;
};

export const readMandateWindow = ({
  now,
  currentEpoch,
  sellingEpoch,
  windowOpen,
  closesAt,
  bidSilence,
  genesis,
  epochDuration
}: {
  now: bigint;
  currentEpoch: bigint;
  sellingEpoch: bigint;
  windowOpen: boolean;
  // `undefined` couvre le cas nominal du premier jour : `closesAt()` calcule
  // `startOfEpoch(sellingEpoch - 1)`, donc il REVERT tant que `sellingEpoch`
  // vaut zéro, c'est-à-dire tant qu'aucune mise n'a jamais été posée. Une
  // lecture en échec n'est pas ici une erreur de chaîne, c'est un état.
  closesAt: bigint | undefined;
  bidSilence: bigint;
  genesis: bigint;
  epochDuration: bigint;
}): MandateWindow => {

  // La règle d'or du contrat : l'enchère est active si et seulement si elle
  // vend bien le mandat suivant. Hors de là, le créneau appartient au passé.
  const sellsNextMandate = sellingEpoch === currentEpoch + 1n;

  const nextMandateStartsAt = sellsNextMandate
    ? genesis + sellingEpoch * epochDuration
    : null;

  const inSilence = nextMandateStartsAt !== null
    && now >= nextMandateStartsAt - bidSilence;

  const phase: MandatePhase = windowOpen
    ? 'open'
    : sellsNextMandate ? 'closed' : 'idle';

  // Le décompte ne vise jamais un instant déjà passé : `closesAt` est écarté
  // dès que la phase n'est plus ouverte, et la prise d'office n'est visée que
  // tant qu'une enchère la concerne.
  const countdownTo = phase === 'open'
    ? (closesAt ?? null)
    : phase === 'closed' ? nextMandateStartsAt : null;

  return { phase, inSilence, countdownTo, nextMandateStartsAt };
};

// La mise minimale suivante, reproduite du contrat :
// `max(minOpeningBid, highBid * HIGH_BID_BPS / BPS_DEN)`. La première mise voit
// `highBid == 0`, donc le produit vaut zéro et le plancher d'ouverture gagne.
// Les scalaires arrivent de la chaîne plutôt que codés ici : `HIGH_BID_BPS` est
// une constante du contrat, pas une constante du front.
export const nextMinimumBid = ({
  highBid,
  minOpeningBid,
  highBidBps,
  bpsDen
}: {
  highBid: bigint;
  minOpeningBid: bigint;
  highBidBps: bigint;
  bpsDen: bigint;
}): bigint | undefined => {
  // Un dénominateur nul rendrait une division par zéro ; il ne peut venir que
  // d'une lecture cassée, et une mise minimale fausse serait pire qu'absente.
  if (!bpsDen) return undefined;
  const raised = highBid * highBidBps / bpsDen;
  return raised > minOpeningBid ? raised : minOpeningBid;
};

// Le décompte, en secondes, borné à zéro : un décompte négatif ne veut rien
// dire à l'affichage, et l'écart d'une seconde du tick local ne doit pas
// produire un « -1 ».
export const secondsLeft = (target: bigint | null, now: bigint): bigint | null => {
  if (target === null) return null;
  return target > now ? target - now : 0n;
};

// Format court, en français, pour un décompte de quelques minutes comme de
// quelques heures. Le `Number` est sûr : l'entrée est un écart de secondes déjà
// borné, jamais un timestamp.
export const formatCountdown = (seconds: bigint | null): string => {
  if (seconds === null) return "—";
  const total = Number(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h} h ${pad(m)} min ${pad(s)} s` : `${m} min ${pad(s)} s`;
};