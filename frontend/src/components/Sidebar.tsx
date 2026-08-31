import PoolRail from '@/components/PoolRail';

/**
 * Merion sidebar gauche — lecture seule, aucune action.
 *
 * Le rail gauche héberge la famille « Pool ». La famille « Your position »
 * vit dans le rail droit (`RightSidebar`). Le rail colle au bord gauche
 * (0 px) ; sa propre marge interne fait le travail.
 */
export default function Sidebar({ className = '' }: { className?: string }) {
  return (
    <aside
      className={
        `bg-slate border-r-[3px] border-merion-blue/40 p-4 overflow-y-auto ${className}`.trim()
      }
    >
      <PoolRail />
    </aside>
  );
}
