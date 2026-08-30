'use client';

import { useReserves } from "@/hooks/useReserves";
import { useEffectiveFees } from "@/hooks/useEffectiveFees";
import { useConstants } from "@/hooks/useConstants";
import { useUserBalances } from "@/hooks/useUserBalances";
import { usePoolPaused } from "@/hooks/usePoolPaused";
import { useFeeRouting } from "@/hooks/useFeeRouting";
import { useState, useRef, useMemo } from "react";
import { useDeployedChainId } from "@/hooks/useDeployedChainId";
import {mockWrappedBTCAbi, poolAbi} from '@/constants/abi';
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { simulateContract } from 'viem/actions';
import { getQuote } from "@/lib/quoteSwap";
import { shareBps } from "@/lib/quote";
import { describeTxError } from "@/lib/txError";
import { breachedBand, reservesAfterSwap, type FeeRouting } from "@/lib/bands";
import Panel from '@/components/Panel';
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/StatusDot";
import { AppStateBoundary } from "@/components/ui/AppStateBoundary";
import { ReadErrorBoundary } from "@/components/ui/ReadErrorBoundary";
import { SwapDecompositionBar } from "@/components/SwapDecompositionBar";
import { isSupportedChain } from '@/constants/addresses';
import { formatAmount } from '@/components/ui/formatAmount';
import { INPUT_CLASS_MONO, SELECT_CLASS } from '@/components/ui/formClasses';

// V.5 — même plafond par transaction que `AddLiquidity` (cf. le commentaire
// dans `txError.ts`). Garde-fou explicite pour éviter le fallback gas du
// wallet qui dépasse le cap Base, et `simulateContract` avant le swap
// pour exposer le vrai revert au lieu de "exceeds max gas".
const TX_GAS_LIMIT = 5_000_000n;

// II.2d — chaîne id du pool, miroir de constants/addresses.
// Re-stylage des inputs natifs (cf. brand book §7) ; les classes
// `INPUT_CLASS_MONO` et `SELECT_CLASS` vivent dans `ui/formClasses.ts`
// depuis R3/C.1.

/** Formate un montant BTC wrappé (8 décimales on-chain) à 4 décimales
 *  affichées, sans grouping (note §4 « Montants en BTC wrappé »). */
const btcAmount = (v: bigint) =>
  formatAmount(v, { displayDecimals: 4, tokenDecimals: 8 });

// Perf E — `Record<number,string>` au niveau module : `tokensInfo`
// variant par chaîne (Hardhat 31337 / Base Sepolia 84532) mais les noms
// affichés sont les mêmes (wBTC/cbBTC/LBTC) aux mêmes indices (cf.
// `constants/addresses.ts`). Sortir ce Record du composant évite de
// reconstruire le même objet à chaque rendu ; `nameOf` était une
// fermeture qui parcourait `tokensInfo` par `find()` à chaque appel.
const NAME_OF: Record<number, string> = {
  0: 'wBTC',
  1: 'cbBTC',
  2: 'LBTC',
};

const Swap = () => {
  const [typedAmount, setTypedAmount] = useState("");
  const [side, setSide] = useState<'in' | 'out' | null>(null);
  const [indexIn, setIndexIn] = useState<0 | 1 | 2>(0);
  const [indexOut, setIndexOut] = useState<0 | 1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState("0.5");
  const [isPending, setIsPending] = useState(false);

  const publicClient = usePublicClient();
  const { pool: deployedPool, tokens: tokensInfo } = useDeployedChainId();

  const { btcBalances, refetch: refetchBalances } = useUserBalances();
  const balanceInData = btcBalances[indexIn];
  const balanceIn = balanceInData?.result;

  const {error: errorReserves, reserves, entries, refetch: refetchReserves} = useReserves();
  const {error: errorFees, feeFor, errorFor} = useEffectiveFees();
  const effectiveFeeNum = feeFor(indexIn, indexOut);
  const {error: errorConstants, feeDen: feeDenData, floorBps: floorEntry, ceilingBps: ceilingEntry} = useConstants();
  const feeDen = feeDenData?.result;
  const floorBps = floorEntry?.status === 'success' ? BigInt(floorEntry.result) : undefined;
  const ceilingBps = ceilingEntry?.status === 'success' ? BigInt(ceilingEntry.result) : undefined;
  const { data: paused, error: errorPaused } = usePoolPaused();
  const { routing, error: errorRouting } = useFeeRouting();

  const connection = useConnection();
  const userAddress = connection.address;

  return (
    <ReadErrorBoundary
      title="Could not read pool data"
      description={(msgs) => `Unable to read the pool. ${msgs.join('; ')}`}
      sources={[
        {message: "Could not read the pool reserves.", error: errorReserves},
        ...(entries ?? []).map((entry, i) => ({
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
        {message: "Could not read whether the pool is paused.", error: errorPaused},
        {message: "Could not read the fee routing.", error: errorRouting},
      ]}
    >
      {connection.status === 'connected' && !isSupportedChain(connection.chainId) ? (
        <AppStateBoundary state={{ kind: 'wrong-network' }} />
      ) : !reserves || effectiveFeeNum===undefined || !feeDen ? (
        <AppStateBoundary state={{ kind: 'loading', title: 'Loading swap data…' }} />
      ) : (
        <SwapForm
          indexIn={indexIn}
          indexOut={indexOut}
          setIndexIn={setIndexIn}
          setIndexOut={setIndexOut}
          side={side}
          setSide={setSide}
          typedAmount={typedAmount}
          setTypedAmount={setTypedAmount}
          tolerance={tolerance}
          setTolerance={setTolerance}
          isPending={isPending}
          setIsPending={setIsPending}
          error={error}
          setError={setError}
          userAddress={userAddress}
          balanceInData={balanceInData}
          balanceIn={balanceIn}
          deployedPool={deployedPool}
          publicClient={publicClient}
          refetchBalances={refetchBalances}
          refetchReserves={refetchReserves}
          tokensInfo={tokensInfo}
          reserves={reserves}
          effectiveFeeNum={effectiveFeeNum}
          feeDen={feeDen}
          paused={paused === true}
          floorBps={floorBps}
          ceilingBps={ceilingBps}
          routing={routing}
        />
      )}
    </ReadErrorBoundary>
  );
}

type SwapFormProps = {
  indexIn: 0 | 1 | 2;
  indexOut: 0 | 1 | 2;
  setIndexIn: (i: 0 | 1 | 2) => void;
  setIndexOut: (i: 0 | 1 | 2) => void;
  side: 'in' | 'out' | null;
  setSide: (s: 'in' | 'out' | null) => void;
  typedAmount: string;
  setTypedAmount: (s: string) => void;
  tolerance: string;
  setTolerance: (s: string) => void;
  isPending: boolean;
  setIsPending: (b: boolean) => void;
  error: string | null;
  setError: (s: string | null) => void;
  userAddress: `0x${string}` | undefined;
  balanceInData: { result?: bigint; error?: Error } | undefined;
  balanceIn: bigint | undefined;
  deployedPool: `0x${string}`;
  publicClient: ReturnType<typeof usePublicClient>;
  refetchBalances: () => Promise<unknown>;
  refetchReserves: () => Promise<unknown>;
  tokensInfo: ReturnType<typeof useDeployedChainId>['tokens'];
  reserves: [bigint, bigint, bigint];
  effectiveFeeNum: bigint;
  feeDen: bigint;
  paused: boolean;
  /** Bandes de reserve, en pourcentage de la somme post-swap. Undefined tant que non lues. */
  floorBps: bigint | undefined;
  ceilingBps: bigint | undefined;
  /** Routage de fee, pour avancer les reserves exactement comme `Pool.swap`. */
  routing: FeeRouting | undefined;
};

function SwapForm(props: SwapFormProps) {
  const {
    indexIn, indexOut, setIndexIn, setIndexOut, side, setSide,
    typedAmount, setTypedAmount, tolerance, setTolerance,
    isPending, setIsPending, error, setError, userAddress, balanceInData,
    balanceIn, deployedPool, publicClient, refetchBalances, refetchReserves,
    tokensInfo, reserves, effectiveFeeNum, feeDen, paused, floorBps, ceilingBps, routing
  } = props;
  const { mutateAsync } = useWriteContract();

  // Perf E — `useMemo([...])` : sans ça, chaque rendu rappelle `getQuote`
  // et le `quote` qu'il rend (objet neuf à chaque fois) invalide tous les
  // `useMemo` dépendants en aval (`expected`, `infos`, `reservesAfter`,
  // `bandBreach`, etc.). Le `useMemo` change la signature de `reason`
  // (nouvelle référence à chaque render), donc on stocke le résultat brut
  // puis on déstructure.
  const quoteResult = useMemo(
    () => getQuote({
      userAsk: {side, typedAmount, indexIn, indexOut, toleranceInput: tolerance},
      poolState: {reserves, effectiveFeeNum, feeDen}
    }),
    [side, typedAmount, indexIn, indexOut, tolerance, reserves, effectiveFeeNum, feeDen]
  );
  const {quote, reason} = quoteResult;

  // V.4/bug-race — `setIsPending(true)` est asynchrone, donc entre les
  // deux clicks d'un double-clic rapide, l'état React n'a pas encore
  // basculé et le bouton n'est pas encore `disabled`. Un ref synchrone
  // ferme cette fenêtre, sans dépendre du scheduling React.
  const swapInFlight = useRef(false);
  const handleSwap = async () => {
    if (swapInFlight.current) return;
    if (paused || !userAddress || side === null || !quote || !publicClient || bandError !== null) return;
    swapInFlight.current = true;
    setError(null);
    try {
      setIsPending(true);
      const hashApprove = await mutateAsync({
        address: tokensInfo[indexIn].address,
        abi: mockWrappedBTCAbi,
        functionName: "approve",
        args: [deployedPool, quote.tokenIn.amount],
        gas: TX_GAS_LIMIT,
      })
      await publicClient.waitForTransactionReceipt({hash: hashApprove});

      // V.5/bug-base-gas-cap — `simulateContract` en pre-vol attrape le vrai revert (allowance,
      // solde, slippage, breche de bande, etc.) AVANT de passer la main au wallet. Meme pattern
      // que dans `AddLiquidity.tsx` : sans ce garde, le gas de repli du wallet peut depasser le
      // cap Base (2^24), et l'utilisateur voit « exceeds max transaction gas limit » au lieu du vrai revert.
      await simulateContract(publicClient, {
        address: deployedPool,
        abi: poolAbi,
        functionName: "swap",
        args: [BigInt(quote.tokenIn.index), quote.tokenIn.amount, BigInt(quote.tokenOut.index), quote.tokenOut.minAmount],
        account: userAddress,
        gas: TX_GAS_LIMIT,
      });

      const hashSwap = await mutateAsync({
        address: deployedPool,
        abi: poolAbi,
        functionName: "swap",
        args: [BigInt(quote.tokenIn.index), quote.tokenIn.amount, BigInt(quote.tokenOut.index), quote.tokenOut.minAmount],
        gas: TX_GAS_LIMIT,
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
        setError(describeTxError(e))
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
  const nameOf = (index: number) => NAME_OF[index];

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

  // Garde de bande — le seul revert que les libs de devis ne voient pas. Reste null tant que
  // les constantes ne sont pas arrivees : le formulaire ne bloque jamais sur une donnee absente.
  // Perf E — `useMemo([quote, routing, ...])` : sans ça, chaque rendu
  // recompose le tuple `reservesAfter` (nouvelle référence) et invalide
  // le `bandBreach` qui en dépend.
  const reservesAfter = useMemo(
    () =>
      quote && routing
        ? reservesAfterSwap(
            reserves, indexIn, quote.tokenIn.amount, routing,
            indexOut, quote.tokenOut.amount,
          )
        : null,
    [quote, routing, reserves, indexIn, indexOut]
  );

  // Perf E — `useMemo([reservesAfter, floorBps, ceilingBps])` : sans ça,
  // le résultat de `breachedBand` est recalculé (et éventuellement
  // ré-invalide `bandSharePct`) à chaque rendu, même quand rien ne change.
  const bandBreach = useMemo(
    () =>
      reservesAfter && floorBps !== undefined && ceilingBps !== undefined
        ? breachedBand(reservesAfter, floorBps, ceilingBps)
        : null,
    [reservesAfter, floorBps, ceilingBps]
  );

  // La valeur de bande est volontairement absente du message : on dit a l'utilisateur que le
  // trade est impossible et quoi faire, sans lui livrer un parametre de protocole inactionnable.
  const bandError = bandBreach
    ? bandBreach.kind === 'ceiling'
      ? `${nameOf(bandBreach.index) ?? 'This token'} would rise above its ceiling. Try a smaller amount.`
      : `${nameOf(bandBreach.index) ?? 'This token'} would fall below its floor. Try a smaller amount.`
    : null;

  // Part que le token detiendra apres le swap, affichee a cote de la bande pour montrer de
  // combien le trade le pousserait au-dela de la limite.
  const bandSharePct = bandBreach && reservesAfter
    ? (() => {
        const sum = reservesAfter[0] + reservesAfter[1] + reservesAfter[2];
        return sum === 0n
          ? null
          : (Number((reservesAfter[bandBreach.index] * 10000n) / sum) / 100)
              .toFixed(2).replace('.', ',');
      })()
    : null;

  const quoteTone: 'success' | 'danger' | 'neutral' = !quote
    ? 'neutral'
    : infos?.balanceError || infos?.zeroOut || bandError
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
              className={SELECT_CLASS}
              value={String(indexIn)}
              onChange={(e) => {setIndexIn(Number(e.target.value) as 0 | 1 | 2); setError(null)}}>
              {tokensInfo.map((token) => (
                <option key={token.name} value={String(token.index)}>
                  {token.name}
                </option>
              ))}
            </select>
            <input
              className={INPUT_CLASS_MONO}
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
              className={SELECT_CLASS}
              value={String(indexOut)}
              onChange={(e) => {setIndexOut(Number(e.target.value) as 0 | 1 | 2); setError(null)}}>
              {tokensInfo.map((token) => (
                <option key={token.name} value={String(token.index)}>
                  {token.name}
                </option>
              ))}
            </select>
            <input
              className={INPUT_CLASS_MONO}
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
            className={INPUT_CLASS_MONO}
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
          Perf Étape I : on garde le `<Panel>` monté en permanence (sinon
          l'animation `merion-panel-in` 200 ms rejoue à chaque flip
          quote ↔ null). On permute juste le contenu intérieur.
        */}
        <Panel title="Decomposition" tone="muted" className={quote ? '' : 'hidden'}>
          {quote ? (
            <SwapDecompositionBar
              input={Number(btcAmount(quote.tokenIn.amount))}
              fee={Number(btcAmount(quote.tokenIn.fee))}
              priceImpact={Number(btcAmount(quote.tokenOut.priceImpact))}
              slippage={tolerance === '' ? 0 : Number(tolerance) || 0}
              amountOut={Number(btcAmount(quote.tokenOut.amount))}
              feeUnit={nameOf(indexIn) ?? ''}
            />
          ) : null}
        </Panel>

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
                    ? (infos?.balanceError ?? infos?.zeroOut ?? bandError ?? 'Quote rejected')
                    : 'Awaiting quote'
            }
          />
          <Button
            level="primary"
            onClick={handleSwap}
            aria-busy={isPending || undefined}
            disabled={isPending || paused || !userAddress || !quote || Boolean(infos?.balanceError) || Boolean(infos?.zeroOut) || Boolean(bandError)}>
            {isPending ? "Swap pending" : "Swap"}
          </Button>
        </div>

        {paused && (
          <p className="text-small text-danger" role="alert">
            The pool is paused — swaps are suspended until the owner unpauses it.
          </p>
        )}
        {!userAddress && (
          <p className="text-small text-cloud/70" role="status">
            Connect a wallet to swap — the quote keeps updating while you are disconnected.
          </p>
        )}

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
          <p className="text-small text-danger" role="alert">
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
          <div className="rounded border-[3px] border-merion-blue/40 bg-slate p-3 text-small flex flex-col gap-1">
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

            {bandSharePct !== null && bandSharePct !== undefined ? (
              <div className="flex items-baseline justify-between gap-4 py-1 border-t border-merion-blue/40 mt-1 pt-2">
                <span className="text-cloud/80">
                  {bandBreach?.kind === 'ceiling' ? 'Ceiling after swap' : 'Floor after swap'}
                </span>
                <span className="flex items-baseline gap-1.5 min-w-0">
                  <span className="font-mono text-code num-tabular text-danger">
                    {bandSharePct}%
                  </span>
                  <span className="font-mono text-code-sm text-neutral">
                    {' '}
                    {nameOf(bandBreach!.index)}
                  </span>
                </span>
              </div>
            ) : null}
          </div>
        )}

        {bandError && (
          <p className="text-small text-danger" role="alert">
            {bandError}
          </p>
        )}
      </div>
    </Panel>
  )
}

export default Swap
