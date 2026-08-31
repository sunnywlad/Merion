'use client';

import { useConnection } from 'wagmi';
import { useAuctionState } from '@/hooks/useAuctionState';
import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useEffectiveFees } from '@/hooks/useEffectiveFees';
import { useManagerOf } from '@/hooks/useManagerOf';
import { useConstants } from '@/hooks/useConstants';
import { useChainNow } from '@/hooks/useChainNow';
import { useMandateTimeline } from '@/hooks/useMandateTimeline';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { ZERO_ADDRESS } from '@/hooks/_constants';
import { secondsLeft, formatCountdown } from '@/lib/readMandateWindow';
import { short } from '@/lib/formatAddress';
import AmountLine from '@/components/AmountLine';
import { Panel } from '@/components/Panel';
import { ReadErrorBoundary } from '@/components/ui/ReadErrorBoundary';

export default function MandatePanel() {
  // Le décompte se cale sur le temps de la chaîne (`useChainNow`), pas sur
  // l'horloge navigateur (`useNow`) : une dérive de quelques minutes entre
  // les deux fait apparaître « 0 min 00 s » alors que la fenêtre est ouverte.
  // `useChainNow` lisse le tick à la seconde par translation locale entre
  // deux blocs, donc la précision seconde-par-seconde est préservée.
  const now = useChainNow();
  const user = useConnection().address;
  const { auction: deployedAuction, tokens: tokensInfo } = useDeployedChainId();

  const auction = useAuctionState();
  const constants = useAuctionConstants();
  const fees = useEffectiveFees();
  const { feeDen: feeDenEntry, error: errorPoolConstants } = useConstants();
  // La frise de progression du mandat vit dans `AuctionProgress`,
  // monté directement sous `AuctionSummary` sur la page `/auction`. Ce
  // panneau ne garde que l'index et l'échéance du mandat courant.
  const { currentEpoch, endTime } = useMandateTimeline();

  const managerNow = useManagerOf(currentEpoch);

  // L'enchère n'est pas déployée : ce n'est pas une erreur de lecture, et
  // afficher six lignes en échec ne dirait rien. Le pool, lui, tourne.
  if (deployedAuction === null) {
    return (
      <Panel title={<span className="text-white">Current epoch</span>}>
        <p className='text-white'>
          Auction not deployed on this chain: the pool trades at the base fee,
          no epoch is sold.
        </p>
      </Panel>
    );
  }

  const feeDen = feeDenEntry?.status === 'success' ? feeDenEntry.result : undefined;
  // Le pourcentage se lit en points de base, donc `decimals={2}` rend un
  // pourcentage. Le dénominateur est testé pour sa vérité, pas sa définition :
  // un zéro diviserait par zéro, et le pool serait de toute façon cassé.
  const percentOf = (fee: bigint | undefined) =>
    fee !== undefined && feeDen ? fee * 10000n / feeDen : undefined;

  // La fin du mandat courant = début du suivant : `genesis + (currentEpoch + 1)
  // * epochDuration`. La ligne se tait plutôt que d'inventer si l'une des
  // trois lectures manque.
  const timeToEnd = now !== null && endTime !== undefined ? secondsLeft(endTime, now) : null;

  const managerInOffice = managerNow.data;
  const hasManagerNow = managerInOffice !== undefined && managerInOffice !== ZERO_ADDRESS;

  return (
    <ReadErrorBoundary
      title="Could not read epoch data"
      description={(msgs) => `Unable to read the epoch. ${msgs.join('; ')}`}
      sources={[
        { message: 'Failed to read the auction state', error: auction.error },
        { message: 'Failed to read the auction constants', error: constants.error },
        { message: 'Failed to read the effective fee', error: fees.error },
        { message: 'Failed to read the pool constants', error: errorPoolConstants },
        { message: 'Failed to read the current manager', error: managerNow.error }
      ]}
    >
      <Panel title={
        <span className="text-white">{`Current epoch ${currentEpoch === undefined ? '#—' : `#${String(currentEpoch)}`}`}</span>
      }>
        <ul className='text-white'>

          {/* Le gestionnaire courant. Son absence se lit comme un état de la
              mécanique : l'epoch n'a trouvé aucun enchérisseur, le pool
              tourne au tarif de base, tout fonctionne. Un badge « You »
              apparaît à côté de l'adresse quand l'utilisateur connecté est
              ce gestionnaire, pour éviter la comparaison mentale avec
              MetaMask. */}
          <li className='flex items-baseline justify-between gap-4 py-1'>
            {hasManagerNow
              ? <>
                  <span className='text-white'>Manager</span>
                  <span className='font-mono num-tabular'>
                    {short(managerInOffice)}
                    {user !== undefined && managerInOffice === user && (
                      <span className='ml-2 px-2 py-0.5 text-xs bg-emerald-100 text-emerald-800 rounded'>
                        You
                      </span>
                    )}
                  </span>
                </>
              : <span className='text-white'>Epoch unsold, pool at base fee</span>}
          </li>

          <AmountLine
            label="Base fee"
            isLoading={fees.isLoading}
            error={null}
            value={percentOf(fees.base)}
            displayDecimals={2}
            tokenDecimals={2}
            unit="%"
          />

          {/* La surcharge est directionnelle : un seul chiffre mentirait pour les
              autres sens. Les directions concernées sont nommées. */}
          {fees.base !== undefined && fees.worst !== undefined && fees.worst > fees.base && (
            <>
              <AmountLine
                label="Surcharged fee (drift)"
                isLoading={false}
                error={null}
                value={percentOf(fees.worst)}
                displayDecimals={2}
                tokenDecimals={2}
                unit="%"
              />
              <li className='flex items-baseline justify-between gap-4 py-1'>
                <span className='text-white'>Surcharge active on</span>
                <span>{fees.surcharged.map(([i, j]) => `${tokensInfo.find((t) => t.index === BigInt(i))?.name ?? i} → ${tokensInfo.find((t) => t.index === BigInt(j))?.name ?? j}`).join(', ')}</span>
              </li>
            </>
          )}

          {timeToEnd !== null && (
            <li className='flex items-baseline justify-between gap-4 py-1'>
              <span className='text-white'>Epoch ends in</span>
              <span className='font-mono num-tabular'>{formatCountdown(timeToEnd)}</span>
            </li>
          )}

        </ul>
      </Panel>
    </ReadErrorBoundary>
  );
}
