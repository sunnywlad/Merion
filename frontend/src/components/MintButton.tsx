'use client';

import {useWriteContract, useConnection, useWaitForTransactionReceipt, useWatchAsset} from 'wagmi';
import {parseUnits, Address} from 'viem';
import {mockWrappedBTCAbi} from '@/constants/abi';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const mintedAmount = parseUnits("10", 8);
const BTC_MOCK_DECIMALS = 8; // I.6 — les trois mocks BTC codent `decimals()` en dur à 8.

const MintButton = ({name, address}: {name: string, address: Address}) => {
  const userAddress = useConnection().address;
  const { mutate, isPending, error, data: hash } = useWriteContract();
  const { isLoading, isSuccess } = useWaitForTransactionReceipt({ hash });
  const waiting = isPending || isLoading;
  const queryClient = useQueryClient();
  // I.6 — Même correctif que pour MRN : un wallet qui n'a jamais vu ce mock
  // ignore ses décimales et affiche le montant brut. Le premier mint réussi
  // déclenche `wallet_watchAsset` une seule fois par montage (`asked`), pour
  // ne pas rouvrir la popup à chaque mint suivant.
  const { mutate: watchAsset } = useWatchAsset();
  const asked = useRef(false);

  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries();
      if (!asked.current) {
        asked.current = true;
        watchAsset({ type: 'ERC20', options: { address, symbol: name, decimals: BTC_MOCK_DECIMALS } });
      }
    }
  }, [isSuccess, queryClient, watchAsset, address, name]);

  return (
    <div>
      <button
      className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
      onClick={() => {
        if (!userAddress) return;
        mutate({
        address: address,
        abi: mockWrappedBTCAbi,
        functionName: "mint",
        args: [userAddress, mintedAmount]
      })}}
      disabled={waiting || !userAddress}>
        {waiting ? "Mint en cours" : `Mint 10 ${name}`}
      </button>
      {error && <p>{error.message}</p>}
    </div>
  )
}

export default MintButton;
