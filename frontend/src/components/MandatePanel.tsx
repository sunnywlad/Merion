'use client';

import { useState } from 'react';
import { useConnection, useWriteContract, usePublicClient } from 'wagmi';
import { useAuctionState } from '@/hooks/useAuctionState';
import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useEffectiveFees } from '@/hooks/useEffectiveFees';
import { useManagerOf } from '@/hooks/useManagerOf';
import { useManagerFees } from '@/hooks/useManagerFees';
import { useConstants } from '@/hooks/useConstants';
import { useChainNow } from '@/hooks/useChainNow';
import { useMandateTimeline } from '@/hooks/useMandateTimeline';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { poolAbi } from '@/constants/abi';
import { ZERO_ADDRESS } from '@/hooks/_constants';
import { secondsLeft, formatCountdown } from '@/lib/readMandateWindow';
import { short } from '@/lib/formatAddress';
import { describeTxError } from '@/lib/txError';
import { useIsWrongNetwork } from '@/hooks/useIsWrongNetwork';
import { SUPPORTED_CHAINS_LABEL } from '@/components/ui/deployment';
import { formatAmount } from '@/components/ui/formatAmount';
import AmountLine from '@/components/AmountLine';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/Button';
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

  // Fees de gestionnaire dues au connecté (`feesOwed[user][tokenIndex]`).
  // La lecture, l'écriture et l'état du bouton vivent ici parce que
  // l'UI a été déplacée dans le panneau « Current epoch ».
  const publicClient = usePublicClient();
  const { mutateAsync } = useWriteContract();
  const wrongNetwork = useIsWrongNetwork();
  const { pool: deployedPool } = useDeployedChainId();
  const managerFees = useManagerFees(user);
  // Une seule action dans ce panneau : « Collect fees ». Pas de
  // `pending` partagé avec `AuctionPanel` — chaque panneau garde son
  // propre état pour ne pas griser un bouton à distance.
  const [pending, setPending] = useState<'fees' | null>(null);
  const [feesError, setFeesError] = useState<string | null>(null);

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

  // Fees de gestionnaire : total agrégé des trois tokens panier (8
  // décimales, ~1:1 BTC). Le hook rend `undefined` tant que la lecture
  // n'a pas résolu (miroir de `refund.data`).
  const feesOwed = managerFees.total;
  const hasFees = feesOwed !== undefined && feesOwed > 0n;
  // Même rendu mono/groupement français que `formatAmount` utilise pour
  // les montants MRN, en unités BTC.
  const btc = (v: bigint | undefined) =>
    formatAmount(v, { displayDecimals: 8, tokenDecimals: 8, grouping: 'fr' });

  // Réclame TOUTES les fees de gestionnaire dues au connecté, pas un
  // instantané. La boucle re-lit `feesOwed[user][i]` à chaque passe pour
  // rattraper les swaps qui créditent une fee pendant qu'une autre est
  // en train d'être réclamée (autre token, autre bloc). Sans ça, un
  // seul clic laissait une résiduelle — exactement ce que l'utilisateur
  // a observé. Borne `MAX_PASSES` pour ne pas boucler à l'infini sur
  // un contrat buggé qui re-créditerait plus vite qu'on ne vide.
  const MAX_DRAIN_PASSES = 5;
  const handleCollectFees = async () => {
    if (!user || !publicClient || wrongNetwork) return;
    setFeesError(null);
    try {
      setPending('fees');
      for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
        let claimedThisPass = false;
        for (let i = 0; i < 3; i++) {
          // Lecture fraîche on-chain (pas le snapshot du hook) : c'est
          // le point clé du drain.
          const owed = (await publicClient.readContract({
            address: deployedPool!,
            abi: poolAbi,
            functionName: 'feesOwed',
            args: [user!, BigInt(i)]
          })) as bigint;
          if (owed > 0n) {
            const hash = await mutateAsync({
              address: deployedPool!,
              abi: poolAbi,
              functionName: 'claimManagerFees',
              args: [BigInt(i)]
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status !== 'success') {
              throw new Error(`claimManagerFees(${i}) reverted on-chain. Check your wallet for details.`);
            }
            claimedThisPass = true;
          }
        }
        if (!claimedThisPass) break;
      }
      await managerFees.refetch();
    } catch (e) {
      setFeesError(describeTxError(e));
    } finally { setPending(null); }
  };

  // Garde « grisé mais cliquable » alignée sur `AuctionPanel` : on ne
  // pousse l'explication qu'au clic, le bouton reste activé tant que
  // `pending` n'est pas posé.
  const wrongNetMsg = `Wrong network — switch to ${SUPPORTED_CHAINS_LABEL}.`;
  const collectSoftDisabled = !user || wrongNetwork || !hasFees;
  const onCollectClick = () => {
    if (!user) return setFeesError('Connect your wallet to collect fees.');
    if (wrongNetwork) return setFeesError(wrongNetMsg);
    if (!hasFees) return setFeesError('No manager fees to collect.');
    void handleCollectFees();
  };

  return (
    <ReadErrorBoundary
      title="Could not read epoch data"
      description={(msgs) => `Unable to read the epoch. ${msgs.join('; ')}`}
      sources={[
        { message: 'Failed to read the auction state', error: auction.error },
        { message: 'Failed to read the auction constants', error: constants.error },
        { message: 'Failed to read the effective fee', error: fees.error },
        { message: 'Failed to read the pool constants', error: errorPoolConstants },
        { message: 'Failed to read the current manager', error: managerNow.error },
        { message: 'Failed to read the manager fees', error: managerFees.error }
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
        {/* Pied du panneau « Current epoch » : fees de gestionnaire
            dues au connecté. Déplacé ici depuis `AuctionPanel` (où il
            voisinait le remboursement) parce que la mécanique est celle
            de la pool courante, pas celle de l'enchère. */}
        <div className='pt-4 border-t mt-4'>
          <div className='flex items-center justify-between gap-4'>
            <div>
              Fees collected: {user
                ? (feesOwed === undefined ? '—' : <span className='font-mono num-tabular'>{btc(feesOwed)} BTC</span>)
                : 'connect to read'}
            </div>
            <Button
              level="primary"
              onClick={onCollectClick}
              aria-busy={pending === 'fees' || undefined}
              disabled={!user || pending !== null}
              className={collectSoftDisabled ? 'opacity-50 cursor-not-allowed' : ''}>
              {pending === 'fees' ? 'Collection in progress' : 'Collect fees'}
            </Button>
          </div>
          {feesError && <p className='text-xs pt-1 text-danger'>{feesError}</p>}
        </div>
      </Panel>
    </ReadErrorBoundary>
  );
}
