'use client';

import { useState } from 'react';
import { useConnection, useWriteContract, usePublicClient, useReadContract } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { deployedAuction, deployedMrn, deployedPool, MRN_DECIMALS } from '@/constants/addresses';
import { auctionAbi, mrnAbi, poolAbi } from '@/constants/abi';
import { useAuctionState } from '@/hooks/useAuctionState';
import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useConstants } from '@/hooks/useConstants';
import { useManagerOf } from '@/hooks/useManagerOf';
import { useRefund } from '@/hooks/useRefund';
import { useChainNow } from '@/hooks/useChainNow';
import { nextMinimumBid, secondsLeft, formatCountdown } from '@/lib/mandateWindow';
import { parseAmount } from '@/lib/parseAmount';
import { collectReadErrors } from '@/lib/readErrors';
import ReadErrors from '@/components/ReadErrors';
import Panel from '@/components/Panel';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// Bande du gestionnaire : `MAX_FEE_NUM / UNBALANCE_FACTOR`, dérivée côté
// contrat à la volée. Le facteur vit dans le contrat (constant), donc la
// borne supérieure est calculée ici sans nouvelle lecture.
const UNBALANCE_FACTOR = 2n;

// I.6 — Panneau d'enchère : mêmes `Panel`/bordures/champs que le reste de la
// page. Lecture sur les mêmes hooks que `MandatePanel` (I.5), écriture des
// trois actions du contrat.
export default function AuctionPanel() {
  // Voir MandatePanel : `useChainNow` plutôt que `useNow` pour comparer
  // dans le même domaine temporel que `closesAt`, `genesis`, etc.
  const now = useChainNow();
  const user = useConnection().address;
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const { mutateAsync } = useWriteContract();

  const [bidInput, setBidInput] = useState('');
  const [feeInput, setFeeInput] = useState('');
  const [pending, setPending] = useState<'bid' | 'refund' | 'settle' | 'setFee' | null>(null);
  // Une erreur par action, scopée à sa section : une réversion sur `placeBid`
  // ne s'affiche PAS sous le panneau `setFee`, et inversement. Une seule
  // variable partagée traînait sous tous les blocs (cf. capture 2026-08-28).
  const [errors, setErrors] = useState<{
    bid: string | null; refund: string | null; settle: string | null; setFee: string | null;
  }>({ bid: null, refund: null, settle: null, setFee: null });
  const setActionError = (action: 'bid' | 'refund' | 'settle' | 'setFee', message: string | null) =>
    setErrors((prev) => ({ ...prev, [action]: message }));

  const auction = useAuctionState();
  const constants = useAuctionConstants();
  const poolConstants = useConstants();

  const currentEpoch = auction.currentEpoch?.status === 'success' ? auction.currentEpoch.result : undefined;
  const sellingEpoch = auction.sellingEpoch?.status === 'success' ? auction.sellingEpoch.result : undefined;
  const currentBid = auction.currentBid?.status === 'success' ? auction.currentBid.result : undefined;
  const highBidder = auction.highBidder?.status === 'success' ? auction.highBidder.result : undefined;
  const windowOpen = auction.windowOpen?.status === 'success' ? auction.windowOpen.result : undefined;
  const closesAt = auction.closesAt?.status === 'success' ? auction.closesAt.result : undefined;
  const pendingEpoch = auction.pendingEpoch?.status === 'success' ? auction.pendingEpoch.result : undefined;
  const pendingAmount = auction.pendingAmount?.status === 'success' ? auction.pendingAmount.result : undefined;

  const managerNow = useManagerOf(currentEpoch);
  const refund = useRefund(user);

  // `lastSetFeeEpoch` n'a pas besoin du rythme d'enchère : il ne bouge qu'au
  // moment d'un `setFee`, et l'invalidation posée après l'écriture suffit.
  const lastSetFee = useReadContract({
    address: deployedPool,
    abi: poolAbi,
    functionName: 'lastSetFeeEpoch',
    args: []
  });

  if (deployedAuction === null) {
    return (
      <Panel>
        <p className='font-semibold pb-2'>Enchère</p>
        <p>Non déployée sur cette chaîne.</p>
      </Panel>
    );
  }

  const failedReads = collectReadErrors([
    { message: "Erreur de lecture de l'état de l'enchère", error: auction.error },
    { message: "Erreur de lecture des constantes de l'enchère", error: constants.error },
    { message: 'Erreur de lecture du gestionnaire en exercice', error: managerNow.error },
    { message: 'Erreur de lecture du remboursement', error: refund.error }
  ]);
  if (failedReads.length > 0) return <ReadErrors sources={failedReads} />;

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

  // Garde client sur la mise : on NE lance PAS un approve + placeBid si la
  // saisie est sous le plancher calculé. La garde contrat rejette en
  // reversion, mais entre l'approve (qui passe) et le placeBid (qui reverte)
  // le gaz est gaspillé, et pire : la réversion fait crasher l'estimation de
  // gaz, qui retombe sur le plafond EIP-7825 et fait apparaître à l'écran
  // « gas limit exceeds transaction gas cap » au lieu d'un message utile.
  // Valider ici coupe la chaîne avant le premier envoi.
  const parsedBid = parseAmount(bidInput, MRN_DECIMALS);
  const bidBelowMinimum = parsedBid !== null
    && minNextBid !== undefined
    && parsedBid < minNextBid;

  // Règle : un bouton qui cliqueralait sur un revert trivial est grisé.
  // `settle()` reverte `NoBidToSettle()` quand `highBidder == 0` ET
  // `pendingEpoch == 0` ET `pendingAmount == 0`. On désactive dès que
  // AUCUN de ces trois n'est porteur d'une valeur à régler.
  const hasBidToSettle =
    (highBidder !== undefined && highBidder !== ZERO_ADDRESS)
    || (pendingEpoch !== undefined && pendingEpoch > 0n)
    || (pendingAmount !== undefined && pendingAmount > 0n);

  const timeLeft = now !== null && closesAt !== undefined ? secondsLeft(closesAt, now) : null;

  // Démarrage du mandat mis aux enchères : `genesis + sellingEpoch *
  // epochDuration`. La ligne se tait plutôt que d'inventer si l'une des trois
  // lectures manque. C'est le point de convergence entre l'enchère (qui le
  // vend) et le mandat (qui en hérite au règlement) — d'où sa présence ici,
  // pas dans `MandatePanel`.
  const sellingStart = sellingEpoch !== undefined
    && constants.genesis !== undefined
    && constants.epochDuration !== undefined
      ? constants.genesis + sellingEpoch * constants.epochDuration
      : undefined;
  const timeToStart = now !== null && sellingStart !== undefined ? secondsLeft(sellingStart, now) : null;
  const managerInOffice = managerNow.data;
  const hasManagerNow = managerInOffice !== undefined && managerInOffice !== ZERO_ADDRESS;
  const refundOwed = refund.data;
  const hasRefund = refundOwed !== undefined && refundOwed > 0n;

  // Trois conditions pour que le bouton `setFee` devienne actif : connecté,
  // gestionnaire du mandat courant, et dans les `priorityWindow` premières
  // secondes de l'epoch. La garde contrat sur `lastSetFeeEpoch` est ajoutée
  // à part pour éviter un revert visible côté UI.
  // `lastSetFeeEpoch` est un uint32 côté ABI → viem le rend en `number` ; le
  // `BigInt()` réaligne sur le type bigint de `currentEpoch`.
  const lastSetFeeEpoch = lastSetFee.data;
  const feeAlreadySet = currentEpoch !== undefined
    && lastSetFeeEpoch !== undefined
    && BigInt(lastSetFeeEpoch) === currentEpoch;
  const isManagerOfCurrent = hasManagerNow && user !== undefined && managerInOffice === user;
  const inPriorityWindow = now !== null
    && constants.genesis !== undefined
    && constants.epochDuration !== undefined
    && constants.priorityWindow !== undefined
    && constants.epochDuration > 0n
      ? ((now - constants.genesis) % constants.epochDuration) < constants.priorityWindow
      : false;
  const canSetFee = isManagerOfCurrent && inPriorityWindow && !feeAlreadySet;

  // Les lectures de `useConstants` rendent l'union status/result ; on les
  // déplie ici une fois pour ne pas refaire la discrimination à chaque
  // borne affichée.
  const feeDen = poolConstants.feeDen?.status === 'success' ? poolConstants.feeDen.result : undefined;
  const maxFeeNum = poolConstants.maxFeeNum?.status === 'success' ? poolConstants.maxFeeNum.result : undefined;
  const minFeeNum = poolConstants.minFeeNum?.status === 'success' ? poolConstants.minFeeNum.result : undefined;
  const maxManagerFeeNum = maxFeeNum !== undefined ? maxFeeNum / UNBALANCE_FACTOR : undefined;

  const handlePlaceBid = async () => {
    if (!user || !publicClient) return;
    const amount = parseAmount(bidInput, MRN_DECIMALS);
    if (amount === null) { setActionError('bid', 'Montant invalide'); return; }
    setActionError('bid', null);
    try {
      setPending('bid');
      const hashApprove = await mutateAsync({
        address: deployedMrn,
        abi: mrnAbi,
        functionName: 'approve',
        args: [deployedAuction!, amount]
      });
      await publicClient.waitForTransactionReceipt({ hash: hashApprove });

      const hashBid = await mutateAsync({
        address: deployedAuction!,
        abi: auctionAbi,
        functionName: 'placeBid',
        args: [amount]
      });
      await publicClient.waitForTransactionReceipt({ hash: hashBid });
      queryClient.invalidateQueries();
      setBidInput('');
    } catch (e) {
      setActionError('bid', e instanceof Error ? e.message : String(e));
    } finally { setPending(null); }
  };

  const handleWithdrawRefund = async () => {
    if (!user || !publicClient) return;
    setActionError('refund', null);
    try {
      setPending('refund');
      const hash = await mutateAsync({
        address: deployedAuction!,
        abi: auctionAbi,
        functionName: 'withdrawRefund',
        args: []
      });
      await publicClient.waitForTransactionReceipt({ hash });
      queryClient.invalidateQueries();
    } catch (e) {
      setActionError('refund', e instanceof Error ? e.message : String(e));
    } finally { setPending(null); }
  };

  const handleSettle = async () => {
    if (!user || !publicClient) return;
    setActionError('settle', null);
    try {
      setPending('settle');
      const hash = await mutateAsync({
        address: deployedAuction!,
        abi: auctionAbi,
        functionName: 'settle',
        args: []
      });
      await publicClient.waitForTransactionReceipt({ hash });
      queryClient.invalidateQueries();
    } catch (e) {
      setActionError('settle', e instanceof Error ? e.message : String(e));
    } finally { setPending(null); }
  };

  // `setFee` ne déplace aucun token : pas d'`approve`. Le tarif est saisi en
  // pourcentage et converti en `feeNum` à deux décimales (5 bp → 5).
  const handleSetFee = async () => {
    if (!user || !publicClient) return;
    const feeNum = parseAmount(feeInput, 2);
    if (feeNum === null) { setActionError('setFee', 'Tarif invalide'); return; }
    setActionError('setFee', null);
    try {
      setPending('setFee');
      const hash = await mutateAsync({
        address: deployedPool,
        abi: poolAbi,
        functionName: 'setFee',
        args: [feeNum]
      });
      await publicClient.waitForTransactionReceipt({ hash });
      queryClient.invalidateQueries();
      setFeeInput('');
    } catch (e) {
      setActionError('setFee', e instanceof Error ? e.message : String(e));
    } finally { setPending(null); }
  };

  return (
    <Panel>
      <p className='font-semibold pb-2'>Enchère pour le mandat suivant</p>

      <div>Mandat mis aux enchères : {sellingEpoch === undefined ? '—' : String(sellingEpoch)}</div>
      <div>Fenêtre : {windowOpen === undefined ? '—' : (windowOpen ? 'ouverte' : 'fermée')}</div>
      {windowOpen && closesAt !== undefined && (
        <div>Clôture dans {formatCountdown(timeLeft)}</div>
      )}
      <div>Mise haute : {currentBid === undefined ? '—' : `${formatUnits(currentBid, MRN_DECIMALS)} MRN`}</div>
      <div>Enchérisseur en tête : {highBidder && highBidder !== ZERO_ADDRESS ? highBidder : '(aucun)'}</div>
      <div>Mise minimale suivante : {minNextBid === undefined ? '—' : `${formatUnits(minNextBid, MRN_DECIMALS)} MRN`}</div>
      <div>
        Mandat à settle : {pendingEpoch !== undefined && pendingEpoch > 0n
          ? `#${pendingEpoch} (${formatUnits(pendingAmount ?? 0n, MRN_DECIMALS)} MRN)`
          : '(aucun)'}
      </div>
      {timeToStart !== null && (
        <div>Démarre dans {formatCountdown(timeToStart)}</div>
      )}
      <div>
        Remboursement réclamable : {user
          ? (refundOwed === undefined ? '—' : `${formatUnits(refundOwed, MRN_DECIMALS)} MRN`)
          : 'connectez-vous pour le lire'}
      </div>

      <div className='flex flex-wrap gap-4 items-center pt-4'>
        <label htmlFor="auction-bid">Miser (MRN) : </label>
        <input
          id="auction-bid"
          type="text"
          className='px-2 border rounded flex-1 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed'
          value={bidInput}
          disabled={pending !== null}
          onChange={(e) => { setBidInput(e.target.value); setActionError('bid', null); }}
        />
        <button
          className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
          onClick={handlePlaceBid}
          disabled={!user || pending !== null || bidInput === '' || bidBelowMinimum || windowOpen !== true}>
          {pending === 'bid' ? 'Approve + mise en cours' : 'Approuver et miser'}
        </button>
      </div>
      {bidBelowMinimum && minNextBid !== undefined && (
        <p className='text-xs pt-1'>
          Mise trop basse : minimum {formatUnits(minNextBid, MRN_DECIMALS)} MRN.
        </p>
      )}
      {windowOpen === false && (
        <p className='text-xs pt-1'>
          {currentBid !== undefined && currentBid > 0n
            ? <>Fenêtre fermée : gestionnaire {pendingEpoch !== undefined && pendingEpoch > 0n ? 'désigné' : 'à settle'}</>
            // Cas « aucune enchère en cours, fenêtre fermée ». La fermeture
            // a deux causes temporelles distinctes sous la meme UI :
            //   (1) AVANT l'ouverture : `now < startOfEpoch(sellingEpoch - 1)`
            //       — le créneau n'a pas encore commencé ;
            //   (2) APRES la fermeture : `now >= closesAt`
            //       — le créneau est fini sans enchérisseur.
            // Dans les deux cas, `placeBid` revert `WindowClosed` et le
            // bouton est désactivé par `windowOpen !== true`. Inviter à
            // attendre la prochaine epoch, pas à miser maintenant.
            : <>Enchère inactive, fenêtre fermée : attendez la prochaine epoch pour miser</>}
        </p>
      )}
      {errors.bid && <p className='text-xs pt-1 text-red-700'>{errors.bid}</p>}

      <div className='pt-2'>
        <button
          className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
          onClick={handleWithdrawRefund}
          disabled={!user || pending !== null || !hasRefund}>
          {pending === 'refund' ? 'Retrait en cours' : 'Retirer mon remboursement'}
        </button>
      </div>
      {errors.refund && <p className='text-xs pt-1 text-red-700'>{errors.refund}</p>}

      <div className='pt-2'>
        <button
          className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
          onClick={handleSettle}
          disabled={!user || pending !== null || !hasBidToSettle}>
          {pending === 'settle' ? 'Règlement en cours' : 'Régler (settle)'}
        </button>
      </div>
      {!hasBidToSettle && (
        <p className='text-xs pt-1'>
          Aucune enchère à régler : la première mise ouvre le créneau.
        </p>
      )}
      {errors.settle && <p className='text-xs pt-1 text-red-700'>{errors.settle}</p>}

      {/* Bloc setFee : toujours présent pour signaler la mécanique, grisé
          tant que l'utilisateur n'est pas gestionnaire dans la fenêtre de
          priorité du mandat courant. La raison de la désactivation est
          nommée à côté du bouton pour ne pas laisser l'utilisateur deviner. */}
      <div className='pt-4 border-t mt-4'>
        <p className='font-semibold pb-2'>Tarif du gestionnaire</p>
        <div className='flex flex-wrap gap-4 items-center'>
          <label htmlFor="auction-setfee">Tarif (%) : </label>
          <input
            id="auction-setfee"
            type="text"
            className='px-2 border rounded flex-1 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed'
            value={feeInput}
            disabled={!canSetFee || pending !== null}
            onChange={(e) => { setFeeInput(e.target.value); setActionError('setFee', null); }}
          />
          <button
            className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
            onClick={handleSetFee}
            disabled={!canSetFee || pending !== null || feeInput === ''}>
            {pending === 'setFee' ? 'Application du tarif' : 'Fixer le tarif'}
          </button>
        </div>
        <p className='text-xs pt-1'>
          {minFeeNum !== undefined && maxManagerFeeNum !== undefined
            ? <>Borne : {String(minFeeNum / 100n)} % — {String(maxManagerFeeNum / 100n)} %</>
            : 'Bornes en cours de lecture…'}
        </p>
        <p className='text-xs'>
          {!user
            ? 'Connectez-vous pour agir.'
            : !isManagerOfCurrent
              ? 'Sourde tant que vous n’êtes pas gestionnaire du mandat courant.'
              : feeAlreadySet
                ? 'Tarif déjà fixé pour ce mandat.'
                : !inPriorityWindow
                  ? 'Fenêtre de priorité fermée : agissez dans les premières secondes de l’époque.'
                  : 'Fenêtre de priorité ouverte.'}
        </p>
        {errors.setFee && <p className='text-xs pt-1 text-red-700'>{errors.setFee}</p>}
      </div>
    </Panel>
  );
}
