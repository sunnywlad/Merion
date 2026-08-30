'use client';

import {useWriteContract, useConnection, useWaitForTransactionReceipt, useWatchAsset} from 'wagmi';
import {parseUnits, Address} from 'viem';
import {mockWrappedBTCAbi} from '@/constants/abi';
import { describeTxError } from '@/lib/txError';
import { useIsWrongNetwork } from '@/hooks/useIsWrongNetwork';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';

const mintedAmount = parseUnits("10", 8);
const BTC_MOCK_DECIMALS = 8; // I.6 — les trois mocks BTC codent `decimals()` en dur à 8.

const MintButton = ({name, address}: {name: string, address: Address}) => {
  const userAddress = useConnection().address;
  const wrongNetwork = useIsWrongNetwork();
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

  const stateTone: 'success' | 'warning' | 'danger' | 'neutral' = error
    ? 'danger'
    : waiting
      ? 'warning'
      : isSuccess
        ? 'success'
        : 'neutral';
  const stateLabel = error
    ? 'Mint failed'
    : waiting
      ? 'Mint in progress'
      : isSuccess
        ? 'Mint confirmed'
        : wrongNetwork
          ? 'Wrong network'
          : !userAddress
            ? 'Connect a wallet'
            : 'Ready to mint';

  return (
    <div className="flex flex-col gap-2">
      <Button
        level="primary"
        onClick={() => {
          if (!userAddress || wrongNetwork) return;
          mutate({
            address: address,
            abi: mockWrappedBTCAbi,
            functionName: "mint",
            args: [userAddress, mintedAmount]
          });
        }}
        aria-busy={waiting || undefined}
        disabled={waiting || !userAddress || wrongNetwork}>
        {waiting ? "Mint pending" : `Mint 10 ${name}`}
      </Button>
      <StatusDot tone={stateTone} label={stateLabel} />
      {error && (
        <p className="text-caption text-danger" role="alert">
          {describeTxError(error)}
        </p>
      )}
    </div>
  )
}

export default MintButton;
