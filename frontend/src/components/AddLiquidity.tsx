'use client';

import { useReserves } from "@/hooks/useReserves";
import { useMinimumLiquidity } from "@/hooks/useMinimumLiquidity";
import { useState } from "react";
import { deployedPool, tokensInfo } from "@/constants/addresses";
import {mockWrappedBTCAbi, poolAbi} from '@/constants/abi';
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { useQueryClient } from "@tanstack/react-query";
import { getQuote } from "@/lib/quoteAddLiquidity";
import Panel from "@/components/Panel";
import { collectReadErrors } from "@/lib/readErrors";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/StatusDot";
import { KpiCard } from "@/components/ui/KpiCard";
import { AppStateBoundary } from "@/components/ui/AppStateBoundary";
import { EXPECTED_CHAIN_ID } from '@/components/ui/deployment';
import { formatAmount } from '@/components/ui/formatAmount';

// II.2d — chaîne id du pool, miroir de constants/addresses.
// py-1.5 (6 px) plutôt que py-2 (8 px) : compaction uniforme des
// formulaires pour gagner la marge 1440×900 sur /pool. La note §2 borne
// le padding interne d'un input entre 0.25 et 0.5 rem, on reste dans
// la fenêtre (1.5/16 = 0.375 rem par côté).
const inputClass =
  'w-full rounded border border-cloud/10 bg-slate px-3 py-1.5 ' +
  'text-code text-cloud placeholder:text-cloud/40 num-tabular ' +
  'focus:outline-none focus:border-merion-blue focus:border-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

/** BTC wrappé (8 décimales on-chain) à 4 décimales affichées. */
const btcAmount = (v: bigint) =>
  formatAmount(v, { displayDecimals: 4, tokenDecimals: 8 });

const AddLiquidity = () => {
  const [typedAmount, setTypedAmount] = useState("");
  const [anchor, setAnchor] = useState<0 | 1 | 2 | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState("");

  const { mutateAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const { reserves: reserveEntries, supply: supplyEntry, error: errorReserves } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;
  const { data: minLiq, error: errorMinLiq } = useMinimumLiquidity(supply === 0n);

  const connection = useConnection();
  const userAddress = connection.address;

  const failedReads = collectReadErrors([
    {message: "Erreur de lecture des réserves du pool", error: errorReserves},
    ...(reserveEntries ?? []).map((entry, i) => ({
      message: `Erreur de lecture de la réserve du token ${tokensInfo[i].name}`,
      error: entry?.error
    })),
    {message: "Erreur de lecture du total des parts LP", error: supplyEntry?.error},
    {message: "Erreur de lecture de la liquidité minimale", error: errorMinLiq},
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
  if (!reserveEntries || supply === undefined) return <AppStateBoundary state={{ kind: 'loading', title: 'Loading pool data…' }} />;
  if (supply === 0n && minLiq === undefined) return <AppStateBoundary state={{ kind: 'loading', title: 'Loading minimum liquidity…' }} />;

  const reserves = reserveEntries.map((r) => r.result).filter((r) => r !== undefined);
  const {quote, reason} = getQuote({
    anchor,
    typedAmount,
    toleranceInput: supply === 0n ? "" : tolerance,
    reserves,
    supply,
    minLiq
  });

  const handleAdd = async () => {
    if (!userAddress || anchor === null || !quote || !publicClient) return;
    setError(null);
    try {
      for (let i = 0 ; i < 3 ; i++) {
        setStep(i);
        const token = tokensInfo.find((t) => Number(t.index) === i);
        if (!token) throw new Error("Token inconnu");
        const hash = await mutateAsync({
          address: token.address,
          abi: mockWrappedBTCAbi,
          functionName: "approve",
          args: [deployedPool, quote.computed[i]]
        })
        await publicClient.waitForTransactionReceipt({hash})
      }
      setStep(3);
      const hash = await mutateAsync({
        address: deployedPool,
        abi: poolAbi,
        functionName: "addLiquidity",
        args: [BigInt(anchor), quote.computed[anchor], quote.minExpected]
      })
      await publicClient.waitForTransactionReceipt({hash});
      queryClient.invalidateQueries();
      setTypedAmount("");
      setAnchor(null);
      setTolerance("");
    } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
    } finally {setStep(null)};
  }

  const isEmptyPool = supply === 0n;
  const isPending = step !== null;

  const quoteTone: 'success' | 'danger' | 'neutral' = !quote
    ? 'neutral'
    : reason
      ? 'danger'
      : 'success';

  return (
    <Panel title="Add Liquidity">
      <div className="flex flex-col gap-4">

        <div className="flex flex-col gap-2">
          {tokensInfo.map((token) => {
            const i = Number(token.index) as 0 | 1 | 2;
            const full =
              anchor === i ? typedAmount : quote ? btcAmount(quote.computed[i]) : "";

            return (
              <div key={token.name} className="flex items-center gap-3">
                <label htmlFor={`add-${token.name}`} className="w-20 shrink-0 text-small text-cloud/80">
                  {token.name}
                </label>
                <input
                  className={`${inputClass} font-mono`}
                  type="text"
                  inputMode="decimal"
                  id={`add-${token.name}`}
                  value={full}
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
          <label
            htmlFor="add-tolerance"
            className={`text-small ${isEmptyPool ? 'text-cloud/40' : 'text-cloud/80'}`}
          >
            Slippage tolerance (%)
          </label>
          <input
            className={`${inputClass} font-mono`}
            type="text"
            inputMode="decimal"
            id="add-tolerance"
            placeholder={isEmptyPool ? "" : "0.5"}
            value={isEmptyPool ? "" : tolerance}
            disabled={isEmptyPool || isPending}
            onChange={(e) => {setTolerance(e.target.value); setError(null)}}/>
          {isEmptyPool && (
            <p className="text-caption text-cloud/60">
              Empty pool: LP amount is fully determined, no slippage possible.
            </p>
          )}
        </div>

        {quote && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <KpiCard
              label="LP shares received (expected)"
              value={
                <span className="font-mono num-tabular">
                  {btcAmount(quote.expected)}
                  <span className="text-cloud/60 text-small"> LP</span>
                </span>
              }
            />
            <KpiCard
              label="LP shares received (minimum)"
              value={
                <span className="font-mono num-tabular">
                  {btcAmount(quote.minExpected)}
                  <span className="text-cloud/60 text-small"> LP</span>
                </span>
              }
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
            onClick={handleAdd}
            aria-busy={isPending || undefined}
            disabled={isPending || !userAddress || !quote}>
            {step !== null ? `Deposit in progress (${step + 1}/4)` : "Add Liquidity"}
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

export default AddLiquidity
