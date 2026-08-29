'use client';

import { useReserves } from "@/hooks/useReserves";
import { useMinimumLiquidity } from "@/hooks/useMinimumLiquidity";
import { useState } from "react";
import { useAddresses } from "@/hooks/useAddresses";
import {mockWrappedBTCAbi, poolAbi} from '@/constants/abi';
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { getQuote } from "@/lib/quoteAddLiquidity";
import Panel from "@/components/Panel";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/StatusDot";
import { KpiCard } from "@/components/ui/KpiCard";
import { AppStateBoundary } from "@/components/ui/AppStateBoundary";
import { ReadErrorBoundary } from "@/components/ui/ReadErrorBoundary";
import { EXPECTED_CHAIN_ID } from '@/components/ui/deployment';
import { formatAmount } from '@/components/ui/formatAmount';
import { INPUT_CLASS_MONO } from '@/components/ui/formClasses';

// II.2d — chaîne id du pool, miroir de constants/addresses.
// `INPUT_CLASS_MONO` vit dans `ui/formClasses.ts` depuis R3/C.1.

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
  const { pool: deployedPool, tokens: tokensInfo } = useAddresses();

  const { reserves, entries, supply: supplyEntry, error: errorReserves, refetch: refetchReserves } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;
  const { data: minLiq, error: errorMinLiq } = useMinimumLiquidity(supply === 0n);

  const connection = useConnection();
  const userAddress = connection.address;

  // `getQuote` est gated par les mêmes conditions que les bornes
  // d'état ci-dessous : quand le formulaire rend, `reserves` et
  // `supply` (et `minLiq` pour le cas pool vide) sont définis, donc
  // l'appel est valide. Hors formulaire, on rend un QuoteResult vide
  // pour que `quote` et `reason` soient toujours du bon type.
  const quoteResult = reserves && supply !== undefined && !(supply === 0n && minLiq === undefined)
    ? getQuote({
        anchor,
        typedAmount,
        toleranceInput: supply === 0n ? "" : tolerance,
        reserves,
        supply,
        minLiq
      })
    : { quote: null, reason: null };
  const {quote, reason} = quoteResult;

  const handleAdd = async () => {
    if (!userAddress || anchor === null || !quote || !publicClient) return;
    setError(null);
    try {
      for (let i = 0 ; i < 3 ; i++) {
        setStep(i);
        const token = tokensInfo.find((t) => Number(t.index) === i);
        if (!token) throw new Error("Unknown token");
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
      // V.4/bug-race — refetch ciblé des réserves APRÈS settle pour
      // que la prochaine quote voie le bon état du pool. Le supply
      // (totalSupply) est inclus dans le même useReadContracts que
      // les réserves, donc un seul appel RPC suffit.
      await refetchReserves();
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
    <ReadErrorBoundary
      title="Could not read pool data"
      description={(msgs) => `Unable to read the pool. ${msgs.join('; ')}`}
      sources={[
        {message: "Failed to read the pool reserves.", error: errorReserves},
        ...(entries ?? []).map((entry, i) => ({
          message: `Failed to read the ${tokensInfo[i].name} reserve.`,
          error: entry?.error
        })),
        {message: "Failed to read total LP shares.", error: supplyEntry?.error},
        {message: "Failed to read minimum liquidity.", error: errorMinLiq},
      ]}
    >
      {connection.status === 'disconnected' ? (
        <AppStateBoundary state={{ kind: 'wallet-not-connected' }} />
      ) : connection.status === 'connected' && connection.chainId !== EXPECTED_CHAIN_ID ? (
        <AppStateBoundary state={{ kind: 'wrong-network' }} />
      ) : !reserves || supply === undefined ? (
        <AppStateBoundary state={{ kind: 'loading', title: 'Loading pool data…' }} />
      ) : supply === 0n && minLiq === undefined ? (
        <AppStateBoundary state={{ kind: 'loading', title: 'Loading minimum liquidity…' }} />
      ) : (
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
                      className={INPUT_CLASS_MONO}
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
                className={`text-small ${isEmptyPool ? 'text-cloud/60' : 'text-cloud/80'}`}
              >
                Slippage tolerance (%)
              </label>
              <input
                className={INPUT_CLASS_MONO}
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
      )}
    </ReadErrorBoundary>
  )
}

export default AddLiquidity
