// R3/C.1 — Classes Tailwind partagées par les 3 formulaires
// (Swap, AddLiquidity, RemoveLiquidity).
//
// `INPUT_CLASS_MONO` combine `num-tabular` + `font-mono`, et les 3
// sites d'appel l'utilisent tel quel.
//
// py-1.5 (6 px) plutôt que py-2 (8 px) : compaction uniforme des
// formulaires pour gagner la marge 1440×900 sur /pool. Le padding
// interne d'un input reste borné entre 0.25 et 0.5 rem, on est dans
// la fenêtre (1.5/16 = 0.375 rem par côté).
// `placeholder:text-cloud/60` : WCAG AA, le placeholder sinon tombe
// à ~3.6:1 (cloud/40) sur Midnight.

const BASE_INPUT =
  'w-full rounded border border-merion-blue/40 bg-slate px-3 py-1.5 ' +
  'text-code text-cloud placeholder:text-cloud/60 ' +
  'focus:outline-none focus:border-merion-blue focus:border-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export const INPUT_CLASS_MONO = BASE_INPUT + 'num-tabular font-mono';

export const SELECT_CLASS =
  'shrink-0 rounded border border-merion-blue/40 bg-slate px-3 py-2 ' +
  'text-body text-cloud ' +
  'focus:outline-none focus:border-merion-blue focus:border-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';
