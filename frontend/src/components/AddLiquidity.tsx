'use client';

import { useReserves } from "@/hooks/useReserves";
import { useMinimumLiquidity } from "@/hooks/useMinimumLiquidity";
import { useState } from "react";
import { formatUnits } from "viem";
import { tokensInfo } from "@/constants/addresses";
import {mockWrappedBTCAbi, poolAbi} from '@/constants/abi';
import { addresses } from "@/constants/addresses";
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { useQueryClient } from "@tanstack/react-query";
import { getQuote } from "@/lib/quoteAddLiquidity";
import Panel from "@/components/Panel";
import { collectReadErrors } from "@/lib/readErrors";
import ReadErrors from "@/components/ReadErrors";

const AddLiquidity = () => {
  const [typedAmount, setTypedAmount] = useState("");
  const [anchor, setAnchor] = useState<0 | 1 | 2 | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState("");

  const userAddress = useConnection().address;
  const { mutateAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const { reserves: reserveEntries, supply: supplyEntry, error: errorReserves } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;
  const { data: minLiq, error: errorMinLiq } = useMinimumLiquidity(supply === 0n);

  const failedReads = collectReadErrors([
    {message: "Erreur de lecture des réserves du pool", error: errorReserves},
    ...(reserveEntries ?? []).map((entry, i) => ({
      message: `Erreur de lecture de la réserve du token ${tokensInfo[i].name}`,
      error: entry?.error
    })),
    {message: "Erreur de lecture du total des parts LP", error: supplyEntry?.error},
    {message: "Erreur de lecture de la liquidité minimale", error: errorMinLiq},
  ]);
  if (failedReads.length > 0) return <ReadErrors sources={failedReads} />;
  if (!reserveEntries || supply === undefined) return <Panel><p>Chargement...</p></Panel>;
  if (supply === 0n && minLiq === undefined) return <Panel><p>Chargement...</p></Panel>;

  const reserves = reserveEntries.map((r) => r.result).filter((r) => r !== undefined);
  // On an empty pool the tolerance is ignored, so a stale invalid value must not block the deposit.
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
      for (let i = 0; i < 3 ; i++) {
        setStep(i);
        const token = tokensInfo.find((t) => Number(t.index) === i);
        if (!token) throw new Error("Token inconnu");
        const hash = await mutateAsync({
          address: token.address,
          abi: mockWrappedBTCAbi,
          functionName: "approve",
          args: [addresses[31337].pool, quote.computed[i]]
        })
        await publicClient.waitForTransactionReceipt({hash})
      }
      setStep(3);
      const hash = await mutateAsync({
        address: addresses[31337].pool,
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

  // A deposit into an empty pool is fully determined: 3 * amount - MINIMUM_LIQUIDITY, no reserve
  // to drift under our feet, so there is nothing for a tolerance to protect.
  const isEmptyPool = supply === 0n;
  const isPending = step !== null;

  return (
    <Panel>
      <div className="flex flex-col my-2">

      {tokensInfo.map((token) => {
        const i = Number(token.index) as 0 | 1 | 2;
        let displayed = "";
        if (anchor === i) {displayed = typedAmount}
        else if (quote) {displayed = formatUnits(quote.computed[i], 8)}

        return(
          <div key={token.name} className="flex items-center gap-2 my-1">
            <label htmlFor={`add-${token.name}`} className="w-20 shrink-0">{token.name} : </label>
            <input
              className="px-2 border rounded ml-1 flex-1 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed"
              type="text" id={`add-${token.name}`}
              value={displayed}
              disabled={isPending}
              onChange={(e) => {
                setTypedAmount(e.target.value);
                setAnchor(i);
                setError(null)}}/>
          </div>
        )}
      )}
      </div>

      <label htmlFor="add-tolerance" className={isEmptyPool ? "opacity-50" : undefined}>
        Tolérance au slippage en % :
      </label>
      <input
        className="px-2 border rounded disabled:opacity-50 disabled:cursor-not-allowed"
        type="text" id="add-tolerance"
        // Suppressed on an empty pool: the field is neutralised there, and announcing a default
        // that will never be read would be a lie told in grey.
        placeholder={isEmptyPool ? "" : "0.5"}
        value={isEmptyPool ? "" : tolerance}
        disabled={isEmptyPool || isPending}
        onChange={(e) => {setTolerance(e.target.value); setError(null)}}/>
      {isEmptyPool && <p className="text-sm opacity-70">Pool vide : le montant de parts est déterminé, aucun glissement possible.</p>}
      <button
      className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 mt-2'
      onClick={handleAdd}
      disabled={isPending || !userAddress || !quote}>
        {step !== null ? `Dépôt en cours : (${step+1}/4)` : "AddLiquidity"}
      </button>
      {reason && <p>{reason}</p>}
      {error && <p>{error}</p>}
      {quote &&
        <div>
          <p>Nombre minimal de LP Shares reçues : {formatUnits(quote.minExpected, 8)}</p>
          <p>Nombre théorique de LP Shares reçues : {formatUnits(quote.expected, 8)}</p>
        </div>
      }
    </Panel>
  )
}

export default AddLiquidity
