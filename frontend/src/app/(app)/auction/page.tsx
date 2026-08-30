import { AuctionSummary } from '@/components/AuctionSummary';
import AuctionProgress from '@/components/AuctionProgress';
import { NextAuctionSummary } from '@/components/NextAuctionSummary';
import AuctionPanel from '@/components/AuctionPanel';
import MandatePanel from '@/components/MandatePanel';

/**
 * Page `/auction` — Merion.
 *
 * Le bloc AuctionBar (autrefois repliable au-dessus du pli sur `/pool` et
 * `/tools`) devient sa propre route applicative : la barre résumée reste
 * affichée en tête, puis les panneaux Auction + Mandate en pleine lecture
 * (plus de `Disclosure` à déplier). Cf. plan UI §11.
 *
 * `MandatePanel` traite lui-même le cas « enchère non déployée » (rend un
 * message statique plutôt que de se mettre en erreur de lecture), donc on
 * peut le monter inconditionnellement sans hook serveur.
 */
export default function AuctionPage() {
  return (
    <div className="flex flex-col gap-6">
      <AuctionSummary />
      <AuctionProgress />
      <NextAuctionSummary />
      <AuctionPanel />
      <MandatePanel />
    </div>
  );
}
