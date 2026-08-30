import PoolRail from '@/components/PoolRail';

/**
 * Merion sidebar gauche — lecture seule, aucune action.
 *
 * Restructuration (cf. demande) : le rail gauche ne sert plus que la
 * famille « Pool ». La famille « Your position » a migré dans le rail
 * droit (`RightSidebar`), sous le bouton de connexion AppKit. Le rail
 * colle au bord gauche (0 px) ; sa propre marge interne fait le travail.
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
