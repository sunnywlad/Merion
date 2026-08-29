'use client';

import { useReserves } from "@/hooks/useReserves";
import { useEffectiveFees } from "@/hooks/useEffectiveFees";
import { useConstants } from "@/hooks/useConstants";
import { useUserBalances } from "@/hooks/useUserBalances";
import { useState, useRef } from "react";
import { useAddresses } from "@/hooks/useAddresses";
import {mockWrappedBTCAbi, poolAbi} from '@/constants/abi';
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { getQuote } from "@/lib/quoteSwap";
import { shareBps } from "@/lib/quote";
import Panel from '@/components/Panel';
import { collectReadErrors } from "@/lib/readErrors";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/StatusDot";
import { AppStateBoundary } from "@/components/ui/AppStateBoundary";
import { SwapDecompositionBar } from "@/components/SwapDecompositionBar";
import { EXPECTED_CHAIN_ID } from '@/components/ui/deployment';
import { formatAmount } from '@/components/ui/formatAmount';

// II.2d — chaîne id du pool, miroir de constants/addresses.
// Re-stylage des inputs natifs : fond Slate, bordure Cloud à 10 %, focus
// Merion Blue 2 px (cf. brand book §7). Les valeurs monétaires passent en
// `font-mono` pour respecter §4 du brand book.
// py-1.5 : compaction uniforme des formulaires (cf. AddLiquidity).
// `placeholder:text-cloud/60` : WCAG AA, le placeholder sinon tombe à
// ~3.6:1 (cloud/40) sur Midnight.
const inputClass =
  'w-full rounded border border-cloud/10 bg-slate px-3 py-1.5 ' +
  'text-code text-cloud placeholder:text-cloud/60 num-tabular ' +
  'focus:outline-none focus:border-merion-blue focus:border-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const selectClass =
  'shrink-0 rounded border border-cloud/10 bg-slate px-3 py-2 ' +
  'text-body text-cloud ' +
  'focus:outline-none focus:border-merion-blue focus:border-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

/** Formate un montant BTC wrappé (8 décimales on-chain) à 4 décimales
 *  affichées, sans grouping (note §4 « Montants en BTC wrappé »). */
const btcAmount = (v: bigint) =>
  formatAmount(v, { displayDecimals: 4, tokenDecimals: 8 });

const Swap = () => {
  const [typedAmount, setTypedAmount] = useState("");
  const [side, setSide] = useState<'in' | 'out' | null>(null);
  const [indexIn, setIndexIn] = useState<0 | 1 | 2>(0);
  const [indexOut, setIndexOut] = useState<0 | 1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState("");
  const [isPending, setIsPending] = useState(false);

  const { mutateAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const { pool: deployedPool, tokens: tokensInfo } = useAddresses();

  const { btcBalances, refetch: refetchBalances } = useUserBalances();
  const balanceInData = btcBalances[indexIn];
  const balanceIn = balanceInData?.result;

  const {error: errorReserves, reserves, entries, refetch: refetchReserves} = useReserves();
  const {error: errorFees, feeFor, errorFor} = useEffectiveFees();
  const effectiveFeeNum = feeFor(indexIn, indexOut);
  const {error: errorConstants, feeDen: feeDenData} = useConstants();
  const feeDen = feeDenData?.result;

  const connection = useConnection();
  const userAddress = connection.address;

  const failedReads = collectReadErrors([
    {message: "Could not read the pool reserves.", error: errorReserves},
    ...(reserveEntries ?? []).map((entry, i) => ({
      message: `Could not read the ${tokensInfo[i].name} reserve.`,
      error: entry?.error
    })),
    {message: "Could not read the effective fee.", error: errorFees},
    {
      message: `Could not read the effective fee ${tokensInfo[indexIn].name} → ${tokensInfo[indexOut].name}.`,
      error: errorFor(indexIn, indexOut)
    },
    {message: "Could not read the pool constants.", error: errorConstants},
    {message: "Could not read the fee denominator.", error: feeDenData?.error},
  ]);
  if (failedReads.length > 0) {
    for (const r of failedReads) console.error('[Merion]', r.message, r.error);
    const cause = failedReads.find((r) => r.error)?.error?.message ?? 'unknown';
    return (
      <AppStateBoundary
        state={{
          kind: 'error',
          title: 'Could not read pool data',
          description: `Unable to read the pool. ${failedReads.map((r) => r.message).join('; ')}`,
          cause,
        }}
      />
    );
  }

  if (connection.status === 'disconnected') {
    return <AppStateBoundary state={{ kind: 'wallet-not-connected' }} />;
  }
  if (connection.status === 'connected' && connection.chainId !== EXPECTED_CHAIN_ID) {
    return <AppStateBoundary state={{ kind: 'wrong-network' }} />;
  }
  if (!reserveEntries || effectiveFeeNum===undefined || !feeDen) {
    return <AppStateBoundary state={{ kind: 'loading', title: 'Loading swap data…' }} />;
  }

  const reserves = reserveEntries.map((r) => r.result).filter((r) => r !== undefined);

  const {quote, reason} = getQuote({
  userAsk: {side, typedAmount, indexIn, indexOut, toleranceInput: tolerance},
  poolState: {reserves, effectiveFeeNum, feeDen}
  });

  // V.4/bug-race — `setIsPending(true)` est asynchrone, donc entre les
  // deux clicks d'un double-clic rapide, l'état React n'a pas encore
  // basculé et le bouton n'est pas encore `disabled`. Un ref synchrone
  // ferme cette fenêtre, sans dépendre du scheduling React.
  const swapInFlight = useRef(false);
  const handleSwap = async () => {
    if (swapInFlight.current) return;
    if (!userAddress || side === null || !quote || !publicClient) return;
    swapInFlight.current = true;
    setError(null);
    try {
      setIsPending(true);
      const hashApprove = await mutateAsync({
        address: tokensInfo[indexIn].address,
        abi: mockWrappedBTCAbi,
        functionName: "approve",
        args: [deployedPool, quote.tokenIn.amount]
      })
      await publicClient.waitForTransactionReceipt({hash: hashApprove});

      const hashSwap = await mutateAsync({
        address: deployedPool,
        abi: poolAbi,
        functionName: "swap",
        args: [BigInt(quote.tokenIn.index), quote.tokenIn.amount, BigInt(quote.tokenOut.index), quote.tokenOut.minAmount]
      })
      await publicClient.waitForTransactionReceipt({hash: hashSwap});
      // V.4/bug-race — `invalidateQueries` marque stale sans refetch ;
      // le user balance / reserves reste sur l'ancienne valeur jusqu'au
      // prochain poll, et la quote suivante est calculée sur du faux.
      // Refetch ciblé sur les deux queries qui bougent réellement (soldes
      // de l'appelant + réserves du pool) ; le reste (constants, fees,
      // auction state) n'a aucune raison d'être re-lu.
      await Promise.all([refetchBalances(), refetchReserves()]);
      setTypedAmount("");
      setSide(null);
      setTolerance("");
    } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsPending(false);
      swapInFlight.current = false;
    }
  }

  const expected = quote ? {in: quote.tokenIn.amount, out: quote.tokenOut.amount} : null;
  const displayAmount = (j: 'in' | 'out') => {
    if (side === j) return typedAmount;
    else if (expected) return btcAmount(expected[j]);
    else return "";
  }
  const nameOf = (index: number) => tokensInfo.find((token) => token.index === BigInt(index))?.name;

  const infos = quote ? {
    minAmount : quote.tokenOut.minAmount,
    fee: quote.tokenIn.fee,
    feeBps: quote.tokenIn.feeBps,
    priceImpact: quote.tokenOut.priceImpact,
    priceImpactBps: quote.tokenOut.priceImpactBps,
    maxSlippage: quote.tokenOut.amount - quote.tokenOut.minAmount,
    maxSlippageBps: shareBps(quote.tokenOut.amount - quote.tokenOut.minAmount, quote.tokenOut.amount),
    balanceError: ((balanceIn || balanceIn === 0n) && quote.tokenIn.amount > balanceIn) ? "Insufficient balance." : null,
    zeroOut: quote.tokenOut.amount === 0n ? "Swap output is zero." : null
  } : null;

  const quoteTone: 'success' | 'danger' | 'neutral' = !quote
    ? 'neutral'
    : infos?.balanceError || infos?.zeroOut
      ? 'danger'
      : 'success';

  // Tronque un pourcentage en bps (entier 0..10000) à 2 décimales avec
  // séparateur virgule français. `%` collé (note §4 « à l'intérieur du
  // nombre mono »).
  const pct = (bps: bigint) =>
    `${(Number(bps) / 100).toFixed(2).replace('.', ',')}%`;

  return (
    <Panel title="Swap">
      <div className="flex flex-col gap-4">

        <div className="flex flex-col gap-2">
          <label htmlFor="swap-amountIn" className="text-small text-cloud/80">
            From
          </label>
          <div className="flex items-stretch gap-2">
            <select
              aria-label="From token"
              className={selectClass}
              value={String(indexIn)}
              onChange={(e) => {setIndexIn(Number(e.target.value) as 0 | 1 | 2); setError(null)}}>
              {tokensInfo.map((token) => (
                <option key={token.name} value={String(token.index)}>
                  {token.name}
                </option>
              ))}
            </select>
            <input
              className={`${inputClass} font-mono`}
              type="text"
              inputMode="decimal"
              id="swap-amountIn"
              value={displayAmount('in')}
              disabled={isPending}
              onChange={(e) => {
                setTypedAmount(e.target.value);
                setSide('in');
                setError(null)
              }}/>
          </div>
          {balanceIn !== undefined ? (
            <div className="flex items-baseline gap-2 text-caption text-cloud/60">
              <span>Balance</span>
              <span className="font-mono text-code-sm num-tabular">
                {btcAmount(balanceIn)}
              </span>
              <span className="font-mono text-code-sm text-neutral">
                {nameOf(indexIn)}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="swap-amountOut" className="text-small text-cloud/80">
            To
          </label>
          <div className="flex items-stretch gap-2">
            <select
              aria-label="To token"
              className={selectClass}
              value={String(indexOut)}
              onChange={(e) => {setIndexOut(Number(e.target.value) as 0 | 1 | 2); setError(null)}}>
              {tokensInfo.map((token) => (
                <option key={token.name} value={String(token.index)}>
                  {token.name}
                </option>
              ))}
            </select>
            <input
              className={`${inputClass} font-mono`}
              type="text"
              inputMode="decimal"
              id="swap-amountOut"
              value={displayAmount('out')}
              disabled={isPending}
              onChange={(e) => {
                setTypedAmount(e.target.value);
                setSide('out');
                setError(null)
              }}/>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="swap-tolerance" className="text-small text-cloud/80">
            Slippage tolerance (%)
          </label>
          <input
            className={`${inputClass} font-mono`}
            type="text"
            inputMode="decimal"
            id="swap-tolerance"
            placeholder="0.5"
            value={tolerance}
            disabled={isPending}
            onChange={(e) => {setTolerance(e.target.value); setError(null)}}/>
        </div>

        {/*
          Decomposition — note §6 : « ne réserve son espace qu'une fois
          une quote reçue ; à vide, elle est réduite à une ligne
          "Decomposition — awaiting quote", pas une carte à hauteur fixe ».
          On rend la carte complète quand une quote existe, sinon une
          ligne d'attente dans la même typographie.
        */}
        {quote ? (
          <Panel title="Decomposition" tone="muted">
            <SwapDecompositionBar
              input={Number(btcAmount(quote.tokenIn.amount))}
              fee={Number(btcAmount(quote.tokenIn.fee))}
              priceImpact={Number(btcAmount(quote.tokenOut.priceImpact))}
              slippage={tolerance === '' ? 0 : Number(tolerance) || 0}
              amountOut={Number(btcAmount(quote.tokenOut.amount))}
              feeUnit={nameOf(indexIn) ?? ''}
              impactUnit={nameOf(indexOut) ?? ''}
            />
          </Panel>
        ) : (
          <p className="text-small text-cloud/60">
            <span className="text-h5 font-medium text-cloud/80">Decomposition</span>
            <span aria-hidden="true"> · </span>
            <span>Awaiting quote</span>
          </p>
        )}

        <div className="flex items-center gap-3">
          <StatusDot
            tone={quoteTone}
            label={
              quoteTone === 'success'
                ? 'Quote ready'
                : quoteTone === 'danger'
                  ? (infos?.balanceError ?? infos?.zeroOut ?? 'Quote rejected')
                  : 'Awaiting quote'
            }
          />
          <Button
            level="primary"
            onClick={handleSwap}
            aria-busy={isPending || undefined}
            disabled={isPending || !userAddress || !quote || Boolean(infos?.balanceError)}>
            {isPending ? "Swap pending" : "Swap"}
          </Button>
        </div>

        {balanceInData?.error && (
          <p className="text-small text-danger" role="alert">
            Could not read your balance.
          </p>
        )}
        {error && (
          <p className="text-small text-danger" role="alert">
            {error}
          </p>
        )}
        {reason && (
          <p className="text-small text-warning" role="status">
            {reason}
          </p>
        )}
        {infos?.balanceError && (
          <p className="text-small text-danger" role="alert">
            {infos.balanceError}
          </p>
        )}
        {infos?.zeroOut && (
          <p className="text-small text-danger" role="alert">
            {infos.zeroOut}
          </p>
        )}
        {infos && (
          <div className="rounded border border-cloud/10 bg-slate p-3 text-small flex flex-col gap-1">
            <p className="flex items-baseline justify-between gap-4 py-1">
              <span className="text-cloud/80">Minimum {nameOf(indexOut)} received</span>
              <span className="flex items-baseline gap-1.5 min-w-0">
                <span className="font-mono text-code num-tabular text-cloud">
                  {btcAmount(infos.minAmount)}
                </span>
                <span className="font-mono text-code-sm text-neutral">
                  {' '}
                  {nameOf(indexOut)}
                </span>
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-4 py-1">
              <span className="text-cloud/80">Fee taken</span>
              <span className="flex items-baseline gap-1.5 min-w-0">
                <span className="font-mono text-code num-tabular text-cloud">
                  {btcAmount(infos.fee)}
                </span>
                <span className="font-mono text-code-sm text-neutral">
                  {' '}
                  {nameOf(indexIn)}
                </span>
                <span className="text-cloud/60">
                  ({pct(infos.feeBps)})
                </span>
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-4 py-1">
              <span className="text-cloud/80">Loss to price impact</span>
              <span className="flex items-baseline gap-1.5 min-w-0">
                <span className="font-mono text-code num-tabular text-cloud">
                  {btcAmount(infos.priceImpact)}
                </span>
                <span className="font-mono text-code-sm text-neutral">
                  {' '}
                  {nameOf(indexOut)}
                </span>
                <span className="text-cloud/60">
                  ({pct(infos.priceImpactBps)})
                </span>
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-4 py-1">
              <span className="text-cloud/80">Max slippage loss</span>
              <span className="flex items-baseline gap-1.5 min-w-0">
                <span className="font-mono text-code num-tabular text-cloud">
                  {btcAmount(infos.maxSlippage)}
                </span>
                <span className="font-mono text-code-sm text-neutral">
                  {' '}
                  {nameOf(indexOut)}
                </span>
                <span className="text-cloud/60">
                  ({pct(infos.maxSlippageBps)})
                </span>
              </span>
            </p>
          </div>
        )}
      </div>
    </Panel>
  )
}

export default Swap
