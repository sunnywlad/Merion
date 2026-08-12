'use client';

import { useReserves } from "@/hooks/useReserves";
import { useMinimumLiquidity } from "@/hooks/useMinimumLiquidity";
import { useState } from "react";
import { parseUnits, formatUnits } from "viem";
import { tokensInfo } from "@/constants/addresses";
import {mockWrappedBTCAbi, poolAbi} from '@/constants/abi';
import { addresses } from "@/constants/addresses";
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { useQueryClient } from "@tanstack/react-query";

type Quote = {
  computed: [bigint, bigint, bigint];
  expected: bigint;
  minExpected: bigint;
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
  minLiq}:
  {anchor: 0 | 1 | 2 | null,
  typedAmount: string,
  toleranceInput: string,
  reserves: readonly bigint[],
  supply: bigint,
  minLiq: bigint | undefined}): QuoteResult => {

  // The tolerance is judged first: it is a field of its own, it must speak even on an empty form.
  if (toleranceInput !== "" && (Number.isNaN(Number(toleranceInput)) || Number(toleranceInput) < 0)) {
    return {quote: null, reason: "Tolérance invalide"};
  }
  if (Number(toleranceInput) > 100) {
    return {quote: null, reason: "La tolérance ne peut pas dépasser 100 %"};
  }

  // Unfinished form: nothing to say.
  if (anchor === null || !typedAmount) return {quote: null, reason: null};

  if (Number.isNaN(Number(typedAmount)) || Number(typedAmount) < 0) {
    return {quote: null, reason: "Montant invalide"};
  }

  const amount = parseUnits(typedAmount, 8);
  const tolerance = parseUnits(toleranceInput === "" ? "0.5" : toleranceInput, 2);

  if (supply === 0n) {
    if (minLiq === undefined) return {quote: null, reason: null};
    const expected = 3n * amount - minLiq;
    if (expected <= 0n) {
      return {quote: null, reason: `Dépôt initial trop faible : plus de ${formatUnits(minLiq / 3n, 8)} par token`};
    }
    return {quote: {computed: [amount, amount, amount], expected, minExpected: expected}, reason: null};
  }

  const anchorReserve = reserves[anchor];
  const computed: [bigint, bigint, bigint] = [
    amount * reserves[0] / anchorReserve,
    amount * reserves[1] / anchorReserve,
    amount * reserves[2] / anchorReserve
  ];
  const expected = supply * amount / anchorReserve;
  const minExpected = expected * (10000n - tolerance) / 10000n;
  return {quote: {computed, expected, minExpected}, reason: null};
}

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

  const { reserves: reserveEntries, supply: supplyEntry } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;
  const { data: minLiq } = useMinimumLiquidity(supply === 0n);
  if (!reserveEntries) return <p>Chargement...</p>;

  // A failed read leaves `result` undefined: dropping those entries lets the length speak.
  const reserves = reserveEntries.map((r) => r.result).filter((r) => r !== undefined);
  if (supply === undefined || reserves.length !== 3) return <p>Lecture des réserves indisponible</p>;
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
    } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
    } finally {setStep(null)};
  }

  // A deposit into an empty pool is fully determined: 3 * amount - MINIMUM_LIQUIDITY, no reserve
  // to drift under our feet, so there is nothing for a tolerance to protect.
  const isEmptyPool = supply === 0n;
  const isPending = step !== null;

  return (
    <div className="border rounded p-4 flex flex-col">
      <div className="flex flex-col my-2">

      {tokensInfo.map((token) => {
        const i = Number(token.index) as 0 | 1 | 2;
        let displayed = "";
        if (anchor === i) {displayed = typedAmount}
        else if (quote) {displayed = formatUnits(quote.computed[i], 8)}

        return(
          <div key={token.name} className="flex items-center gap-2 my-1">
            <label htmlFor={token.name} className="w-20 shrink-0">{token.name} : </label>
            <input
              className="px-2 border rounded ml-1 disabled:opacity-50 disabled:cursor-not-allowed"
              type="text" id={token.name}
              value={displayed}
              disabled={isPending}
              onChange={(e) => {
                setTypedAmount(e.target.value);
                setAnchor(i)}}/>
          </div>
        )}
      )}
      </div>

      <label htmlFor="tolerance" className={isEmptyPool ? "opacity-50" : undefined}>
        Tolérance au slippage en % :
      </label>
      <input
        className="px-2 border rounded disabled:opacity-50 disabled:cursor-not-allowed"
        type="text" id="tolerance"
        value={isEmptyPool ? "" : tolerance}
        disabled={isEmptyPool || isPending}
        onChange={(e) => setTolerance(e.target.value)}/>
      {isEmptyPool && <p className="text-sm opacity-70">Pool vide : le montant de parts est déterminé, aucun glissement possible.</p>}
      <button
      className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 mt-2'
      onClick={handleAdd}
      disabled={isPending || !userAddress || !quote}>
        {step !== null ? `Dépôt en cours : (${step+1}/4)` : "AddLiquidity"}
      </button>
      {reason && <p>{reason}</p>}
      {error && <p>{error}</p>}
      {quote && <p>Nombre minimal de LP Shares reçues : {formatUnits(quote.minExpected, 8)}</p>}
      {quote && <p>Nombre théorique de LP Shares reçues : {formatUnits(quote.expected, 8)}</p>}
    </div>
  )
}

export default AddLiquidity
