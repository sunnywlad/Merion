'use client';

import { useConnection } from 'wagmi';
import { useAuctionState } from '@/hooks/useAuctionState';
import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useEffectiveFees } from '@/hooks/useEffectiveFees';
import { useManagerOf } from '@/hooks/useManagerOf';
import { useClaimableRent } from '@/hooks/useClaimableRent';
import { useConstants } from '@/hooks/useConstants';
import { useChainNow } from '@/hooks/useChainNow';
import { useMandateTimeline } from '@/hooks/useMandateTimeline';
import { MRN_DECIMALS } from '@/constants/addresses';
import { useAddresses } from '@/hooks/useAddresses';
import { ZERO_ADDRESS } from '@/hooks/_constants';
import { secondsLeft, formatCountdown } from '@/lib/mandateWindow';
import { short } from '@/lib/formatAddress';
import AmountLine from '@/components/AmountLine';
import { MandateTimeline } from '@/components/MandateTimeline';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';
import { ReadErrorBoundary } from '@/components/ui/ReadErrorBoundary';

export default function MandatePanel() {
  // Le décompte se cale sur le temps de la chaîne (`useChainNow`), pas sur
  // l'horloge navigateur (`useNow`) : une dérive de quelques minutes entre
  // les deux fait apparaître « 0 min 00 s » alors que la fenêtre est ouverte.
  // `useChainNow` lisse le tick à la seconde par translation locale entre
  // deux blocs, donc la précision seconde-par-seconde est préservée.
  const now = useChainNow();
  const user = useConnection().address;
  const { auction: deployedAuction, tokens: tokensInfo } = useAddresses();

  const auction = useAuctionState();
  const constants = useAuctionConstants();
  const fees = useEffectiveFees();
  const { feeDen: feeDenEntry, error: errorPoolConstants } = useConstants();
  const rent = useClaimableRent(user);
  const {
    currentEpoch,
    startTime,
    endTime,
    totalDuration,
    lateWindow,
    timelineStatus,
  } = useMandateTimeline();

  const managerNow = useManagerOf(currentEpoch);

  // L'enchère n'est pas déployée : ce n'est pas une erreur de lecture, et
  // afficher six lignes en échec ne dirait rien. Le pool, lui, tourne.
  if (deployedAuction === null) {
    return (
      <section className='min-w-0'>
        <h2 className='text-sm font-semibold pb-2'>Current mandate</h2>
        <p className='text-sm'>
          Auction not deployed on this chain: the pool trades at the base fee,
          no mandate is sold.
        </p>
      </section>
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

  // II.5 — Frise d'enchère. `lateWindow` n'est pas un constant du contrat :
  // on prend 15 % de la durée du mandat comme proxy (motivation dans le
  // rapport). `silence` utilise `bidSilence` lu par useAuctionConstants
  // s'il est disponible, sinon retombe sur 5 % de la durée (proportion
  // d'exemple du brief).
  const silence = constants.bidSilence !== undefined
    ? Number(constants.bidSilence)
    : totalDuration !== undefined
      ? Math.floor(totalDuration * 0.05)
      : undefined;

  const claimable = rent.data;

  const managerInOffice = managerNow.data;
  const hasManagerNow = managerInOffice !== undefined && managerInOffice !== ZERO_ADDRESS;

  return (
    <ReadErrorBoundary
      title="Could not read mandate data"
      description={(msgs) => `Unable to read the mandate. ${msgs.join('; ')}`}
      sources={[
        { message: 'Failed to read the auction state', error: auction.error },
        { message: 'Failed to read the auction constants', error: constants.error },
        { message: 'Failed to read the effective fee', error: fees.error },
        { message: 'Failed to read the pool constants', error: errorPoolConstants },
        { message: 'Failed to read the current manager', error: managerNow.error },
        { message: 'Failed to read your rent position', error: rent.error }
      ]}
    >
      <section className='min-w-0'>
        <h2 className='text-sm font-semibold pb-2'>Current mandate</h2>

        {/* II.5 — Frise d'enchère. L'inline « Mandate unsold, pool at base fee »
            plus bas reste : il porte l'absence de gestionnaire (cas nominal),
            la frise porte l'état temporel du mandat. Les deux sont complémentaires. */}
        {startTime !== undefined && endTime !== undefined && lateWindow !== undefined && silence !== undefined && now !== null ? (
          <MandateTimeline
            start={Number(startTime)}
            end={Number(endTime)}
            now={Number(now)}
            lateWindow={lateWindow}
            silence={silence}
            status={timelineStatus}
            className="pb-4"
          />
        ) : null}

        {/* Tâche 3 fix — légendes hors `<ul>`.
            Raison : un `<li>` légende inséré au milieu d'une liste déplace
            l'index des `<li>` suivants. Quand l'état SSR et le premier rendu
            client divergent sur la valeur d'un item (ex. `currentEpoch`
            encore en `undefined` côté serveur, chargé côté client), React
            apparie par index et déclenche un mismatch d'hydratation. En
            sortant la légende du `<ul>` (devenue `<h5>` sœur), la structure
            reste identique des deux côtés et les `<li>` portent les
            mêmes données au même rang. */}

        <div className='text-sm'>
          <h5 className='pt-2 pb-1 text-h5 text-cloud/80'>
            Mandate
          </h5>
          <ul>

            <li>Mandate index: {currentEpoch === undefined ? '—' : String(currentEpoch)}</li>

            {/* The current manager. Absence is read as a state of the mechanism:
                the mandate found no bidder, the pool runs at the base fee, and
                everything works. A "You" badge appears next to the address when
                the connected user is that manager, so the line doesn't have to
                be mentally compared with MetaMask. */}
            <li>
              {hasManagerNow
                ? <>Manager: {short(managerInOffice)}{user !== undefined && managerInOffice === user && (
                    <span className='ml-2 px-2 py-0.5 text-xs bg-emerald-100 text-emerald-800 rounded'>
                      You
                    </span>
                  )}</>
                : <>Mandate unsold, pool at base fee</>}
            </li>

            <AmountLine
              label="Base fee in force"
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
                <li>
                  Surcharge active on: {fees.surcharged.map(([i, j]) => `${tokensInfo.find((t) => t.index === BigInt(i))?.name ?? i} → ${tokensInfo.find((t) => t.index === BigInt(j))?.name ?? j}`).join(', ')}
                </li>
              </>
            )}

            {timeToEnd !== null && (
              <li>Mandate ends in {formatCountdown(timeToEnd)}</li>
            )}

          </ul>
        </div>

        <div className='text-sm pt-3'>
          <h5 className='pb-1 text-h5 text-cloud/80'>
            Settlement
          </h5>
          <ul>

            {/* Le loyer se lit par adresse : sans connexion, la réponse honnête
                n'est pas zéro. */}
            {user
              ? <AmountLine
                  label="Claimable rent"
                  isLoading={rent.isLoading}
                  error={null}
                  value={claimable}
                  displayDecimals={2}
                  tokenDecimals={MRN_DECIMALS}
                  grouping="fr"
                  unit="MRN"
                />
              : <li>Claimable rent: connect to read.</li>}

          </ul>
        </div>
      </section>
    </ReadErrorBoundary>
  );
}
