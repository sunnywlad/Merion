'use client';

import { useReserves } from "@/hooks/useReserves";
import { useLpBalance } from "@/hooks/useLpBalance";
import { useState } from "react";
import { formatUnits } from "viem";
import { deployedPool, tokensInfo } from "@/constants/addresses";
import {poolAbi} from '@/constants/abi';
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { useQueryClient } from "@tanstack/react-query";
import { getQuote } from "@/lib/quoteRemoveLiquidity";
import Panel from "@/components/Panel";
import { collectReadErrors } from "@/lib/readErrors";
import ReadErrors from "@/components/ReadErrors";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/StatusDot";
import { KpiCard } from "@/components/ui/KpiCard";

const inputClass =
  'w-full rounded border border-cloud/10 bg-slate px-3 py-2 ' +
  'text-code text-cloud placeholder:text-cloud/40 ' +
  'focus:outline-none focus:border-merion-blue focus:border-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const RemoveLiquidity = () => {
  const [typedAmount, setTypedAmount] = useState("");
  const [anchor, setAnchor] = useState<0 | 1 | 2 | 3 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState("");
  const [isPending, setIsPending] = useState(false);

  const userAddress = useConnection().address;
  const { mutateAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const { reserves: reserveEntries, supply: supplyEntry, error: errorReserves } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;
  const { data: maxShares, error: errorLpBalance } = useLpBalance();

  const failedReads = collectReadErrors([
    {message: "Erreur de lecture des réserves du pool", error: errorReserves},
    ...(reserveEntries ?? []).map((entry, i) => ({
      message: `Erreur de lecture de la réserve du token ${tokensInfo[i].name}`,
      error: entry?.error
    })),
    {message: "Erreur de lecture du total des parts LP", error: supplyEntry?.error},
    {message: "Erreur de lecture de vos parts LP", error: errorLpBalance},
  ]);
  if (failedReads.length > 0) return <ReadErrors sources={failedReads} />;
  if (!reserveEntries || supply === undefined) return <Panel><p>Chargement...</p></Panel>;
  // `useLpBalance` is disabled without a wallet, so `maxShares` would stay undefined forever
  // for a disconnected visitor: only wait on it once a wallet is actually connected.
  if (userAddress && maxShares === undefined) return <Panel><p>Chargement...</p></Panel>;

  const reserves = reserveEntries.map((r) => r.result).filter((r) => r !== undefined);
  const {quote, reason} = getQuote({
    anchor,
    typedAmount,
    toleranceInput: tolerance,
    reserves,
    supply,
    maxShares
  });

  const handleRem = async () => {
    if (!userAddress || anchor === null || !quote || !publicClient) return;
    setError(null);
    try {
      setIsPending(true);
      const hash = await mutateAsync({
        address: deployedPool,
        abi: poolAbi,
        functionName: "removeLiquidity",
        args: [quote.shares, quote.minExpected]
      })
      await publicClient.waitForTransactionReceipt({hash});
      queryClient.invalidateQueries();
      setTypedAmount("");
      setAnchor(null);
      setTolerance("");
    } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
    } finally {setIsPending(false)};
  }

  const expectedNShares = quote ? ([...quote.expected, quote.shares] as const) : null;
  const displayAmount = (j: number) => {
    if (anchor === j) return typedAmount;
    else if (expectedNShares) return formatUnits(expectedNShares[j], 8);
    else return "";
  }
  const minDisplay = quote ? quote?.minExpected.map((amount) => formatUnits(amount, 8)) : null

  const quoteTone: 'success' | 'danger' | 'neutral' = !quote
    ? 'neutral'
    : reason
      ? 'danger'
      : 'success';

  return (
    <Panel title="Remove Liquidity">
      <div className="flex flex-col gap-4">

        <div className="flex flex-col gap-2">
          {tokensInfo.map((token) => {
            const i = Number(token.index) as 0 | 1 | 2;
            return (
              <div key={token.name} className="flex items-center gap-3">
                <label htmlFor={`rem-${token.name}`} className="w-20 shrink-0 text-small text-cloud/80">
                  {token.name}
                </label>
                <input
                  className={`${inputClass} font-mono`}
                  type="text"
                  inputMode="decimal"
                  id={`rem-${token.name}`}
                  value={displayAmount(i)}
                  disabled={isPending}
                  onChange={(e) => {
                    setTypedAmount(e.target.value);
                    setAnchor(i);
                    setError(null);
                  }}/>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="rem-lpShares" className="text-small text-cloud/80">
            LP shares to burn
          </label>
          <input
            className={`${inputClass} font-mono`}
            type="text"
            inputMode="decimal"
            id="rem-lpShares"
            value={displayAmount(3)}
            disabled={isPending}
            onChange={(e) => {
              setTypedAmount(e.target.value);
              setAnchor(3);
              setError(null);
            }} />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="rem-tolerance" className="text-small text-cloud/80">
            Slippage tolerance (%)
          </label>
          <input
            className={`${inputClass} font-mono`}
            type="text"
            inputMode="decimal"
            id="rem-tolerance"
            placeholder="0.5"
            value={tolerance}
            disabled={isPending}
            onChange={(e) => {setTolerance(e.target.value); setError(null)}}/>
        </div>

        {minDisplay && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <KpiCard
              label={`Min ${tokensInfo[0].name}`}
              value={<span className="font-mono">{minDisplay[0]}</span>}
            />
            <KpiCard
              label={`Min ${tokensInfo[1].name}`}
              value={<span className="font-mono">{minDisplay[1]}</span>}
            />
            <KpiCard
              label={`Min ${tokensInfo[2].name}`}
              value={<span className="font-mono">{minDisplay[2]}</span>}
            />
          </div>
        )}

        <div className="flex items-center gap-3">
          <StatusDot
            tone={quoteTone}
            label={
              quoteTone === 'success'
                ? 'Quote ready'
                : quoteTone === 'danger'
                  ? (reason ?? 'Quote rejected')
                  : 'Awaiting quote'
            }
          />
          <Button
            level="primary"
            onClick={handleRem}
            aria-busy={isPending || undefined}
            disabled={isPending || !userAddress || !quote}>
            {isPending ? "Withdrawal pending" : "Remove Liquidity"}
          </Button>
        </div>

        {reason && (
          <p className="text-small text-warning" role="status">
            {reason}
          </p>
        )}
        {error && (
          <p className="text-small text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Panel>
  )
}

export default RemoveLiquidity
