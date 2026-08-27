'use client';

import { useState, useRef } from 'react';
import { useWriteContract, useConnection, useWaitForTransactionReceipt, useWatchAsset } from 'wagmi';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { deployedMrn, MRN_DECIMALS } from '@/constants/addresses';
import { mrnAbi } from '@/constants/abi';
import Panel from '@/components/Panel';

const DEV_GRANT = 1_000n * 10n ** 18n; // I.6 — 1000 MRN, pour rendre une mise démontrable depuis un autre compte.

// I.6 — Sur le modèle de `Faucet`/`MintButton` (même Panel, même bouton bordé) :
// MRN a une supply fixe, sans `mint`, toute entière chez le compte 0 au
// déploiement. Ce bouton dev transfère depuis le compte CONNECTÉ, donc il ne
// fait quelque chose que connecté en account 0.
const MrnGrant = () => {
  const [recipient, setRecipient] = useState('');
  const userAddress = useConnection().address;
  const { mutate, isPending, error, data: hash } = useWriteContract();
  const { isLoading, isSuccess } = useWaitForTransactionReceipt({ hash });
  const waiting = isPending || isLoading;
  const queryClient = useQueryClient();
  // I.6 — Même correctif que `MintButton` : un wallet qui n'a jamais vu MRN
  // ignore ses 18 décimales et affiche le montant brut (1000 MRN devient un
  // nombre à 21 chiffres). Le premier envoi réussi déclenche
  // `wallet_watchAsset` une seule fois par montage (`asked`), sur le compte
  // CONNECTÉ (l'envoyeur) — pas de bouton séparé à maintenir en double.
  const { mutate: watchAsset } = useWatchAsset();
  const asked = useRef(false);

  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries();
      setRecipient('');
      if (!asked.current) {
        asked.current = true;
        watchAsset({ type: 'ERC20', options: { address: deployedMrn, symbol: 'MRN', decimals: MRN_DECIMALS } });
      }
    }
  }, [isSuccess, queryClient, watchAsset]);

  const send = (to: string) => {
    if (!userAddress || !to.startsWith('0x')) return;
    mutate({
      address: deployedMrn,
      abi: mrnAbi,
      functionName: 'transfer',
      args: [to as `0x${string}`, DEV_GRANT]
    });
  };

  return (
    <Panel>
      <p className='font-semibold pb-2'>Get MRN</p>
      <p className='text-sm pb-2'>
        N&apos;a d&apos;effet que connecté sur le compte 0 (détenteur de tout le MRN à l&apos;origine).
      </p>
      <div className='flex flex-wrap gap-4 items-center'>
        <input
          className='px-2 border rounded flex-1 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed'
          type='text'
          placeholder='Adresse destinataire'
          value={recipient}
          disabled={waiting}
          onChange={(e) => setRecipient(e.target.value)}
        />
        <button
          className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
          onClick={() => send(recipient)}
          disabled={waiting || !userAddress || !recipient.startsWith('0x')}>
          {waiting ? 'Envoi en cours' : 'Envoyer 1000 MRN'}
        </button>
        <button
          className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
          onClick={() => userAddress && send(userAddress)}
          disabled={waiting || !userAddress}>
          {waiting ? 'Envoi en cours' : 'Envoyer à mon adresse'}
        </button>
      </div>
      {error && <p>{error.message}</p>}
    </Panel>
  );
};

export default MrnGrant;
