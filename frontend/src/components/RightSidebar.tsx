'use client';

import Balances from '@/components/Balances';

/**
 * Merion sidebar droite — « Your position ».
 *
 * Le bouton de connexion AppKit (« appkit-button ») est repassé dans la
 * navbar (cf. demande) ; ce rail ne sert plus que la famille
 * « Your position » (Balances : BTC wrappés + ETH + LP). Le rail colle au
 * bord droit (0 px) ; sa marge interne fait le travail. Padding réduit à
 * `p-4` pour aligner le titre « Your position » sur ceux de « Pool » et
 * « Swap ».
 */
export default function RightSidebar({
  className = '',
}: {
  className?: string;
}) {
  return (
    <aside
      className={
        `bg-slate border-l-[3px] border-merion-blue/40 p-4 overflow-y-auto ${className}`.trim()
      }
    >
      <section className="flex flex-col gap-6">
        <h2 className="text-h4 font-medium text-cloud">Your balances</h2>
        <Balances />
      </section>
    </aside>
  );
}
