'use client';

import { useConnection } from 'wagmi';
import { useAuctionState } from '@/hooks/useAuctionState';
import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useEffectiveFees } from '@/hooks/useEffectiveFees';
import { useManagerOf } from '@/hooks/useManagerOf';
import { useRentPosition } from '@/hooks/useRentPosition';
import { useConstants } from '@/hooks/useConstants';
import { useChainNow } from '@/hooks/useChainNow';
import { deployedAuction, tokensInfo, MRN_DECIMALS } from '@/constants/addresses';
import { secondsLeft, formatCountdown } from '@/lib/mandateWindow';
import { rentClaimable } from '@/lib/rentClaimable';
import { collectReadErrors } from '@/lib/readErrors';
import AmountLine from '@/components/AmountLine';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Une adresse entière déborde la barre latérale, et les deux bouts suffisent à
// reconnaître la sienne.
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const nameOf = (index: number) =>
  tokensInfo.find((token) => token.index === BigInt(index))?.name ?? String(index);

export default function MandatePanel() {
  // Le décompte se cale sur le temps de la chaîne (`useChainNow`), pas sur
  // l'horloge navigateur (`useNow`) : une dérive de quelques minutes entre
  // les deux fait apparaître « 0 min 00 s » alors que la fenêtre est ouverte.
  // `useChainNow` lisse le tick à la seconde par translation locale entre
  // deux blocs, donc la précision seconde-par-seconde est préservée.
  const now = useChainNow();
  const user = useConnection().address;

  const auction = useAuctionState();
  const constants = useAuctionConstants();
  const fees = useEffectiveFees();
  const { feeDen: feeDenEntry, error: errorPoolConstants } = useConstants();
  const rent = useRentPosition(user);

  const currentEpoch = auction.currentEpoch?.status === 'success' ? auction.currentEpoch.result : undefined;
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

  const failedReads = collectReadErrors([
    { message: 'Failed to read the auction state', error: auction.error },
    { message: 'Failed to read the auction constants', error: constants.error },
    { message: 'Failed to read the effective fee', error: fees.error },
    { message: 'Failed to read the pool constants', error: errorPoolConstants },
    { message: 'Failed to read the current manager', error: managerNow.error },
    { message: 'Failed to read your rent position', error: rent.error }
  ]);
  if (failedReads.length > 0) {
    for (const r of failedReads) console.error('[Merion]', r.message, r.error);
    const cause = failedReads.find((r) => r.error)?.error?.message ?? 'unknown';
    return (
      <AppStateBoundary
        state={{
          kind: 'error',
          title: 'Could not read mandate data',
          description: `Unable to read the mandate. ${failedReads.map((r) => r.message).join('; ')}`,
          cause,
        }}
      />
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
  const endTime = currentEpoch !== undefined
    && constants.genesis !== undefined
    && constants.epochDuration !== undefined
      ? constants.genesis + (currentEpoch + 1n) * constants.epochDuration
      : undefined;
  const timeToEnd = now !== null && endTime !== undefined ? secondsLeft(endTime, now) : null;

  const rentEntries = rent.data;
  const rentValues = rentEntries?.every((entry) => entry.status === 'success')
    ? rentEntries.map((entry) => entry.result as bigint)
    : undefined;
  const claimable = rentValues && now !== null
    ? rentClaimable({
        accPerShare: rentValues[0],
        rentRate: rentValues[1],
        rentEnd: rentValues[2],
        rentLastUpdate: rentValues[3],
        supply: rentValues[4],
        balance: rentValues[5],
        rentDebt: rentValues[6],
        rentPending: rentValues[7],
        now
      })
    : undefined;

  const managerInOffice = managerNow.data;
  const hasManagerNow = managerInOffice !== undefined && managerInOffice !== ZERO_ADDRESS;

  return (
    <section className='min-w-0'>
      <h2 className='text-sm font-semibold pb-2'>Current mandate</h2>
      <ul className='text-sm'>

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
          decimals={2}
          suffix=" %"
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
              decimals={2}
              suffix=" %"
            />
            <li>
              Surcharge active on: {fees.surcharged.map(([i, j]) => `${nameOf(i)} → ${nameOf(j)}`).join(', ')}
            </li>
          </>
        )}

        {timeToEnd !== null && (
          <li>Mandate ends in {formatCountdown(timeToEnd)}</li>
        )}

        {/* Le loyer se lit par adresse : sans connexion, la réponse honnête
            n'est pas zéro. */}
        {user
          ? <AmountLine
              label="Claimable rent"
              isLoading={rent.isLoading}
              error={null}
              value={claimable}
              decimals={MRN_DECIMALS}
              suffix=" MRN"
            />
          : <li className='pt-2'>Claimable rent: connect to read.</li>}

      </ul>
    </section>
  );
}
