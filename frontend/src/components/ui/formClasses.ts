// R3/C.1 — Classes Tailwind partagées par les 3 formulaires
// (Swap, AddLiquidity, RemoveLiquidity).
//
// Avant : 3 copies inline avec dérive visible (cf. §3.6 du rapport
// R3). `num-tabular` est dans la base côté Swap/AddLiquidity et au
// site d'appel côté RemoveLiquidity — divergence purement
// typographique, sans impact visuel. On fixe la convention ici :
// `INPUT_CLASS_MONO` combine `num-tabular` + `font-mono`, et les 3
// sites d'appel l'utilisent tel quel (la dérive `num-tabular`
// redondant de RemoveLiquidity est résorbée).
//
// py-1.5 (6 px) plutôt que py-2 (8 px) : compaction uniforme des
// formulaires pour gagner la marge 1440×900 sur /pool. La note §2
// borne le padding interne d'un input entre 0.25 et 0.5 rem, on
// reste dans la fenêtre (1.5/16 = 0.375 rem par côté).
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
