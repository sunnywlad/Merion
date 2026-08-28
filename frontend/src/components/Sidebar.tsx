import Balances from '@/components/Balances';
import PoolRail from '@/components/PoolRail';

/**
 * Merion sidebar — lecture seule, aucune action.
 *
 * Note d'inspiration §7 : trois familles d'information regroupées
 * différemment :
 *   - Utilisateur (« Your position ») — toujours dépliée, au-dessus du pli
 *   - Pool — repliée par défaut, dépliable
 *   - Enchère / mandat — sortie du rail, vit dans la barre d'enchère
 *     (cf. §11, différenciateur du produit)
 *
 * Le rail colle au bord gauche (0 px), sa propre marge interne fait le
 * travail. La cible d'architecture (etat.md § « Cible d'architecture »)
 * l'exige : la sidebar ne mute pas l'état, elle ne contient pas de bouton
 * d'action. L'enchère se joue dans l'AuctionBar, pas ici.
 */
export default function Sidebar({ className = '' }: { className?: string }) {
  return (
    <aside
      className={
        `bg-slate border-r border-cloud/5 p-6 overflow-y-auto ${className}`.trim()
      }
    >
      <section className="flex flex-col gap-3 pb-6 border-b border-cloud/5">
        <h2 className="text-h4 font-medium text-cloud">Your position</h2>
        <Balances />
      </section>

      <PoolRail />
    </aside>
  );
}
