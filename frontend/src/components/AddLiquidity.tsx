'use client';

import { useReserves } from "@/hooks/useReserves";
import { useState } from "react";
import { parseUnits, formatUnits } from "viem";
import { tokensInfo } from "@/constants/addresses";

const AddLiquidity = () => {
  const [typedAmount, setTypedAmount] = useState("");
  const [anchor, setAnchor] = useState<number | null>(null);
  const [tolerance, setTolerance] = useState("");

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
        className="px-2 border rounded ml-1"
        type="text" id="tolerance"
        value={tolerance}
        onChange={(e) => setTolerance(e.target.value)}/>
      <button
      className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 mt-2'>
        AddLiquidity
      </button>
    </div>
  )
}

export default AddLiquidity
