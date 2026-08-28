import Balances from '@/components/Balances';
import PoolRail from '@/components/PoolRail';

/**
 * Merion sidebar — lecture seule, aucune action.
 *
 * Tâche 3 — séparation des trois familles (note d'inspiration §7).
 * Cette coquille abrite deux des trois familles :
 *   - Utilisateur (« Your position ») — toujours dépliée, au-dessus du pli
 *   - Pool — repliée par défaut, dépliable
 * La troisième famille (« Auction ») vit dans la barre d'enchère au-dessus
 * de la colonne principale, sortie du rail (cf. §11).
 *
 * Chaque titre de section porte une sous-titre courte qui résume son
 * scope, pour qu'un visiteur qui découvre l'app voie en un coup d'œil
 * quelle famille est servie par quelle zone. Le rail colle au bord
 * gauche (0 px) ; sa propre marge interne fait le travail.
 */
export default function Sidebar({ className = '' }: { className?: string }) {
  return (
    <aside
      className={
        `bg-slate border-r border-cloud/5 p-6 overflow-y-auto ${className}`.trim()
      }
    >
      <section className="flex flex-col gap-3 pb-6 border-b border-cloud/5">
        <div className="flex flex-col gap-1">
          <h2 className="text-h4 font-medium text-cloud">Your position</h2>
          <p className="text-caption uppercase tracking-wide text-cloud/60">
            Wallet balances · claims
          </p>
        </div>
        <Balances />
      </section>

      <PoolRail />
    </aside>
  );
}
