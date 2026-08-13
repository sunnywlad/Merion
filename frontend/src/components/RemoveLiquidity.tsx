'use client';

import { useReserves } from "@/hooks/useReserves";
import { useLpBalance } from "@/hooks/useLpBalance";
import { useState } from "react";
import { formatUnits } from "viem";
import { addresses, tokensInfo } from "@/constants/addresses";
import {poolAbi} from '@/constants/abi';
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { useQueryClient } from "@tanstack/react-query";
import { parseAmount } from "@/lib/parseAmount";

type Quote = {
  expected: [bigint, bigint, bigint];
  shares: bigint;
  minExpected: [bigint, bigint, bigint];
};

// A null quote means no transaction can be built yet. `reason` is filled only when the user
// did something wrong: an unfinished form stays silent.
type QuoteResult =
  | {quote: Quote, reason: null}
  | {quote: null, reason: string | null};

const getQuote = ({
  anchor,
  typedAmount,
  toleranceInput,
  reserves,
  supply,
  maxShares}:
  {anchor: 0 | 1 | 2 | 3 | null,
  typedAmount: string,
  toleranceInput: string,
  reserves: readonly bigint[],
  supply: bigint,
  maxShares: bigint | undefined}): QuoteResult => {

    const amount = parseAmount(typedAmount);
    const tolerance = parseAmount(toleranceInput === "" ? "0.5" : toleranceInput, 2);

    // The tolerance is judged first: it is a field of its own, it must speak even on an empty form.
    if (tolerance === null || tolerance < 0) {
      return {quote: null, reason: "Tolérance invalide"};
    }
    if (tolerance > 10000n) {
      return {quote: null, reason: "La tolérance ne peut pas dépasser 100 %"};
    }

    // Unfinished form: nothing to say.
    if (anchor === null || !typedAmount) return {quote: null, reason: null};

    if (maxShares === undefined) return {quote: null, reason: null}

    if (amount===null || amount < 0) {
      return {quote: null, reason: "Montant invalide"};
    }

    if (supply === 0n) return { quote: null, reason: "Le pool est vide"}


    const reservesA = [...reserves, supply] as const;
    const anchorReserve = reservesA[anchor];
    const shares = amount * supply / anchorReserve;

    if (shares === 0n) return { quote: null, reason: "Montant trop faible, rien à brûler"}
    if (shares > maxShares) return { quote: null, reason: "Vous n'avez pas assez de LP Shares"};

    const expected: [bigint, bigint, bigint] = [
      shares * reserves[0] / supply,
      shares * reserves[1] / supply,
      shares * reserves[2] / supply
    ];
    const minExpected: [bigint, bigint, bigint] = [
      expected[0] * (10000n - tolerance) / 10000n,
      expected[1] * (10000n - tolerance) / 10000n,
      expected[2] * (10000n - tolerance) / 10000n
    ];
    return {quote: {expected, shares, minExpected}, reason: null};
}

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

  const { reserves: reserveEntries, supply: supplyEntry } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;
  const { data: maxShares } = useLpBalance();
  if (!reserveEntries) return <p>Chargement...</p>;

  // A failed read leaves `result` undefined: dropping those entries lets the length speak.
  const reserves = reserveEntries.map((r) => r.result).filter((r) => r !== undefined);
  if (supply === undefined || reserves.length !== 3) return <p>Lecture des réserves indisponible</p>;
  // On an empty pool the tolerance is ignored, so a stale invalid value must not block the deposit.
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
    <div className="border rounded p-4 flex flex-col">
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
                setAnchor(i)}}/>
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
          setAnchor(3)}} />

      <label htmlFor="tolerance">Tolérance au slippage en % :</label>
      <input
        className="px-2 border rounded disabled:opacity-50 disabled:cursor-not-allowed"
        type="text" id="tolerance"
        value={tolerance}
        disabled={isPending}
        onChange={(e) => setTolerance(e.target.value)}/>

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
    </div>
  )
}

export default RemoveLiquidity
