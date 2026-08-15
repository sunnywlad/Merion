'use client';

import { useReserves } from "@/hooks/useReserves";
import { useLpBalance } from "@/hooks/useLpBalance";
import { useState } from "react";
import { formatUnits } from "viem";
import { addresses, tokensInfo } from "@/constants/addresses";
import {poolAbi} from '@/constants/abi';
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { useQueryClient } from "@tanstack/react-query";
import { getQuote } from "@/lib/quoteRemoveLiquidity";
import Panel from "@/components/Panel";
import { collectReadErrors } from "@/lib/readErrors";
import ReadErrors from "@/components/ReadErrors";

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
        address: addresses[31337].pool,
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

  return (
    <Panel>
      <div className="flex flex-col my-2">

      {tokensInfo.map((token) => {
        const i = Number(token.index) as 0 | 1 | 2;

        return(
          <div key={token.name} className="flex items-center gap-2 my-1">
            <label htmlFor={token.name} className="w-20 shrink-0">{token.name} : </label>
            <input
              className="px-2 border rounded ml-1 disabled:opacity-50 disabled:cursor-not-allowed"
              type="text" id={token.name}
              value={displayAmount(i)}
              disabled={isPending}
              onChange={(e) => {
                setTypedAmount(e.target.value);
                setAnchor(i);
                setError(null)}}/>
          </div>
        )}
      )}
      </div>

      <label htmlFor="lpShares">Nombre de LP shares à brûler :</label>
      <input
        className="px-2 border rounded disabled:opacity-50 disabled:cursor-not-allowed"
        type="text" id="lpShares"
        value = {displayAmount(3)}
        disabled={isPending}
        onChange={(e) => {
          setTypedAmount(e.target.value);
          setAnchor(3);
          setError(null)}} />

      <label htmlFor="tolerance">Tolérance au slippage en % :</label>
      <input
        className="px-2 border rounded disabled:opacity-50 disabled:cursor-not-allowed"
        type="text" id="tolerance"
        value={tolerance}
        disabled={isPending}
        onChange={(e) => {setTolerance(e.target.value); setError(null)}}/>

      <button
      className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 mt-2'
      onClick={handleRem}
      disabled={isPending || !userAddress || !quote}>
        {isPending ? `Retrait en cours` : "RemoveLiquidity"}
      </button>
      {reason && <p>{reason}</p>}
      {error && <p>{error}</p>}
      {minDisplay &&
        <div>
          <p>Nombre minimal de tokens reçus : {minDisplay[0]} wBTC, {minDisplay[1]} cbBTC, {minDisplay[2]} LBTC</p>
        </div>
      }
    </Panel>
  )
}

export default RemoveLiquidity
