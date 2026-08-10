'use client';

import { useReserves } from "@/hooks/useReserves";
import { useState } from "react";
import { parseUnits, formatUnits } from "viem";
import { tokensInfo } from "@/constants/addresses";
import {mockWrappedBTCAbi, poolAbi} from '@/constants/abi';
import { addresses } from "@/constants/addresses";
import {useWriteContract, useConnection, usePublicClient} from 'wagmi';
import { useQueryClient } from "@tanstack/react-query";

const AddLiquidity = () => {
  const [typedAmount, setTypedAmount] = useState("");
  const [anchor, setAnchor] = useState<number | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState("");

  const userAddress = useConnection().address;
  const { mutateAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const { data } = useReserves();
  if (!data) return <p>Chargement...</p>;

  const reserves = data?.slice(0, 3).map((r) => r.result as bigint);
  const supply = data?.[3].result as bigint;
  const computed = anchor === null ? null : reserves.map((reserve) => {
    if (!typedAmount || Number.isNaN(Number(typedAmount))) return null;
    if (supply === 0n) {
      return parseUnits(typedAmount, 8);
    }
    return parseUnits(typedAmount, 8) * reserve / reserves[anchor]});

  const handleAdd = async () => {
    if (!userAddress || anchor===null || computed===null || !publicClient) return;
    setError(null);
    try {
      for (let i = 0; i < 3 ; i++) {
        setStep(i);
        const token = tokensInfo.find((t) => Number(t.index) === i);
        const amount = computed[i];
        if (!token || !amount) throw new Error("Montant invalide");
        const hash = await mutateAsync({
          address: token.address,
          abi: mockWrappedBTCAbi,
          functionName: "approve",
          args: [addresses[31337].pool, amount]
        })
        await publicClient.waitForTransactionReceipt({hash})
      }
      setStep(3);
      const hash = await mutateAsync({
        address: addresses[31337].pool,
        abi: poolAbi,
        functionName: "addLiquidity",
        args: [BigInt(anchor), parseUnits(typedAmount, 8), 0n]
      })
      await publicClient.waitForTransactionReceipt({hash});
      queryClient.invalidateQueries();
    } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
    } finally {setStep(null)};
  }

  return (
    <div className="border rounded p-4 flex flex-col">
      <div className="flex flex-col my-2">

      {tokensInfo.map((token) => {
        const i = Number(token.index);
        let displayed = "";
        if (anchor === i) {displayed = typedAmount}
        else if (computed?.[i] != null) {displayed = formatUnits(computed[i], 8)}

        return(
          <div key={token.name} className="flex items-center gap-2 my-1">
            <label htmlFor={token.name} className="w-20 shrink-0">{token.name} : </label>
            <input
              className="px-2 border rounded ml-1"
              type="text" id={token.name}
              value={displayed}
              onChange={(e) => {
                setTypedAmount(e.target.value);
                setAnchor(i)}}/>
          </div>
        )}
      )}
      </div>

      <label htmlFor="tolerance">Tolérance au slippage en % :</label>
      <input
        className="px-2 border rounded"
        type="text" id="tolerance"
        value={tolerance}
        onChange={(e) => setTolerance(e.target.value)}/>
      <button
      className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 mt-2'
      onClick={handleAdd}
      disabled={step !== null || !userAddress}>
        {step !== null ? `Dépôt en cours : (${step+1}/4)` : "AddLiquidity"}
      </button>
      {error && <p>{error}</p>}
    </div>
  )
}

export default AddLiquidity
