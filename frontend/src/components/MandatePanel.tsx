'use client';

import { useConnection } from 'wagmi';
import { useAuctionState } from '@/hooks/useAuctionState';
import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useEffectiveFees } from '@/hooks/useEffectiveFees';
import { useManagerOf } from '@/hooks/useManagerOf';
import { useRentPosition } from '@/hooks/useRentPosition';
import { useConstants } from '@/hooks/useConstants';
import { useNow } from '@/hooks/useNow';
import { deployedAuction, tokensInfo, MRN_DECIMALS } from '@/constants/addresses';
import { readMandateWindow, nextMinimumBid, secondsLeft, formatCountdown } from '@/lib/mandateWindow';
import { rentClaimable } from '@/lib/rentClaimable';
import { collectReadErrors } from '@/lib/readErrors';
import AmountLine from '@/components/AmountLine';
import ReadErrors from '@/components/ReadErrors';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Une adresse entière déborde la barre latérale, et les deux bouts suffisent à
// reconnaître la sienne.
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const nameOf = (index: number) =>
  tokensInfo.find((token) => token.index === BigInt(index))?.name ?? String(index);

// Les libellés de phase, en français, avec la lecture qui va avec. « Aucune
// enchère ouverte » est l'état nominal la plupart du temps, il est donc écrit
// comme un état du mécanisme, jamais comme un manque.
const PHASE_LABEL = {
  idle: "aucune enchère ouverte",
  open: "ouverte",
  closed: "fermée"
} as const;

export default function MandatePanel() {
  const now = useNow();
  const user = useConnection().address;

  const auction = useAuctionState();
  const constants = useAuctionConstants();
  const fees = useEffectiveFees();
  const { feeDen: feeDenEntry, error: errorPoolConstants } = useConstants();
  const rent = useRentPosition(user);

  // Les entrées d'un multicall portent leur propre statut : une lecture peut
  // échouer seule, et c'est ce que la maison lit partout ailleurs.
  const currentEpoch = auction.currentEpoch?.status === 'success' ? auction.currentEpoch.result : undefined;
  const sellingEpoch = auction.sellingEpoch?.status === 'success' ? auction.sellingEpoch.result : undefined;
  const currentBid = auction.currentBid?.status === 'success' ? auction.currentBid.result : undefined;
  const highBidder = auction.highBidder?.status === 'success' ? auction.highBidder.result : undefined;
  const windowOpen = auction.windowOpen?.status === 'success' ? auction.windowOpen.result : undefined;
  // Volontairement sans remontée d'erreur : `closesAt()` revert tant qu'aucune
  // mise n'a jamais été posée, et cet échec est un état, pas une panne.
  const closesAt = auction.closesAt?.status === 'success' ? auction.closesAt.result : undefined;

  // Les deux lectures de gestionnaire, et c'est l'arbitrage central du panneau :
  // celui qui exerce MAINTENANT, et celui du mandat mis en vente, qui reste nul
  // jusqu'au règlement même quand l'enchère bat son plein.
  const managerNow = useManagerOf(currentEpoch);
  const managerNext = useManagerOf(sellingEpoch);

  // L'enchère n'est pas déployée : ce n'est pas une erreur de lecture, et
  // afficher six lignes en échec ne dirait rien. Le pool, lui, tourne.
  if (deployedAuction === null) {
    return (
      <section className='min-w-0'>
        <h2 className='text-sm font-semibold pb-2'>Mandat en cours</h2>
        <p className='text-sm'>
          Enchère non déployée sur cette chaîne : le pool trade au tarif nominal,
          aucun mandat n&apos;est vendu.
        </p>
      </section>
    );
  }

  const failedReads = collectReadErrors([
    { message: "Erreur de lecture de l'état de l'enchère", error: auction.error },
    { message: "Erreur de lecture des constantes de l'enchère", error: constants.error },
    { message: "Erreur de lecture du tarif effectif", error: fees.error },
    { message: "Erreur de lecture des constantes du pool", error: errorPoolConstants },
    { message: "Erreur de lecture du gestionnaire en exercice", error: managerNow.error },
    { message: "Erreur de lecture du gestionnaire du mandat vendu", error: managerNext.error },
    { message: "Erreur de lecture de votre position de loyer", error: rent.error }
  ]);
  if (failedReads.length > 0) return <ReadErrors sources={failedReads} />;

  const feeDen = feeDenEntry?.status === 'success' ? feeDenEntry.result : undefined;
  // Le pourcentage se lit en points de base, donc `decimals={2}` rend un
  // pourcentage. Le dénominateur est testé pour sa vérité, pas sa définition :
  // un zéro diviserait par zéro, et le pool serait de toute façon cassé.
  const percentOf = (fee: bigint | undefined) =>
    fee !== undefined && feeDen ? fee * 10000n / feeDen : undefined;

  const clock = now !== null
    && currentEpoch !== undefined
    && sellingEpoch !== undefined
    && windowOpen !== undefined
    && constants.bidSilence !== undefined
    && constants.genesis !== undefined
    && constants.epochDuration !== undefined
      ? readMandateWindow({
          now,
          currentEpoch,
          sellingEpoch,
          windowOpen,
          closesAt,
          bidSilence: constants.bidSilence,
          genesis: constants.genesis,
          epochDuration: constants.epochDuration
        })
      : null;

  const minNextBid = currentBid !== undefined
    && constants.minOpeningBid !== undefined
    && constants.highBidBps !== undefined
    && constants.bpsDen !== undefined
      ? nextMinimumBid({
          highBid: currentBid,
          minOpeningBid: constants.minOpeningBid,
          highBidBps: constants.highBidBps,
          bpsDen: constants.bpsDen
        })
      : undefined;

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

  // La fin du mandat en cours n'est connue que quand une enchère vend bien le
  // mandat suivant ; sinon l'horloge du panneau se tait plutôt que d'inventer.
  const timeLeft = clock ? secondsLeft(clock.countdownTo, now as bigint) : null;

  const managerInOffice = managerNow.data;
  const managerSettled = managerNext.data;
  const hasManagerNow = managerInOffice !== undefined && managerInOffice !== ZERO_ADDRESS;
  const hasManagerNext = managerSettled !== undefined && managerSettled !== ZERO_ADDRESS;
  const hasLeader = highBidder !== undefined && highBidder !== ZERO_ADDRESS;

  return (
    <section className='min-w-0'>
      <h2 className='text-sm font-semibold pb-2'>Mandat en cours</h2>
      <ul className='text-sm'>

        <li>Index du mandat : {currentEpoch === undefined ? "—" : String(currentEpoch)}</li>

        {/* Le gestionnaire en exercice. L'absence est écrite comme un état du
            mécanisme : le mandat n'a pas trouvé preneur, le pool tourne au
            tarif nominal, et tout fonctionne. */}
        <li>
          {hasManagerNow
            ? <>Gestionnaire : {short(managerInOffice)}</>
            : <>Mandat invendu, pool au tarif nominal</>}
        </li>

        <AmountLine
          label="Tarif de base en vigueur"
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
              label="Tarif surchargé (déséquilibre)"
              isLoading={false}
              error={null}
              value={percentOf(fees.worst)}
              decimals={2}
              suffix=" %"
            />
            <li>
              Surcharge active sur : {fees.surcharged.map(([i, j]) => `${nameOf(i)} → ${nameOf(j)}`).join(', ')}
            </li>
          </>
        )}

        <li className='pt-2'>
          Fenêtre d&apos;enchère : {clock ? PHASE_LABEL[clock.phase] : "—"}
          {clock?.inSilence && <> · silence, règlement possible</>}
        </li>

        {clock?.phase === 'open' && closesAt !== undefined && (
          <li>
            Clôture dans {formatCountdown(timeLeft)} (à{' '}
            {new Date(Number(closesAt) * 1000).toLocaleTimeString('fr-FR')})
          </li>
        )}

        {clock?.phase === 'closed' && (
          <li>Prise d&apos;office dans {formatCountdown(timeLeft)}</li>
        )}

        {clock?.phase === 'idle' && (
          <li>La première mise rouvrira l&apos;enchère du mandat suivant.</li>
        )}

        {/* L'arbitrage `highBidder` contre `managerOf` : pendant l'enchère, le
            Pool ne connaît personne, et seul le meneur courant existe. */}
        <li className='pt-2'>
          {hasManagerNext
            ? <>Mandat {String(sellingEpoch)} réglé, gestionnaire : {short(managerSettled)}</>
            : hasLeader
              ? <>Meneur du mandat {String(sellingEpoch)} : {short(highBidder)} (nommé au règlement)</>
              : <>Aucune mise pour le mandat suivant</>}
        </li>

        <AmountLine
          label="Mise en cours"
          isLoading={auction.isLoading}
          error={null}
          value={currentBid}
          decimals={MRN_DECIMALS}
          suffix=" MRN"
        />

        <AmountLine
          label="Mise minimale suivante"
          isLoading={auction.isLoading || constants.isLoading}
          error={null}
          value={minNextBid}
          decimals={MRN_DECIMALS}
          suffix=" MRN"
        />

        {/* Le loyer se lit par adresse : sans connexion, la réponse honnête
            n'est pas zéro. */}
        {user
          ? <AmountLine
              label="Loyer réclamable"
              isLoading={rent.isLoading}
              error={null}
              value={claimable}
              decimals={MRN_DECIMALS}
              suffix=" MRN"
            />
          : <li className='pt-2'>Loyer réclamable : connectez-vous pour le lire.</li>}

      </ul>
    </section>
  );
}
