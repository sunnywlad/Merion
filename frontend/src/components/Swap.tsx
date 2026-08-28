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
import ReadErrors from "@/components/ReadErrors";

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

  const userAddress = useConnection().address;

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
  const failedReads = collectReadErrors([
    {message: "Erreur de lecture des réserves du pool", error: errorReserves},
    ...(reserveEntries ?? []).map((entry, i) => ({
      message: `Erreur de lecture de la réserve du token ${tokensInfo[i].name}`,
      error: entry?.error
    })),
    {message: "Erreur de lecture du tarif effectif", error: errorFees},
    {
      message: `Erreur de lecture du tarif effectif ${tokensInfo[indexIn].name} → ${tokensInfo[indexOut].name}`,
      error: errorFor(indexIn, indexOut)
    },
    {message: "Erreur de lecture des constantes du pool", error: errorConstants},
    {message: "Erreur de lecture des fees (den)", error: feeDenData?.error},
  ]);
  if (failedReads.length > 0) return <ReadErrors sources={failedReads} />;
  if (!reserveEntries || effectiveFeeNum===undefined || !feeDen) return <Panel><p>Chargement...</p></Panel>;

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
    balanceError: ((balanceIn || balanceIn === 0n) && quote.tokenIn.amount > balanceIn) ? "Solde insuffisant" : null,
    zeroOut: quote.tokenOut.amount === 0n ? "Sortie du swap nulle" : null
  } : null;

  return (
    <Panel>
      <div className="flex flex-col my-2">

        <div className="flex flex-col gap-1 my-1">
          <label htmlFor="swap-amountIn">Entrée du swap :</label>
          <div className="flex items-center gap-2">
            <select className="shrink-0" value={String(indexIn)} onChange={(e) => {setIndexIn(Number(e.target.value) as 0 | 1 | 2); setError(null)}}>
              {tokensInfo.map((token) => (
                <option key={token.name} value= {String(token.index)}>
                  {token.name}
                </option>
              ))}
            </select>
            <input
              className="px-2 border rounded flex-1 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed"
              type="text" id="swap-amountIn"
              value={displayAmount('in')}
              disabled={isPending}
              onChange={(e) => {
                setTypedAmount(e.target.value);
                setSide('in');
                setError(null)
              }}/>
          </div>
        </div>
        <div className="flex flex-col gap-1 my-1">
          <label htmlFor="swap-amountOut">Sortie du swap :</label>
          <div className="flex items-center gap-2">
            <select className="shrink-0" value={String(indexOut)} onChange={(e) => {setIndexOut(Number(e.target.value) as 0 | 1 | 2); setError(null)}}>
              {tokensInfo.map((token) => (
                <option key={token.name} value= {String(token.index)}>
                  {token.name}
                </option>
              ))}
            </select>
            <input
              className="px-2 border rounded flex-1 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed"
              type="text" id="swap-amountOut"
              value={displayAmount('out')}
              disabled={isPending}
              onChange={(e) => {
                setTypedAmount(e.target.value);
                setSide('out');
                setError(null)
              }}/>
          </div>
        </div>

      </div>

      <label htmlFor="swap-tolerance">Tolérance au slippage en % :</label>
      <input
        className="px-2 border rounded disabled:opacity-50 disabled:cursor-not-allowed"
        type="text" id="swap-tolerance"
        placeholder="0.5"
        value={tolerance}
        disabled={isPending}
        onChange={(e) => {setTolerance(e.target.value); setError(null)}}/>

      <button
      className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 mt-2'
      onClick={handleSwap}
      disabled={isPending || !userAddress || !quote || Boolean(infos?.balanceError)}>
        {isPending ? "Swap en cours" : "Swap"}
      </button>

      {balanceInData?.error && <p>Erreur de lecture de votre solde</p>}
      {error && <p>{error}</p>}
      {reason && <p>{reason}</p>}
      {infos?.balanceError && <p>{infos.balanceError}</p>}
      {infos?.zeroOut && <p>{infos.zeroOut}</p>}
      {infos && <>
        <p>Nombre minimal de {nameOf(indexOut)} reçus : {formatUnits(infos.minAmount, 8)}</p>
        <p>Frais prélevés : {formatUnits(infos.fee, 8)} {nameOf(indexIn)} ({formatUnits(infos.feeBps, 2)} % de l&apos;entrée)</p>
        <p>Perte due à l&apos;impact de prix : {formatUnits(infos.priceImpact, 8)} {nameOf(indexOut)} ({formatUnits(infos.priceImpactBps, 2)} % de moins qu&apos;au prix actuel du pool)</p>
        <p>Perte maximale au slippage : {formatUnits(infos.maxSlippage, 8)} {nameOf(indexOut)} ({formatUnits(infos.maxSlippageBps, 2)} % de la sortie estimée)</p>
      </>}
  </Panel>
  )
}

export default Swap
