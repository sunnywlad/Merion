'use client';

import { useReserves } from "@/hooks/useReserves";
import { useMinimumLiquidity } from "@/hooks/useMinimumLiquidity";
import { useUserBalances } from "@/hooks/useUserBalances";
import { useLpBalance } from "@/hooks/useLpBalance";
import { usePoolPaused } from "@/hooks/usePoolPaused";
import { useState } from "react";
import { useDeployedChainId } from "@/hooks/useDeployedChainId";
import {mockWrappedBTCAbi, poolAbi} from '@/constants/abi';
import { useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { simulateContract } from 'viem/actions';
import { getQuote } from "@/lib/quoteAddLiquidity";
import { describeTxError } from "@/lib/txError";
import Panel from "@/components/Panel";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/StatusDot";
import { KpiCard } from "@/components/ui/KpiCard";
import { AppStateBoundary } from "@/components/ui/AppStateBoundary";
import { ReadErrorBoundary } from "@/components/ui/ReadErrorBoundary";
import { isSupportedChain } from '@/constants/addresses';
import { formatAmount } from '@/components/ui/formatAmount';
import { INPUT_CLASS_MONO } from '@/components/ui/formClasses';

// V.5 — plafond par transaction de Base / Base Sepolia (2^24 = 16 777 216).
// On laisse les calls `addLiquidity` / `swap` / `approve` respirer (largement
// sous le plafond), mais le wallet ne sort plus en fallback gas par défaut
// quand l'estimation reverte — le contrat reverte, on l'attrape et on le
// montre via `describeTxError`, donc l'erreur qui remonte à l'utilisateur
// est la vraie (allowance / balance / slippage), pas "exceeds max gas".
const TX_GAS_LIMIT = 5_000_000n;

// II.2d — chaîne id du pool, miroir de constants/addresses.
// `INPUT_CLASS_MONO` vit dans `ui/formClasses.ts` depuis R3/C.1.

/** BTC wrappé à 8 décimales affichées (précision
 *  on-chain). Tous les montants des formulaires à 8 décimales, cf. la
 *  décision dans `Swap.tsx` : le 4-décimales masquerait les fees sub-display. */
const btcAmount = (v: bigint) =>
  formatAmount(v, { displayDecimals: 8, tokenDecimals: 8 });

const AddLiquidity = () => {
  const [typedAmount, setTypedAmount] = useState("");
  const [anchor, setAnchor] = useState<0 | 1 | 2 | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState("");

  const { mutateAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const { pool: deployedPool, tokens: tokensInfo } = useDeployedChainId();

  const { reserves, entries, supply: supplyEntry, error: errorReserves, refetch: refetchReserves } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;
  const { data: minLiq, error: errorMinLiq } = useMinimumLiquidity(supply === 0n);
  const { btcBalances, refetch: refetchBalances } = useUserBalances();
  const { refetch: refetchLpBalance } = useLpBalance();
  const { data: paused, error: errorPaused } = usePoolPaused();

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

  // Un garde sans donnee se tait : `useUserBalances` est desactive sans wallet connecte, donc
  // `btcBalances[i].result` est undefined et aucun manque n'est signale. Le formulaire reste
  // pleinement utilisable deconnecte, et la verif ne mord qu'une fois les soldes connus.
  const shortfalls = quote
    ? quote.computed.flatMap((amount, i) => {
        const balance = btcBalances[i]?.result;
        return balance !== undefined && amount > balance ? [tokensInfo[i].name] : [];
      })
    : [];
  const balanceError = shortfalls.length > 0
    ? `Insufficient balance: ${shortfalls.join(', ')}.`
    : null;

  const handleAdd = async () => {
    if (paused || !userAddress || anchor === null || !quote || !publicClient || balanceError !== null) return;
    setError(null);
    try {
      // Refetch des reserves AVANT
      // l'approve : le contrat preleve `ceilDiv(_amount * r[i], r[anchor])`
      // sur les reserves FRAICHES, pas sur celles capturees dans le
      // `quote` du rendu (staleTime: 5_000, wagmi v2 ne re-lit pas sur
      // nouveau bloc). Si les reserves ont bougé entre le rendu et le
      // clic, `quote.computed[i]` sous-estime ce que le contrat tire,
      // `safeTransferFrom` revert sur ERC20InsufficientAllowance, et
      // l'utilisateur voit « Allowance too low » designant le depot.
      // Meme chemin que `Swap.tsx`.
      const freshReservesResult = await refetchReserves();
      const freshReservesData = (freshReservesResult as { data?: ReadonlyArray<{ status: string; result?: bigint }> }).data;
      const freshR0 = freshReservesData?.[0]?.status === 'success' ? freshReservesData[0].result : undefined;
      const freshR1 = freshReservesData?.[1]?.status === 'success' ? freshReservesData[1].result : undefined;
      const freshR2 = freshReservesData?.[2]?.status === 'success' ? freshReservesData[2].result : undefined;
      if (freshR0 === undefined || freshR1 === undefined || freshR2 === undefined) {
        throw new Error('Pool state changed during deposit — refresh and retry.');
      }
      const freshSupplyEntry = (freshReservesResult as { data?: ReadonlyArray<{ status: string; result?: bigint }> }).data?.[3];
      const freshSupply = freshSupplyEntry?.status === 'success' && freshSupplyEntry.result !== undefined
        ? freshSupplyEntry.result
        : (supply ?? 0n);
      const freshQuoteResult = getQuote({
        anchor,
        typedAmount,
        toleranceInput: freshSupply === 0n ? "" : tolerance,
        reserves: [freshR0, freshR1, freshR2],
        supply: freshSupply,
        minLiq,
      });
      if (!freshQuoteResult.quote) {
        throw new Error('Pool state changed during deposit — refresh and retry.');
      }
      const freshQuote = freshQuoteResult.quote;

      for (let i = 0 ; i < 3 ; i++) {
        setStep(i);
        const token = tokensInfo.find((t) => Number(t.index) === i);
        if (!token) throw new Error("Unknown token");
        const hash = await mutateAsync({
          address: token.address,
          abi: mockWrappedBTCAbi,
          functionName: "approve",
          args: [deployedPool, freshQuote.computed[i]],
          gas: TX_GAS_LIMIT,
        })
        // `waitForTransactionReceipt` rend
        // le receipt avec `status: 'reverted'` SANS throw quand la tx reverte
        // on-chain (gas cap Base, allowance pré-existante mal calibrée, etc.).
        // Sans ce check, la `simulateContract(addLiquidity)` qui suit
        // taperait allowance == 0 et surfacerait "Allowance too low", message
        // qui désignerait le dépôt comme coupable alors que l'approve aurait
        // déjà foiré en amont. Meme garde que `Swap.tsx`, portée ici sur
        // les trois jambes.
        const receiptApprove = await publicClient.waitForTransactionReceipt({hash});
        if (receiptApprove.status !== 'success') {
          throw new Error(`Approve of ${token.name} reverted on-chain. Check your wallet for details.`);
        }
      }
      setStep(3);
      // `simulateContract` en pre-vol attrape le vrai revert (allowance,
      // solde, slippage) AVANT de passer la main au wallet. Sans ça, un appel qui reverte tombe
      // dans le gas de repli du wallet, au-dessus du cap Base (2^24), et l'utilisateur voit
      // « exceeds max transaction gas limit » au lieu de la vraie raison. On expose le revert
      // ici pour qu'il atterrisse dans `setError` comme un revert au niveau tx.
      await simulateContract(publicClient, {
        address: deployedPool,
        abi: poolAbi,
        functionName: "addLiquidity",
        args: [BigInt(anchor), freshQuote.computed[anchor], freshQuote.minExpected],
        account: userAddress,
        gas: TX_GAS_LIMIT,
      });
      const hash = await mutateAsync({
        address: deployedPool,
        abi: poolAbi,
        functionName: "addLiquidity",
        args: [BigInt(anchor), freshQuote.computed[anchor], freshQuote.minExpected],
        gas: TX_GAS_LIMIT,
      })
      // Symétrique du garde d'approve ci-dessus
      // : si `addLiquidity` reverte silencieusement (gas cap, brèche de
      // bande post-quote, etc.), le refetch ciblé tourne sur du faux état
      // et la quote suivante est calculée sur des réserves d'avant dépôt.
      const receiptAdd = await publicClient.waitForTransactionReceipt({hash});
      if (receiptAdd.status !== 'success') {
        throw new Error('AddLiquidity transaction reverted on-chain. Check your wallet for details.');
      }
      // refetch ciblé des réserves APRÈS settle pour
      // que la prochaine quote voie le bon état du pool. Le supply
      // (totalSupply) est inclus dans le même useReadContracts que
      // les réserves, donc un seul appel RPC suffit.
      //
      // Trois queries bougent sur un
      // dépôt : réserves du pool (useReserves), soldes BTC de l'user
      // (useUserBalances — il vient de dépenser 3 legs), et son solde
      // LP (useLpBalance — il vient de recevoir des parts). Sans ce
      // refetch, le rail « Your
      // balances » resterait sur `LP Shares 0.0000` jusqu'au prochain
      // poll staleTime.
      await Promise.all([refetchReserves(), refetchBalances(), refetchLpBalance()]);
      setTypedAmount("");
      setAnchor(null);
      setTolerance("");
    } catch (e) {
        setError(describeTxError(e))
    } finally {setStep(null)};
  }

  const isEmptyPool = supply === 0n;
  const isPending = step !== null;

  const quoteTone: 'success' | 'danger' | 'neutral' = !quote
    ? 'neutral'
    : reason || balanceError
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
        {message: "Failed to read whether the pool is paused.", error: errorPaused},
      ]}
    >
      {connection.status === 'connected' && !isSupportedChain(connection.chainId) ? (
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
                  paused
                    ? 'Pool paused'
                    : !userAddress
                      ? 'Wallet not connected'
                      : quoteTone === 'success'
                        ? 'Quote ready'
                        : quoteTone === 'danger'
                          ? (reason ?? balanceError ?? 'Quote rejected')
                          : 'Awaiting quote'
                }
              />
              <Button
                level="primary"
                onClick={handleAdd}
                aria-busy={isPending || undefined}
                disabled={isPending || paused === true || !userAddress || !quote || balanceError !== null}>
                {step !== null ? `Deposit in progress (${step + 1}/4)` : "Add Liquidity"}
              </Button>
            </div>

            {paused && (
              <p className="text-small text-danger" role="alert">
                The pool is paused — deposits are suspended until the owner unpauses it.
              </p>
            )}
            {balanceError && (
              <p className="text-small text-danger" role="alert">
                {balanceError}
              </p>
            )}
            {!userAddress && (
              <p className="text-small text-cloud/70" role="status">
                Connect a wallet to deposit — the quote keeps updating while you are disconnected.
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
  )
}

export default AddLiquidity
