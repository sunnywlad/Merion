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
 *
 * Statique : vit dans `app/(marketing)/` (sans `Providers`), donc aucun
 * web3 n'est chargé sur cette route.
 */

export default function Home() {
  return (
    <div className="flex-1 min-h-0">
      <section className="px-8 py-20 bg-midnight">
        <div className="max-w-4xl mx-auto flex flex-col gap-8">
          <p className="text-h3 font-semibold uppercase tracking-[0.2em] text-cloud mb-4">
            Merion
          </p>
          <h1 className="text-h2 text-white">
            An oracle-free BTC DEX, settled by auction.
          </h1>
          <p className="text-body-lg text-cloud/80 max-w-2xl">
            Merion trades wrapped Bitcoin at equal reserves across cbBTC, LBTC
            and WBTC, with an on-chain auction that picks a manager each epoch
            to keep the pool balanced. No external price feed, no implied
            volatility surface, no off-chain keeper.
          </p>
          <div className="flex items-center gap-4">
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
              <span>Swap</span>
              <span aria-hidden="true" className="leading-none">
                →
              </span>
            </Link>
            <Link
              href="/pool"
              className={
                'inline-flex items-center justify-center gap-2 rounded ' +
                'font-medium transition-colors duration-150 ' +
                'px-5 py-3 text-body-lg ' +
                'bg-merion-blue text-white border-2 border-merion-blue ' +
                'hover:bg-merion-blue/90 hover:border-merion-blue/90 ' +
                'focus:outline-none focus-visible:border-cloud focus-visible:border-2'
              }
            >
              <span>Deposit</span>
              <span aria-hidden="true" className="leading-none">
                →
              </span>
            </Link>
          </div>
        </div>
      </section>

    </div>
  );
}
