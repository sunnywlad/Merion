'use client';

import { useReserves } from "@/hooks/useReserves";
import { useLpBalance } from "@/hooks/useLpBalance";
import { useState } from "react";
import { formatUnits } from "viem";
import { useAddresses } from "@/hooks/useAddresses";
import {poolAbi} from '@/constants/abi';
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { getQuote } from "@/lib/quoteRemoveLiquidity";
import { collectReadErrors } from "@/lib/readErrors";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/StatusDot";
import { KpiCard } from "@/components/ui/KpiCard";
import { AppStateBoundary } from "@/components/ui/AppStateBoundary";
import { EXPECTED_CHAIN_ID } from '@/components/ui/deployment';
import Chevron from "@/components/ui/Chevron";
import Disclosure from "@/components/ui/Disclosure";

// II.2d — chaîne id du pool, miroir de constants/addresses.
// py-1.5 : compaction uniforme des formulaires (cf. AddLiquidity).
// `placeholder:text-cloud/60` : WCAG AA, le placeholder sinon tombe à
// ~3.6:1 (cloud/40) sur Midnight.
const inputClass =
  'w-full rounded border border-cloud/10 bg-slate px-3 py-1.5 ' +
  'text-code text-cloud placeholder:text-cloud/60 ' +
  'focus:outline-none focus:border-merion-blue focus:border-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Merion remove liquidity — note d'inspiration §6 + §8.
 *
 * Replié par défaut : `/pool` ne peut pas tenir en viewport 1440×900 si
 * les deux formulaires sont ouverts en même temps. L'en-tête de carte
 * est cliquable en entier (note §8), avec un chevron 12 px Neutral
 * pivotant à 180°. L'action la plus fréquente étant l'ajout, on garde
 * `Add Liquidity` ouvert et on replie `Remove Liquidity`.
 */
const RemoveLiquidity = () => {
  const [typedAmount, setTypedAmount] = useState("");
  const [anchor, setAnchor] = useState<0 | 1 | 2 | 3 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState("");
  const [isPending, setIsPending] = useState(false);

  const { mutateAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const { pool: deployedPool, tokens: tokensInfo } = useAddresses();

  const { reserves: reserveEntries, supply: supplyEntry, error: errorReserves, refetch: refetchReserves } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;
  const { data: maxShares, error: errorLpBalance, refetch: refetchLpBalance } = useLpBalance();

  const connection = useConnection();
  const userAddress = connection.address;

  const failedReads = collectReadErrors([
    {message: "Failed to read the pool reserves.", error: errorReserves},
    ...(reserveEntries ?? []).map((entry, i) => ({
      message: `Failed to read the ${tokensInfo[i].name} reserve.`,
      error: entry?.error
    })),
    {message: "Failed to read total LP shares.", error: supplyEntry?.error},
    {message: "Failed to read your LP shares.", error: errorLpBalance},
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
  if (userAddress && maxShares === undefined) return <AppStateBoundary state={{ kind: 'loading', title: 'Loading LP balance…' }} />;

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
      // V.4/bug-race — refetch ciblé des réserves ET du solde LP APRÈS
      // settle : les deux bougent sur un removeLiquidity, et la quote
      // suivante doit voir le nouvel état sans attendre le poll.
      await Promise.all([refetchReserves(), refetchLpBalance()]);
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
    <div className="rounded-lg border border-cloud/10 bg-midnight text-cloud overflow-hidden">
      <Disclosure
        id="remove-liquidity-body"
        defaultOpen={false}
        trigger={(open, toggle) => (
          <button
            type="button"
            aria-expanded={open}
            aria-controls="disclosure-remove-liquidity-body"
            onClick={toggle}
            className={
              `flex w-full items-center justify-between gap-3 px-4 py-2 text-left ` +
              `transition-colors duration-150 ` +
              `hover:bg-cloud/5 ` +
              `focus:outline-none focus-visible:border-merion-blue focus-visible:border-2`
            }
          >
            <span className="text-h4 font-medium">Remove Liquidity</span>
            <Chevron open={open} />
          </button>
        )}
      >
        <div className="border-t border-cloud/10 p-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {tokensInfo.map((token) => {
              const i = Number(token.index) as 0 | 1 | 2;
              const full = displayAmount(i);
              // Tronque l'affichage à 4 décimales (note §4) ; la valeur reste
              // saisie en interne, l'arrondi ne sert qu'à l'écran.
              const shown = full === '' ? '' : (Number(full).toFixed(4).replace(/\.?0+$/, '') || '0');
              return (
                <div key={token.name} className="flex items-center gap-3">
                  <label htmlFor={`rem-${token.name}`} className="w-20 shrink-0 text-small text-cloud/80">
                    {token.name}
                  </label>
                  <input
                    className={`${inputClass} font-mono num-tabular`}
                    type="text"
                    inputMode="decimal"
                    id={`rem-${token.name}`}
                    value={shown}
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
              className={`${inputClass} font-mono num-tabular`}
              type="text"
              inputMode="decimal"
              id="rem-lpShares"
              value={
                (() => {
                  const v = displayAmount(3);
                  return v === '' ? '' : (Number(v).toFixed(4).replace(/\.?0+$/, '') || '0');
                })()
              }
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
              className={`${inputClass} font-mono num-tabular`}
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
              {minDisplay.map((amount, i) => {
                const trimmed = Number(amount).toFixed(4).replace(/\.?0+$/, '') || '0';
                return (
                  <KpiCard
                    key={tokensInfo[i].name}
                    label={`Min ${tokensInfo[i].name}`}
                    value={
                      <span className="font-mono num-tabular">
                        {trimmed}
                        <span className="text-cloud/60 text-small"> {tokensInfo[i].name}</span>
                      </span>
                    }
                  />
                );
              })}
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
      </Disclosure>
    </div>
  );
}

export default RemoveLiquidity
