import Link from 'next/link';

/**
 * Landing Merion — pleine largeur, hors coquille applicative.
 *
 * Le jury doit comprendre en dix secondes de quoi il s'agit : un DEX BTC sans
 * oracle, sur actifs wrappés (cbBTC / LBTC / WBTC), avec une enchère de mandat
 * qui gère le rééquilibrage. Proposition de valeur reprise du brand book §5
 * (institutionnel, sobre, lisible ; pas l'imagerie crypto habituelle).
 *
 * Les couleurs viennent des tokens posés par II.1 — aucun hex en dur.
 */

const PALETTE = [
  { token: 'Midnight', className: 'bg-midnight', text: 'text-cloud', border: 'border-cloud/20' },
  { token: 'Slate', className: 'bg-slate', text: 'text-cloud', border: 'border-cloud/20' },
  { token: 'Cloud', className: 'bg-cloud', text: 'text-midnight', border: 'border-cloud/20' },
  { token: 'Merion Blue', className: 'bg-merion-blue', text: 'text-white', border: 'border-merion-blue' },
] as const;

const SEMANTICS = [
  { token: 'Success', className: 'bg-success' },
  { token: 'Warning', className: 'bg-warning' },
  { token: 'Danger', className: 'bg-danger' },
  { token: 'Info', className: 'bg-info' },
  { token: 'Neutral', className: 'bg-neutral' },
] as const;

export default function Home() {
  return (
    <div className="flex-1 min-h-0">
      <section className="px-8 py-20 bg-midnight">
        <div className="max-w-4xl mx-auto flex flex-col gap-8">
          <p className="text-caption uppercase tracking-[0.2em] text-cloud/70">
            Merion
          </p>
          <h1 className="text-h1 text-white">
            An oracle-free BTC DEX, settled by auction.
          </h1>
          <p className="text-body-lg text-cloud/80 max-w-2xl">
            Merion trades wrapped Bitcoin at equal reserves across cbBTC, LBTC
            and WBTC, with an on-chain auction that picks a manager each epoch
            to keep the pool balanced. No external price feed, no implied
            volatility surface, no off-chain keeper.
          </p>
          <div>
            <Link
              href="/swap"
              className={
                'inline-flex items-center justify-center gap-2 rounded ' +
                'font-medium transition-colors duration-150 ' +
                'px-5 py-3 text-body-lg ' +
                'bg-merion-blue text-white border-2 border-merion-blue ' +
                'hover:bg-merion-blue/90 hover:border-merion-blue/90 ' +
                'focus:outline-none focus-visible:border-cloud focus-visible:border-2'
              }
            >
              <span>Open Swap</span>
              <span aria-hidden="true" className="leading-none">
                →
              </span>
            </Link>
          </div>
        </div>
      </section>

      <section className="px-8 py-16 bg-midnight">
        <div className="max-w-5xl mx-auto flex flex-col gap-10">
          <div className="flex flex-col gap-2">
            <h2 className="text-h3 text-cloud">Brand system</h2>
            <p className="text-body text-cloud/70">
              The palette and type that ship with every page. Sampled from the
              Merion brand book.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-h5 text-cloud/80">Primary</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {PALETTE.map(({ token, className, text, border }) => (
                <div
                  key={token}
                  className={`rounded border ${border} ${className} p-4 h-24 flex items-end ${text}`}
                >
                  <span className="text-small font-medium">{token}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-h5 text-cloud/80">Semantic</h3>
            <div className="flex flex-wrap gap-3">
              {SEMANTICS.map(({ token, className }) => (
                <div
                  key={token}
                  className={`rounded px-4 py-2 ${className} text-cloud text-small font-medium`}
                >
                  {token}
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4 pt-4 border-t border-cloud/10">
            <h3 className="text-h5 text-cloud/80">Typography</h3>
            <div className="flex flex-col gap-2">
              <p className="text-h3 text-cloud">H3 — IBM Plex Sans, 32 px</p>
              <p className="text-body text-cloud/80">
                Body — IBM Plex Sans, 16 px, 1.6 leading. Used for narrative
                content and form labels.
              </p>
              <p className="text-code text-merion-blue">
                Code — IBM Plex Mono, 14 px. Reserved for addresses, amounts
                and on-chain values.
              </p>
              <p className="text-caption text-cloud/60">
                Caption — 12 px, 1.4 leading. Footnotes and meta information.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
