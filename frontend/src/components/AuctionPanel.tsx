'use client';

import { useState } from 'react';
import { useConnection, useWriteContract, usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { deployedAuction, deployedMrn, MRN_DECIMALS } from '@/constants/addresses';
import { auctionAbi, mrnAbi } from '@/constants/abi';
import { useAuctionState } from '@/hooks/useAuctionState';
import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useManagerOf } from '@/hooks/useManagerOf';
import { useRefund } from '@/hooks/useRefund';
import { useNow } from '@/hooks/useNow';
import { nextMinimumBid, secondsLeft, formatCountdown } from '@/lib/mandateWindow';
import { parseAmount } from '@/lib/parseAmount';
import { collectReadErrors } from '@/lib/readErrors';
import ReadErrors from '@/components/ReadErrors';
import Panel from '@/components/Panel';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// I.6 — Panneau d'enchère : mêmes `Panel`/bordures/champs que le reste de la
// page. Lecture sur les mêmes hooks que `MandatePanel` (I.5), écriture des
// trois actions du contrat.
export default function AuctionPanel() {
  const now = useNow();
  const user = useConnection().address;
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const { mutateAsync } = useWriteContract();

  const [bidInput, setBidInput] = useState('');
  const [pending, setPending] = useState<'bid' | 'refund' | 'settle' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const auction = useAuctionState();
  const constants = useAuctionConstants();

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

  const timeLeft = now !== null && closesAt !== undefined ? secondsLeft(closesAt, now) : null;
  const managerInOffice = managerNow.data;
  const hasManagerNow = managerInOffice !== undefined && managerInOffice !== ZERO_ADDRESS;
  const refundOwed = refund.data;
  const hasRefund = refundOwed !== undefined && refundOwed > 0n;

  const handlePlaceBid = async () => {
    if (!user || !publicClient) return;
    const amount = parseAmount(bidInput, MRN_DECIMALS);
    if (amount === null) { setError('Montant invalide'); return; }
    setError(null);
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
      setError(e instanceof Error ? e.message : String(e));
    } finally { setPending(null); }
  };

  const handleWithdrawRefund = async () => {
    if (!user || !publicClient) return;
    setError(null);
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
      setError(e instanceof Error ? e.message : String(e));
    } finally { setPending(null); }
  };

  const handleSettle = async () => {
    if (!user || !publicClient) return;
    setError(null);
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
      setError(e instanceof Error ? e.message : String(e));
    } finally { setPending(null); }
  };

  return (
    <Panel>
      <p className='font-semibold pb-2'>Enchère</p>

      <div>Mandat en vente : {sellingEpoch === undefined ? '—' : String(sellingEpoch)}</div>
      <div>
        Gestionnaire du mandat courant : {hasManagerNow ? managerInOffice : '(aucun, tarif nominal)'}
      </div>
      <div>Fenêtre : {windowOpen === undefined ? '—' : (windowOpen ? 'ouverte' : 'fermée')}</div>
      {windowOpen && closesAt !== undefined && (
        <div>Clôture dans {formatCountdown(timeLeft)}</div>
      )}
      <div>Mise haute : {currentBid === undefined ? '—' : `${formatUnits(currentBid, MRN_DECIMALS)} MRN`}</div>
      <div>Enchérisseur en tête : {highBidder && highBidder !== ZERO_ADDRESS ? highBidder : '(aucun)'}</div>
      <div>Mise minimale suivante : {minNextBid === undefined ? '—' : `${formatUnits(minNextBid, MRN_DECIMALS)} MRN`}</div>
      <div>
        Mandat en attente de règlement : {pendingEpoch !== undefined && pendingEpoch > 0n
          ? `#${pendingEpoch} (${formatUnits(pendingAmount ?? 0n, MRN_DECIMALS)} MRN)`
          : '(aucun)'}
      </div>
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
          onChange={(e) => { setBidInput(e.target.value); setError(null); }}
        />
        <button
          className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
          onClick={handlePlaceBid}
          disabled={!user || pending !== null || bidInput === ''}
        >
          {pending === 'bid' ? 'Approve + mise en cours' : 'Approuver et miser'}
        </button>
      </div>

      <div className='pt-2'>
        <button
          className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
          onClick={handleWithdrawRefund}
          disabled={!user || pending !== null || !hasRefund}>
          {pending === 'refund' ? 'Retrait en cours' : 'Retirer mon remboursement'}
        </button>
      </div>

      <div className='pt-2'>
        <button
          className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
          onClick={handleSettle}
          disabled={!user || pending !== null}>
          {pending === 'settle' ? 'Règlement en cours' : 'Régler (settle)'}
        </button>
      </div>

      {error && <p>{error}</p>}
    </Panel>
  );
}
