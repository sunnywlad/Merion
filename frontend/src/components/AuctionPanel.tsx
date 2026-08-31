'use client';

import { useState, type ReactNode } from 'react';
import { useConnection, useWriteContract, usePublicClient, useReadContract } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { MRN_DECIMALS } from '@/constants/addresses';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { auctionAbi, mrnAbi, poolAbi } from '@/constants/abi';
import { useAuctionState } from '@/hooks/useAuctionState';
import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useConstants } from '@/hooks/useConstants';
import { useEffectiveFees } from '@/hooks/useEffectiveFees';
import { useManagerOf } from '@/hooks/useManagerOf';
import { useRefund } from '@/hooks/useRefund';
import { useManagerFees } from '@/hooks/useManagerFees';
import { useChainNow } from '@/hooks/useChainNow';
import { nextMinimumBid, secondsLeft, formatCountdown } from '@/lib/readMandateWindow';
import { parseAmount } from '@/lib/parseAmount';
import { formatAmount } from '@/components/ui/formatAmount';
import { describeTxError } from '@/lib/txError';
import { useIsWrongNetwork } from '@/hooks/useIsWrongNetwork';
import { SUPPORTED_CHAINS_LABEL } from '@/components/ui/deployment';
import Panel from '@/components/Panel';
import { Button } from '@/components/ui/Button';
import { ReadErrorBoundary } from '@/components/ui/ReadErrorBoundary';
import { ZERO_ADDRESS } from '@/hooks/_constants';

// Bande du gestionnaire : `MAX_FEE_NUM / UNBALANCE_FACTOR`, dérivée côté
// contrat à la volée. Le facteur vit dans le contrat (constant), donc la
// borne supérieure est calculée ici sans nouvelle lecture.
const UNBALANCE_FACTOR = 2n;

// Colonne de chiffres : mêmes classes que la valeur d'`AmountLine`
// (mono, `text-code`, tabular-nums), pour un corps de chiffre identique
// à « Base fee » dans « Current epoch ».
const Num = ({ children }: { children: ReactNode }) => (
  <span className='font-mono text-code num-tabular'>{children}</span>
);

// I.6 — Panneau d'enchère : mêmes `Panel`/bordures/champs que le reste de la
// page. Lecture sur les mêmes hooks que `MandatePanel` (I.5), écriture des
// trois actions du contrat.
export default function AuctionPanel() {
  // Voir MandatePanel : `useChainNow` plutôt que `useNow` pour comparer
  // dans le même domaine temporel que `closesAt`, `genesis`, etc.
  const now = useChainNow();
  const user = useConnection().address;
  const wrongNetwork = useIsWrongNetwork();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const { mutateAsync } = useWriteContract();
  const { auction: deployedAuction, mrn: deployedMrn, pool: deployedPool } = useDeployedChainId();

  const [bidInput, setBidInput] = useState('');
  const [feeInput, setFeeInput] = useState('');
  const [pending, setPending] = useState<'bid' | 'refund' | 'settle' | 'setFee' | 'fees' | null>(null);
  // Une erreur par action, scopée à sa section : une réversion sur `placeBid`
  // ne s'affiche PAS sous le panneau `setFee`, et inversement. Une seule
  // variable partagée traînait sous tous les blocs (cf. capture).
  const [errors, setErrors] = useState<{
    bid: string | null; refund: string | null; settle: string | null; setFee: string | null; fees: string | null;
  }>({ bid: null, refund: null, settle: null, setFee: null, fees: null });
  const setActionError = (action: 'bid' | 'refund' | 'settle' | 'setFee' | 'fees', message: string | null) =>
    setErrors((prev) => ({ ...prev, [action]: message }));

  const auction = useAuctionState();
  const constants = useAuctionConstants();
  const poolConstants = useConstants();
  // Perf G — `queryKey` consommé par `setFee` pour invalider
  // `effectiveFeeNum` (consommé par Swap/AuctionBar/MandatePanel) sans
  // tirer `useConstants` (`staleTime:Infinity`, immuable).
  const fees = useEffectiveFees();

  const currentEpoch = auction.currentEpoch?.status === 'success' ? auction.currentEpoch.result : undefined;
  const sellingEpoch = auction.sellingEpoch?.status === 'success' ? auction.sellingEpoch.result : undefined;
  const currentBid = auction.currentBid?.status === 'success' ? auction.currentBid.result : undefined;
  const highBidder = auction.highBidder?.status === 'success' ? auction.highBidder.result : undefined;
  const windowOpen = auction.windowOpen?.status === 'success' ? auction.windowOpen.result : undefined;
  const closesAt = auction.closesAt?.status === 'success' ? auction.closesAt.result : undefined;
  const pendingEpoch = auction.pendingEpoch?.status === 'success' ? auction.pendingEpoch.result : undefined;
  const pendingAmount = auction.pendingAmount?.status === 'success' ? auction.pendingAmount.result : undefined;

  const managerNow = useManagerOf(currentEpoch);
  // Le gestionnaire nommé pour le mandat mis en vente (`currentEpoch + 1`).
  // C'est LA source de vérité sur le gagnant après un `settle()` : ce dernier
  // remet à zéro `highBidder`/`currentBid`/`pendingEpoch`/`pendingAmount`, donc
  // le vainqueur ne survit que dans `pool.managerOf(soldMandate)`.
  const managerSold = useManagerOf(currentEpoch !== undefined ? currentEpoch + 1n : undefined);
  const refund = useRefund(user);
  // Fees de gestionnaire dues au connecté (`feesOwed[user][tokenIndex]`),
  // lues sur les trois tokens panier. Miroir de `refund` : seul le
  // connecté peut réclamer ses propres fees (`claimManagerFees` est
  // indexé sur `msg.sender`).
  const managerFees = useManagerFees(user);

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
        <p className='font-semibold pb-2'>Auction</p>
        <p>Not deployed on this chain.</p>
      </Panel>
    );
  }

  // R3/B.3 — Unification avec les 5 autres sites : on passe la borne
  // d'erreur via `<ReadErrorBoundary>`, qui rend `AppStateBoundary`.
  // Les sources lisent les hooks consommés en tête de composant, le
  // panneau entier est gardé par la borne.

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

  // Ce que l'appelant de `settle()` empoche : `SETTLE_REWARD_BPS` (10 bps)
  // sur la part LP, elle-même 70 % de la mise (les 30 % restants sont
  // brûlés). Base = le slot pending s'il est rempli, sinon l'enchère vive
  // qui sera capturée.
  const settleBase = pendingAmount !== undefined && pendingAmount > 0n
    ? pendingAmount
    : (currentBid ?? 0n);
  const settleReward = (settleBase * 7000n / 10000n) * 10n / 10000n;

  // `minFeeNum` / `maxManagerFeeNum` sont des numérateurs à deux décimales
  // de pourcent (5 → 0,05 %). La division bigint par 100 tronquait tout à
  // 0 ; on repasse en nombre pour garder les décimales.
  const fmtFeePct = (n: bigint) => `${(Number(n) / 100).toFixed(2).replace('.', ',')} %`;

  // Montants MRN : même rendu que le rail (mono, groupement français, deux
  // décimales tronquées). `formatAmount` rend '—' pour `undefined`.
  const mrn = (v: bigint | undefined) =>
    formatAmount(v, { displayDecimals: 2, tokenDecimals: MRN_DECIMALS, grouping: 'fr' });
  // Fees de gestionnaire en tokens panier (8 décimales, ~1:1 BTC) : même
  // rendu mono/groupement français que `mrn`, mais en unités BTC.
  const btc = (v: bigint | undefined) =>
    formatAmount(v, { displayDecimals: 8, tokenDecimals: 8, grouping: 'fr' });

  const timeLeft = now !== null && closesAt !== undefined ? secondsLeft(closesAt, now) : null;

  // `windowOpen()` du contrat rend `false` tant que `sellingEpoch != currentEpoch()+1`,
  // donc AUSSI à l'état vierge (`sellingEpoch == 0`) et après un `settle`, tant que
  // personne n'a rouvert le cycle. Or `placeBid` rouvre le slot lui-même : la vraie
  // borne de la première mise d'un cycle est `now < startOfEpoch(currentEpoch) +
  // auctionWindow`, soit les `auctionWindow` premières secondes de l'epoch courante.
  // Sans cette dérivation, le bouton restait grisé pour la mise qui ouvre justement
  // le créneau, et aucune enchère ne pouvait jamais démarrer depuis l'UI.
  const firstBidWindowOpen = now !== null
    && currentEpoch !== undefined
    && sellingEpoch !== undefined
    && sellingEpoch !== currentEpoch + 1n
    && constants.genesis !== undefined
    && constants.epochDuration !== undefined
    && constants.auctionWindow !== undefined
      ? now < constants.genesis + currentEpoch * constants.epochDuration + constants.auctionWindow
      : false;
  const canPlaceBid = windowOpen === true || firstBidWindowOpen;

  // `settle()` reverte `WindowStillOpen(closes)` tant que la fenêtre
  // d'enchère n'est pas écoulée (`Auction.sol:396`). On masque la ligne
  // « Settle for X MRN » et on grise le bouton tant que `canPlaceBid` est
  // vrai, pour éviter une transaction vouée au revert et le message d'erreur
  // RPC trompeur qui suit (« The node could not be reached »).
  const canSettle = !canPlaceBid && hasBidToSettle;

  // Le mandat mis en vente est toujours `currentEpoch + 1`, qu'une mise ait
  // déjà ouvert le créneau (`sellingEpoch == currentEpoch + 1`) ou non
  // (`sellingEpoch` encore à zéro, une mise le rouvrira). Utiliser
  // `sellingEpoch` brut affichait 0 et bloquait le décompte à l'état vierge.
  const soldMandate = currentEpoch !== undefined ? currentEpoch + 1n : undefined;
  const managerInOffice = managerNow.data;
  const hasManagerNow = managerInOffice !== undefined && managerInOffice !== ZERO_ADDRESS;
  const refundOwed = refund.data;
  const hasRefund = refundOwed !== undefined && refundOwed > 0n;

  const feesOwed = managerFees.total;
  const hasFees = feesOwed !== undefined && feesOwed > 0n;

  // Après `settle()`, les slots vivants sont à zéro : le seul survivant du
  // gagnant est `pool.managerOf(soldMandate)`. On lit ce gestionnaire pour
  // récupérer le vainqueur une fois les slots effacés, et on retombe sur le
  // `highBidder` vivant tant que l'enchère bat encore.
  const settledWinner = managerSold.data !== undefined && managerSold.data !== ZERO_ADDRESS
    ? managerSold.data
    : undefined;
  const liveTopBidder = highBidder !== undefined && highBidder !== ZERO_ADDRESS
    ? highBidder
    : undefined;
  const winningBidder = liveTopBidder ?? settledWinner;
  const isSettledWinner = !liveTopBidder && settledWinner !== undefined;
  const youWon = user !== undefined && winningBidder !== undefined && winningBidder === user;

  // « Vous avez gagné mais personne n'a réglé » : le reset de slot a capturé
  // un `pendingBidder` non nul (état en attente), OU le meneur vivant est vous
  // et la fenêtre est déjà fermée (le `settle()` est la prochaine étape).
  const pendingWinnerIsYou =
    auction.pendingBidder?.status === 'success'
    && auction.pendingBidder.result !== undefined
    && auction.pendingBidder.result !== ZERO_ADDRESS
    && user !== undefined
    && auction.pendingBidder.result === user;
  const liveWinnerIsYou = liveTopBidder !== undefined && user !== undefined && liveTopBidder === user;
  const youWonUnsettled = pendingWinnerIsYou || (liveWinnerIsYou && !canPlaceBid);

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
  const maxFeeNum = poolConstants.maxFeeNum?.status === 'success' ? poolConstants.maxFeeNum.result : undefined;
  const minFeeNum = poolConstants.minFeeNum?.status === 'success' ? poolConstants.minFeeNum.result : undefined;
  const maxManagerFeeNum = maxFeeNum !== undefined ? maxFeeNum / UNBALANCE_FACTOR : undefined;

  const handlePlaceBid = async () => {
    if (!user || !publicClient || wrongNetwork) return;
    const amount = parseAmount(bidInput, MRN_DECIMALS);
    if (amount === null) { setActionError('bid', 'Invalid amount'); return; }
    setActionError('bid', null);
    try {
      setPending('bid');
      const hashApprove = await mutateAsync({
        address: deployedMrn,
        abi: mrnAbi,
        functionName: 'approve',
        args: [deployedAuction!, amount]
      });
      // `waitForTransactionReceipt` rend
      // le receipt avec `status: 'reverted'` SANS throw. Sans ce check,
      // le `placeBid` qui suit tape allowance == 0 et surfaçe « Allowance
      // too low », message qui désigne la mise comme coupable alors que
      // l'approve a déjà foiré en amont. Meme garde que dans Swap/
      // AddLiquidity/RemoveLiquidity.
      const receiptApprove = await publicClient.waitForTransactionReceipt({ hash: hashApprove });
      if (receiptApprove.status !== 'success') {
        throw new Error('Approve transaction reverted on-chain. Check your wallet for details.');
      }

      const hashBid = await mutateAsync({
        address: deployedAuction!,
        abi: auctionAbi,
        functionName: 'placeBid',
        args: [amount]
      });
      // Meme garde pour le write : un
      // `placeBid` reverte silencieusement (bond trop court, auction
      // fermée en coulisses, etc.) sinon l'invalidation tourne sur du
      // faux état et l'UI reste sur l'enchère pre-write.
      const receiptBid = await publicClient.waitForTransactionReceipt({ hash: hashBid });
      if (receiptBid.status !== 'success') {
        throw new Error('placeBid transaction reverted on-chain. Check your wallet for details.');
      }
      // Perf G — invalidation ciblée de l'enchère seulement
      // (`currentBid`, `highBidder`, `pendingEpoch`, `pendingAmount`,
      // `windowOpen`, `closesAt`) ; `useConstants`/`useAuctionConstants`
      // ont `staleTime:Infinity` et ne bougent pas, on ne les réveille
      // pas. Pattern aligné sur `Swap.tsx:256`.
      await queryClient.invalidateQueries({ queryKey: auction.queryKey });
      setBidInput('');
    } catch (e) {
      setActionError('bid', describeTxError(e));
    } finally { setPending(null); }
  };

  const handleWithdrawRefund = async () => {
    if (!user || !publicClient || wrongNetwork) return;
    setActionError('refund', null);
    try {
      setPending('refund');
      const hash = await mutateAsync({
        address: deployedAuction!,
        abi: auctionAbi,
        functionName: 'withdrawRefund',
        args: []
      });
      // Meme garde que pour les autres
      // writes : un `withdrawRefund` reverte silencieusement (no refund
      // owed sur une race) sinon le `refund.refetch()` qui suit tourne
      // sur du faux état et l'UI laisse le montant affiché.
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error('withdrawRefund transaction reverted on-chain. Check your wallet for details.');
      }
      // Perf G — `withdrawRefund` ne touche que le `refunds(user)` du
      // caller ; le reste de la chaîne n'a pas bougé.
      await refund.refetch();
    } catch (e) {
      setActionError('refund', describeTxError(e));
    } finally { setPending(null); }
  };

  // Réclame les fees de gestionnaire dues au connecté. `feesOwed` est
  // scindé par token panier (index 0/1/2) et `claimManagerFees` ne prend
  // qu'un token à la fois → on balaye les trois et on ne tire que les
  // tokens non vides (le contrat reverte `ZeroFeesOwed` sinon). Une seule
  // lecture `refetch` à la fin rafraîchit l'ensemble.
  const handleCollectFees = async () => {
    if (!user || !publicClient || wrongNetwork) return;
    setActionError('fees', null);
    try {
      setPending('fees');
      for (let i = 0; i < managerFees.perToken.length; i++) {
        if (managerFees.perToken[i] > 0n) {
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
        }
      }
      await managerFees.refetch();
    } catch (e) {
      setActionError('fees', describeTxError(e));
    } finally { setPending(null); }
  };

  const handleSettle = async () => {
    if (!user || !publicClient || wrongNetwork) return;
    setActionError('settle', null);
    try {
      setPending('settle');
      const hash = await mutateAsync({
        address: deployedAuction!,
        abi: auctionAbi,
        functionName: 'settle',
        args: []
      });
      // Meme garde : `settle` peut reverter
      // silencieusement (NoBidToSettle sur race epoch). Sans ce check,
      // les trois refetch qui suivent tournent sur du faux état (mandat
      // pas transitionné, refunds non crédités) et l'UI s'aligne sur le
      // mensonge.
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error('settle transaction reverted on-chain. Check your wallet for details.');
      }
      // Perf G — `settle` transitionne le mandat : l'enchère passe à
      // l'epoch suivante, un nouveau gestionnaire est nommé, et les
      // bidders perdants sont crédités. Trois refetch ciblés.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: auction.queryKey }),
        managerNow.refetch(),
        managerSold.refetch(),
        refund.refetch()
      ]);
    } catch (e) {
      setActionError('settle', describeTxError(e));
    } finally { setPending(null); }
  };

  // `setFee` ne déplace aucun token : pas d'`approve`. Le tarif est saisi en
  // pourcentage et converti en `feeNum` à deux décimales (5 bp → 5).
  const handleSetFee = async () => {
    if (!user || !publicClient || wrongNetwork) return;
    const feeNum = parseAmount(feeInput, 2);
    if (feeNum === null) { setActionError('setFee', 'Invalid fee'); return; }
    setActionError('setFee', null);
    try {
      setPending('setFee');
      const hash = await mutateAsync({
        address: deployedPool,
        abi: poolAbi,
        functionName: 'setFee',
        args: [feeNum]
      });
      // Meme garde : `setFee` peut reverter
      // silencieusement (priority window expirée en coulisses entre
      // l'activation UI et l'envoi, fee déjà posée cette epoch, etc.).
      // Sans ce check, l'invalidation `effectiveFeeNum` qui suit
      // survole le mensonge et Swap/MandatePanel affichent l'ancien
      // tarif comme encore en vigueur.
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error('setFee transaction reverted on-chain. Check your wallet for details.');
      }
      // Perf G — `setFee` ne change que `feeNum` et `lastSetFeeEpoch` :
      // on réveille le multicall `effectiveFeeNum` (consommé ailleurs
      // par Swap/AuctionBar/MandatePanel) et la lecture locale
      // `lastSetFeeEpoch`. Les immuables (`useConstants`,
      // `useAuctionConstants`) ont `staleTime:Infinity` et n'ont rien
      // à faire ici.
      //
      // `invalidateQueries` marquait la query stale sans forcément la
      // ré-exécuter (react-query attendait un consommateur ou la fin du
      // `staleTime`) : le panel et le bouton restaient sur l'état
      // d'avant. `refetch()` force la lecture tout de suite et résout
      // une promesse avec les données fraîches — c'est ce qui remet
      // `Base fee` à 0,20 % et grise le bouton dans la foulée.
      await Promise.all([
        fees.refetch(),
        lastSetFee.refetch()
      ]);
      setFeeInput('');
    } catch (e) {
      setActionError('setFee', describeTxError(e));
    } finally { setPending(null); }
  };

  // Boutons « grisés mais cliquables » : plutôt qu'afficher en permanence
  // la raison du blocage sous chaque bouton, on ne la montre qu'au clic.
  // Le bouton n'est réellement `disabled` que pendant une transaction ;
  // sinon il reste cliquable, l'aspect grisé vient de `aria-disabled` +
  // opacité, et le handler ci-dessous pose l'explication dans `errors`.
  const wrongNetMsg = `Wrong network — switch to ${SUPPORTED_CHAINS_LABEL}.`;

  const bidSoftDisabled =
    !user || wrongNetwork || bidInput === '' || bidBelowMinimum || !canPlaceBid;
  const onBidClick = () => {
    if (!user) return setActionError('bid', 'Connect your wallet to bid.');
    if (wrongNetwork) return setActionError('bid', wrongNetMsg);
    if (bidInput === '') return setActionError('bid', 'Enter a bid amount.');
    if (!canPlaceBid)
      return setActionError('bid', 'Auction inactive, window closed: wait for the next epoch to bid.');
    if (bidBelowMinimum && minNextBid !== undefined)
      return setActionError('bid', `Bid too low: minimum ${formatUnits(minNextBid, MRN_DECIMALS)} MRN.`);
    void handlePlaceBid();
  };

  const settleSoftDisabled = !user || wrongNetwork || !canSettle;
  const onSettleClick = () => {
    if (!user) return setActionError('settle', 'Connect your wallet to settle.');
    if (wrongNetwork) return setActionError('settle', wrongNetMsg);
    if (canPlaceBid)
      return setActionError('settle', 'Auction still open, wait for the window to close before settling.');
    if (!hasBidToSettle)
      return setActionError('settle', 'Nothing to settle right now: no winning bid is awaiting nomination.');
    void handleSettle();
  };

  const setFeeSoftDisabled =
    !user || wrongNetwork || !isManagerOfCurrent || feeAlreadySet || !inPriorityWindow || feeInput === '';
  const onSetFeeClick = () => {
    if (!user) return setActionError('setFee', 'Connect your wallet to set the fee.');
    if (wrongNetwork) return setActionError('setFee', wrongNetMsg);
    if (!isManagerOfCurrent)
      return setActionError('setFee', 'Inactive until you are the manager of the current epoch.');
    if (feeAlreadySet) return setActionError('setFee', 'Fee already set for this epoch.');
    if (!inPriorityWindow)
      return setActionError('setFee', 'Priority window closed: act within the first seconds of the epoch.');
    if (feeInput === '') return setActionError('setFee', 'Enter a fee percentage.');
    void handleSetFee();
  };

  return (
    <ReadErrorBoundary
      title="Could not read auction data"
      description={(msgs) => `Unable to read the auction. ${msgs.join('; ')}`}
      sources={[
        { message: 'Failed to read the auction state', error: auction.error },
        { message: 'Failed to read the auction constants', error: constants.error },
        { message: 'Failed to read the current manager', error: managerNow.error },
        { message: 'Failed to read the sold mandate manager', error: managerSold.error },
        { message: 'Failed to read the refund', error: refund.error },
        { message: 'Failed to read the manager fees', error: managerFees.error }
      ]}
    >
      <Panel title={`Auction for epoch ${soldMandate === undefined ? '#—' : `#${String(soldMandate)}`}`}>
      {wrongNetwork && (
        <p className='text-small text-danger pb-3' role='alert'>
          Wrong network, switch to {SUPPORTED_CHAINS_LABEL} to bid, settle or claim.
        </p>
      )}

      <div>Window: {windowOpen === undefined ? '—' : (canPlaceBid ? 'open' : 'closed')}</div>
      {windowOpen && closesAt !== undefined && (
        <div>Closes in <Num>{formatCountdown(timeLeft)}</Num></div>
      )}
      <div>High bid: {currentBid === undefined || currentBid === 0n
        ? (isSettledWinner ? 'settled' : '—')
        : <Num>{mrn(currentBid)} MRN</Num>}</div>
      <div>Won by: {winningBidder === undefined
        ? '—'
        : (youWon
            ? <span className='text-success'>you</span>
            : <span className='font-mono text-code num-tabular'>{winningBidder}</span>)}</div>
      {/* Le minimum à surenchérir n'a de sens que tant qu'on peut enchérir.
          Fenêtre fermée, la ligne sort : elle annoncerait un plancher pour un
          appel qui revertera de toute façon (`WindowClosed`). Même dérivation
          que la ligne « Window » ci-dessus — `canPlaceBid` couvre aussi le cas
          de la première mise du cycle (`firstBidWindowOpen`). */}
      {canPlaceBid && (
        <div>Next minimum bid: {minNextBid === undefined ? '—' : <Num>{mrn(minNextBid)} MRN</Num>}</div>
      )}
      {/* Une epoch gagnée lors d'un cycle précédent mais pas encore réglée
          (`settle` non appelé, gestionnaire pas encore nommé). Ligne
          masquée quand il n'y a rien en attente. */}
      {pendingEpoch !== undefined && pendingEpoch > 0n && (
        <div>
          Won{pendingWinnerIsYou ? ' by you' : ''}, awaiting settlement: #{String(pendingEpoch)} (<Num>{mrn(pendingAmount ?? 0n)} MRN</Num>)
        </div>
      )}
      {isSettledWinner && (
        <div>
          Settled, {youWon ? 'you won this epoch' : 'a manager has been nominated'}.
        </div>
      )}
      {youWonUnsettled && (
        <p className='pt-2 text-xs text-success'>
          You won the auction, settle to become the next manager (and claim the settlement reward).
        </p>
      )}

      <div className='flex flex-wrap gap-4 items-center pt-4'>
        <label htmlFor="auction-bid">Bid (MRN): </label>
        <input
          id="auction-bid"
          type="text"
          className='px-2 border rounded flex-1 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed'
          value={bidInput}
          disabled={pending !== null}
          onChange={(e) => { setBidInput(e.target.value); setActionError('bid', null); }}
        />
        <Button
          level="primary"
          onClick={onBidClick}
          aria-busy={pending === 'bid' || undefined}
          aria-disabled={bidSoftDisabled || undefined}
          disabled={pending !== null}
          className={bidSoftDisabled ? 'opacity-50 cursor-not-allowed' : ''}>
          {pending === 'bid' ? 'Approve + bid in progress' : 'Approve and bid'}
        </Button>
      </div>
      {firstBidWindowOpen && (
        <p className='text-xs pt-1'>
          Window open, no bid yet this cycle, place the first one.
        </p>
      )}
      {errors.bid && <p className='text-xs pt-1 text-danger'>{errors.bid}</p>}

      {canSettle && settleReward > 0n && (
        <div className='pt-2 text-xs'>
          Settle for <Num>{mrn(settleReward)} MRN</Num>
        </div>
      )}
      <div className='pt-2 flex justify-end'>
        <Button
          level="primary"
          onClick={onSettleClick}
          aria-busy={pending === 'settle' || undefined}
          aria-disabled={settleSoftDisabled || undefined}
          disabled={pending !== null}
          className={settleSoftDisabled ? 'opacity-50 cursor-not-allowed' : ''}>
          {pending === 'settle' ? 'Settlement in progress' : 'Settle'}
        </Button>
      </div>
      {errors.settle && <p className='text-xs pt-1 text-danger'>{errors.settle}</p>}

      {/* Bloc setFee : toujours présent pour signaler la mécanique, grisé
          tant que l'utilisateur n'est pas gestionnaire dans la fenêtre de
          priorité du mandat courant. La raison de la désactivation est
          nommée à côté du bouton pour ne pas laisser l'utilisateur deviner. */}
      <div className='pt-4 border-t mt-4'>
        <p className='font-semibold pb-2'>Manager fee</p>
        <div className='flex flex-wrap gap-4 items-center'>
          <label htmlFor="auction-setfee">Fee (%): </label>
          <input
            id="auction-setfee"
            type="text"
            className='px-2 border rounded flex-1 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed'
            value={feeInput}
            disabled={!canSetFee || pending !== null}
            onChange={(e) => { setFeeInput(e.target.value); setActionError('setFee', null); }}
          />
          <Button
            level="primary"
            onClick={onSetFeeClick}
            aria-busy={pending === 'setFee' || undefined}
            aria-disabled={setFeeSoftDisabled || undefined}
            disabled={pending !== null}
            className={setFeeSoftDisabled ? 'opacity-50 cursor-not-allowed' : ''}>
            {pending === 'setFee' ? 'Applying fee' : 'Set fee'}
          </Button>
        </div>
        <p className='text-xs pt-1'>
          {minFeeNum !== undefined && maxManagerFeeNum !== undefined
            ? <>Range: <Num>{fmtFeePct(minFeeNum)}</Num> — <Num>{fmtFeePct(maxManagerFeeNum)}</Num></>
            : 'Reading bounds…'}
        </p>
        {isManagerOfCurrent && inPriorityWindow && !feeAlreadySet && (
          <p className='text-xs'>Priority window open.</p>
        )}
        {errors.setFee && <p className='text-xs pt-1 text-danger'>{errors.setFee}</p>}
      </div>

      <div className='pt-4 border-t mt-4'>
        <div className='flex items-center justify-between gap-4'>
          <div>
            Refund to claim: {user
              ? (refundOwed === undefined ? '—' : <Num>{mrn(refundOwed)} MRN</Num>)
              : 'connect to read'}
          </div>
          <Button
            level="primary"
            onClick={handleWithdrawRefund}
            aria-busy={pending === 'refund' || undefined}
            disabled={!user || pending !== null || wrongNetwork || !hasRefund}>
            {pending === 'refund' ? 'Withdrawal in progress' : 'Withdraw my refund'}
          </Button>
        </div>
        {/* Ligne miroir de « Refund to claim » : les fees de gestionnaire
            dues au connecté (`feesOwed[user][*]`), réclamées en une passe
            par `claimManagerFees` sur chaque token panier non vide. */}
        <div className='pt-2 flex items-center justify-between gap-4'>
          <div>
            Fees collected: {user
              ? (feesOwed === undefined ? '—' : <Num>{btc(feesOwed)} BTC</Num>)
              : 'connect to read'}
          </div>
          <Button
            level="primary"
            onClick={handleCollectFees}
            aria-busy={pending === 'fees' || undefined}
            disabled={!user || pending !== null || wrongNetwork || !hasFees}>
            {pending === 'fees' ? 'Collection in progress' : 'Collect fees'}
          </Button>
        </div>
        {errors.refund && <p className='text-xs pt-1 text-danger'>{errors.refund}</p>}
        {errors.fees && <p className='text-xs pt-1 text-danger'>{errors.fees}</p>}
      </div>
    </Panel>
    </ReadErrorBoundary>
  );
}
