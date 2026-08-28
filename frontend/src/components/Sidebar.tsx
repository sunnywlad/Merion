import Balances from '@/components/Balances';
import Reserves from '@/components/Reserves';
import MandatePanel from '@/components/MandatePanel';
import Connection from '@/components/Connection';

/**
 * Merion sidebar — lecture seule, aucune action.
 *
 * La cible d'architecture (etat.md § « Cible d'architecture ») l'exige : la
 * sidebar ne mute pas l'état, elle ne contient pas de bouton. L'enchère se joue
 * dans l'AuctionBar, pas ici.
 *
 * Trois sections :
 *   - Connection → Balances
 *   - Pool       → Reserves
 *   - Mandate    → MandatePanel
 */
export default function Sidebar() {
  return (
    <aside className="w-72 shrink-0 bg-slate border-r border-cloud/5 p-4 overflow-y-auto">
      <section className="pb-6 border-b border-cloud/5">
        <h2 className="text-h5 font-medium text-cloud mb-3">Connection</h2>
        <Connection>
          <Balances />
        </Connection>
      </section>

      <section className="py-6 border-b border-cloud/5">
        <h2 className="text-h5 font-medium text-cloud mb-3">Pool</h2>
        <Reserves />
      </section>

      <section className="pt-6">
        <h2 className="text-h5 font-medium text-cloud mb-3">Mandate</h2>
        <MandatePanel />
      </section>
    </aside>
  );
}
