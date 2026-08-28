'use client';

import { useReserves } from "@/hooks/useReserves";
import { useEffectiveFees } from "@/hooks/useEffectiveFees";
import { useConstants } from "@/hooks/useConstants";
import { useUserBalances } from "@/hooks/useUserBalances";
import { useState } from "react";
import { formatUnits } from "viem";
import { deployedPool, tokensInfo } from "@/constants/addresses";
import {mockWrappedBTCAbi, poolAbi} from '@/constants/abi';
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { useQueryClient } from "@tanstack/react-query";
import { getQuote } from "@/lib/quoteSwap";
import { shareBps } from "@/lib/quote";
import Panel from '@/components/Panel';
import { collectReadErrors } from "@/lib/readErrors";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/StatusDot";
import { AppStateBoundary } from "@/components/ui/AppStateBoundary";
import { SwapDecompositionBar } from "@/components/SwapDecompositionBar";
import { EXPECTED_CHAIN_ID } from '@/components/ui/deployment';

// II.2d — chain id the pool is deployed on, mirrored from constants/addresses.
// Re-stylage des inputs natifs : fond Slate, bordure Cloud à 10 %, focus
// Merion Blue 2 px (cf. brand book §7). Les valeurs monétaires passent en
// `font-mono` pour respecter §4 du brand book.
const inputClass =
  'w-full rounded border border-cloud/10 bg-slate px-3 py-2 ' +
  'text-code text-cloud placeholder:text-cloud/40 ' +
  'focus:outline-none focus:border-merion-blue focus:border-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const selectClass =
  'shrink-0 rounded border border-cloud/10 bg-slate px-3 py-2 ' +
  'text-body text-cloud ' +
  'focus:outline-none focus:border-merion-blue focus:border-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

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
  const queryClient = useQueryClient();

  const { btcBalances } = useUserBalances();
  const balanceInData = btcBalances[indexIn];
  const balanceIn = balanceInData?.result;

  const {error: errorReserves, reserves: reserveEntries} = useReserves();
  // I.5 — Fin de la migration du tarif : le devis lit `effectiveFeeNum(i, j)`,
  // la vue par laquelle le swap et `get_dy` passent tous les deux. Lire
  // `feeInForce()` ici sous-facturait exactement les swaps que la surcharge
  // existe pour tarifer, et le tarif affiché par le panneau de mandat n'aurait
  // pas été celui que ce formulaire fait payer.
  const {error: errorFees, feeFor, errorFor} = useEffectiveFees();
  const effectiveFeeNum = feeFor(indexIn, indexOut);
  const {error: errorConstants, feeDen: feeDenData} = useConstants();
  const feeDen = feeDenData?.result;

  // II.2d — connection and address pulled last so hooks above stay unconditional.
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

  // II.2d — wallet gate comes AFTER the reads: a swap needs a signer on the
  // right chain, but the reads themselves stay unconditional to keep hook order.
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

  const handleSwap = async () => {
    if (!userAddress || side === null || !quote || !publicClient) return;
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
      queryClient.invalidateQueries();
      setTypedAmount("");
      setSide(null);
      setTolerance("");
    } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
    } finally {setIsPending(false)};
  }

  const expected = quote ? {in: quote.tokenIn.amount, out: quote.tokenOut.amount} : null;
  const displayAmount = (j: 'in' | 'out') => {
    if (side === j) return typedAmount;
    else if (expected) return formatUnits(expected[j], 8);
    else return "";
  }
  const nameOf = (index: number) => tokensInfo.find((token) => token.index === BigInt(index))?.name;

  const infos = quote ? {
    minAmount : quote.tokenOut.minAmount,
    fee: quote.tokenIn.fee,
    feeBps: quote.tokenIn.feeBps,
    priceImpact: quote.tokenOut.priceImpact,
    priceImpactBps: quote.tokenOut.priceImpactBps,
    // The tolerance gap, distinct from the impact above: this one is what the user MAY still
    // lose between signature and inclusion, not what the curve has already taken.
    maxSlippage: quote.tokenOut.amount - quote.tokenOut.minAmount,
    // Rounding aside, this comes back to the tolerance the user typed. Displaying it anyway keeps
    // the three lines readable side by side, and makes the chosen figure visible where it bites.
    maxSlippageBps: shareBps(quote.tokenOut.amount - quote.tokenOut.minAmount, quote.tokenOut.amount),
    balanceError: ((balanceIn || balanceIn === 0n) && quote.tokenIn.amount > balanceIn) ? "Insufficient balance." : null,
    zeroOut: quote.tokenOut.amount === 0n ? "Swap output is zero." : null
  } : null;

  const quoteTone: 'success' | 'danger' | 'neutral' = !quote
    ? 'neutral'
    : infos?.balanceError || infos?.zeroOut
      ? 'danger'
      : 'success';

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
            <div className="flex items-center gap-2 text-caption text-cloud/60">
              <span>Balance</span>
              <span className="font-mono text-code-sm">{formatUnits(balanceIn, 8)}</span>
              <span>{nameOf(indexIn)}</span>
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

        <Panel title="Decomposition" tone="muted">
          <SwapDecompositionBar
            input={
              quote
                ? Number(formatUnits(quote.tokenIn.amount, 8))
                : 0
            }
            fee={
              quote
                ? Number(formatUnits(quote.tokenIn.fee, 8))
                : 0
            }
            priceImpact={
              quote
                ? Number(formatUnits(quote.tokenOut.priceImpact, 8))
                : 0
            }
            slippage={tolerance === '' ? 0 : Number(tolerance) || 0}
            amountOut={
              quote
                ? Number(formatUnits(quote.tokenOut.amount, 8))
                : undefined
            }
            feeUnit={nameOf(indexIn) ?? ''}
            impactUnit={nameOf(indexOut) ?? ''}
          />
        </Panel>

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
          <div className="rounded border border-cloud/10 bg-slate p-3 text-small">
            <p className="flex items-baseline justify-between gap-4 py-1">
              <span className="text-cloud/80">Minimum {nameOf(indexOut)} received</span>
              <span className="font-mono text-code">{formatUnits(infos.minAmount, 8)}</span>
            </p>
            <p className="flex items-baseline justify-between gap-4 py-1">
              <span className="text-cloud/80">Fee taken</span>
              <span className="font-mono text-code">
                {formatUnits(infos.fee, 8)} {nameOf(indexIn)} ({formatUnits(infos.feeBps, 2)}%)
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-4 py-1">
              <span className="text-cloud/80">Loss to price impact</span>
              <span className="font-mono text-code">
                {formatUnits(infos.priceImpact, 8)} {nameOf(indexOut)} ({formatUnits(infos.priceImpactBps, 2)}%)
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-4 py-1">
              <span className="text-cloud/80">Max slippage loss</span>
              <span className="font-mono text-code">
                {formatUnits(infos.maxSlippage, 8)} {nameOf(indexOut)} ({formatUnits(infos.maxSlippageBps, 2)}%)
              </span>
            </p>
          </div>
        )}
      </div>
    </Panel>
  )
}

export default Swap
