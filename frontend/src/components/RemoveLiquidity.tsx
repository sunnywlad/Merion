'use client';

import { useReserves } from "@/hooks/useReserves";
import { useLpBalance } from "@/hooks/useLpBalance";
import { useUserBalances } from "@/hooks/useUserBalances";
import { usePoolPaused } from "@/hooks/usePoolPaused";
import { useState } from "react";
import { formatUnits } from "viem";
import { useDeployedChainId } from "@/hooks/useDeployedChainId";
import {poolAbi} from '@/constants/abi';
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { getQuote } from "@/lib/quoteRemoveLiquidity";
import { describeTxError } from "@/lib/txError";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/StatusDot";
import { KpiCard } from "@/components/ui/KpiCard";
import { AppStateBoundary } from "@/components/ui/AppStateBoundary";
import { ReadErrorBoundary } from "@/components/ui/ReadErrorBoundary";
import { isSupportedChain } from '@/constants/addresses';
import { Panel } from "@/components/Panel";
import { INPUT_CLASS_MONO } from "@/components/ui/formClasses";

// II.2d — chaîne id du pool, miroir de constants/addresses.
// `INPUT_CLASS_MONO` vit dans `ui/formClasses.ts` depuis R3/C.1.
// `font-mono num-tabular` était précédemment ajouté au site d'appel
// (`${inputClass} font-mono num-tabular`) — la divergence avec Swap et
// AddLiquidity est résorbée : les deux classes sont désormais dans
// `INPUT_CLASS_MONO`.

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
  const { pool: deployedPool, tokens: tokensInfo } = useDeployedChainId();

  const { reserves, entries, supply: supplyEntry, error: errorReserves, refetch: refetchReserves } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;
  const { data: maxShares, error: errorLpBalance, refetch: refetchLpBalance } = useLpBalance();
  const { refetch: refetchBalances } = useUserBalances();
  const { data: paused, error: errorPaused } = usePoolPaused();

  const connection = useConnection();
  const userAddress = connection.address;

  // `getQuote` est gated par les mêmes conditions que les bornes
  // d'état ci-dessous : quand le formulaire rend, `reserves` et
  // `supply` sont définis, donc l'appel est valide. Hors formulaire,
  // on rend un QuoteResult vide pour que `quote` et `reason` soient
  // toujours du bon type.
  const quoteResult = reserves && supply !== undefined
    ? getQuote({
        anchor,
        typedAmount,
        toleranceInput: tolerance,
        reserves,
        supply,
        maxShares
      })
    : { quote: null, reason: null };
  const {quote, reason} = quoteResult;

  const handleRem = async () => {
    if (paused || !userAddress || anchor === null || !quote || !publicClient) return;
    setError(null);
    try {
      setIsPending(true);
      // V.5/bug-stale-quote-removeliquidity — Refetch des reserves AVANT
      // le write : `quote.shares` et `quote.minExpected` sont derives des
      // reserves (et du supply) caches au rendu, staleTime 5_000, wagmi v2
      // ne re-lit pas sur nouveau bloc. Si les reserves ont bouge entre
      // le rendu et le clic, `minExpected` peut sous-estimer ce que le
      // contrat sort, et `removeLiquidity` revert sur `BadSlippage`
      // (le contrat exige `amounts[i] >= minOut[i]`). Meme chemin que
      // `Swap.tsx` et `AddLiquidity.tsx`.
      const freshReservesResult = await refetchReserves();
      const freshReservesData = (freshReservesResult as { data?: ReadonlyArray<{ status: string; result?: bigint }> }).data;
      const freshR0 = freshReservesData?.[0]?.status === 'success' ? freshReservesData[0].result : undefined;
      const freshR1 = freshReservesData?.[1]?.status === 'success' ? freshReservesData[1].result : undefined;
      const freshR2 = freshReservesData?.[2]?.status === 'success' ? freshReservesData[2].result : undefined;
      if (freshR0 === undefined || freshR1 === undefined || freshR2 === undefined) {
        throw new Error('Pool state changed during withdrawal — refresh and retry.');
      }
      const freshSupplyEntry = freshReservesData?.[3];
      const freshSupply = freshSupplyEntry?.status === 'success' && freshSupplyEntry.result !== undefined
        ? freshSupplyEntry.result
        : (supply ?? 0n);
      const freshQuoteResult = getQuote({
        anchor,
        typedAmount,
        toleranceInput: tolerance,
        reserves: [freshR0, freshR1, freshR2],
        supply: freshSupply,
        maxShares,
      });
      if (!freshQuoteResult.quote) {
        throw new Error('Pool state changed during withdrawal — refresh and retry.');
      }
      const freshQuote = freshQuoteResult.quote;

      const hash = await mutateAsync({
        address: deployedPool,
        abi: poolAbi,
        functionName: "removeLiquidity",
        args: [freshQuote.shares, freshQuote.minExpected]
      })
      // V.5/bug-swap-silent-revert — `waitForTransactionReceipt` rend le
      // receipt avec `status: 'reverted'` SANS throw quand la tx reverte
      // on-chain. Meme garde que dans Swap/AddLiquidity : on throw
      // explicite, le `catch` route par `describeTxError`, l'utilisateur
      // voit la vraie raison au lieu du faux etat post-fail.
      const receiptRem = await publicClient.waitForTransactionReceipt({hash});
      if (receiptRem.status !== 'success') {
        throw new Error('RemoveLiquidity transaction reverted on-chain. Check your wallet for details.');
      }
      // V.4/bug-race — refetch ciblé des réserves ET du solde LP APRÈS
      // settle : les deux bougent sur un removeLiquidity, et la quote
      // suivante doit voir le nouvel état sans attendre le poll.
      //
      // V.5/bug-cache-removeliquidity — Symetrique du fix AddLiquidity :
      // un retrait credite les 3 BTCs de l'user, donc `useUserBalances`
      // doit aussi refetcher. Sans ca, le rail « Your balances » reste
      // sur les soldes d'avant le retrait.
      await Promise.all([refetchReserves(), refetchLpBalance(), refetchBalances()]);
      setTypedAmount("");
      setAnchor(null);
      setTolerance("");
    } catch (e) {
        setError(describeTxError(e))
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
        {message: "Failed to read your LP shares.", error: errorLpBalance},
        {message: "Failed to read whether the pool is paused.", error: errorPaused},
      ]}
    >
      {connection.status === 'connected' && !isSupportedChain(connection.chainId) ? (
        <AppStateBoundary state={{ kind: 'wrong-network' }} />
      ) : !reserves || supply === undefined ? (
        <AppStateBoundary state={{ kind: 'loading', title: 'Loading pool data…' }} />
      ) : userAddress && maxShares === undefined ? (
        <AppStateBoundary state={{ kind: 'loading', title: 'Loading LP balance…' }} />
      ) : (
        <Panel title="Remove Liquidity">
            <div className="flex flex-col gap-4">
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
                        className={INPUT_CLASS_MONO}
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
                  className={INPUT_CLASS_MONO}
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
                  className={INPUT_CLASS_MONO}
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
                    // V.5/bug-form-precision — 8 décimales (cf. Swap/AddLiquidity),
                    // precision on-chain, pas de troncature a 4 qui masquait les
                    // minime subtokens.
                    const trimmed = Number(amount).toFixed(8).replace(/\.?0+$/, '') || '0';
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
                    paused
                      ? 'Pool paused'
                      : !userAddress
                        ? 'Wallet not connected'
                        : quoteTone === 'success'
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
                  disabled={isPending || paused === true || !userAddress || !quote}>
                  {isPending ? "Withdrawal pending" : "Remove Liquidity"}
                </Button>
              </div>

              {paused && (
                <p className="text-small text-danger" role="alert">
                  The pool is paused — withdrawals are suspended until the owner unpauses it.
                </p>
              )}
              {!userAddress && (
                <p className="text-small text-cloud/70" role="status">
                  Connect a wallet to withdraw — the quote keeps updating while you are disconnected.
                </p>
              )}
              {reason && (
                <p className="text-small text-danger" role="alert">
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
  );
}

export default RemoveLiquidity
