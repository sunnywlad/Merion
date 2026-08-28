'use client';

import { useState, useRef, useEffect } from 'react';
import { useWriteContract, useConnection, useWaitForTransactionReceipt, useReadContract, useWatchAsset } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { deployedFaucet, deployedMrn, MRN_DECIMALS } from '@/constants/addresses';
import { mrnFaucetAbi } from '@/constants/abi';
import Panel from '@/components/Panel';

// V.0 — Un seul bouton : `drip()` sur le faucet. Plus de « envoyer à mon
// adresse », qui ne fonctionnait que depuis l'owner et restait silencieusement
// cassé pour quiconque. Le faucet redistribue depuis un réservoir pré-financé,
// sans mint (cf. `MrnFaucet.sol` commentaire d'en-tête).
const MrnGrant = () => {
  const userAddress = useConnection().address;
  const { mutate, isPending, error, data: hash } = useWriteContract();
  const { isLoading, isSuccess } = useWaitForTransactionReceipt({ hash });
  const waiting = isPending || isLoading;
  const queryClient = useQueryClient();

  // `dripInterval` et `dripAmount` sont des `immutable` cote contrat : une
  // lecture par session suffit (staleTime Infinity). Lire depuis le contrat
  // et non depuis des constantes en dur : si l'argument du constructeur du
  // faucet change, le front suit en silence, sans desync entre le label, le
  // cooldown et la regle on-chain.
  const dripInterval = useReadContract({
    address: deployedFaucet ?? undefined,
    abi: mrnFaucetAbi,
    functionName: 'dripInterval',
    args: [],
    query: { enabled: deployedFaucet !== null, staleTime: Infinity }
  });
  const dripAmount = useReadContract({
    address: deployedFaucet ?? undefined,
    abi: mrnFaucetAbi,
    functionName: 'dripAmount',
    args: [],
    query: { enabled: deployedFaucet !== null, staleTime: Infinity }
  });

  // Le `lastDripAt` lu en polling lent (30 s) suffit : la valeur bouge une
  // fois par drip, et le bouton n'a pas besoin d'etre a la seconde pres.
  const lastDrip = useReadContract({
    address: deployedFaucet ?? undefined,
    abi: mrnFaucetAbi,
    functionName: 'lastDripAt',
    args: userAddress === undefined ? undefined : [userAddress],
    query: { enabled: deployedFaucet !== null && userAddress !== undefined, refetchInterval: 30000 }
  });
  const lastDripAt = lastDrip.data;

  const drip = () => {
    if (!userAddress || deployedFaucet === null) return;
    mutate({
      address: deployedFaucet,
      abi: mrnFaucetAbi,
      functionName: 'drip',
      args: []
    });
  };

  // V.0 — Meme correctif que `MintButton` : un wallet qui n'a jamais vu MRN
  // ignore ses 18 decimales et affiche le montant brut. Premier drip reussi
  // declenche `wallet_watchAsset` une seule fois par montage (`asked`).
  const { mutate: watchAsset } = useWatchAsset();
  const asked = useRef(false);

  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries();
      if (!asked.current) {
        asked.current = true;
        // L'ajout au wallet regarde MRN, pas le faucet : c'est MRN que
        // l'utilisateur veut voir avec 18 decimales dans MetaMask.
        watchAsset({ type: 'ERC20', options: { address: deployedMrn, symbol: 'MRN', decimals: MRN_DECIMALS } });
      }
    }
  }, [isSuccess, queryClient, watchAsset]);

  // Bouton desactive aussi pendant le cooldown. `lastDripAt` et `dripInterval`
  // sont en secondes (block.timestamp), `Date.now()` aussi : l'ecart est direct.
  // Si `dripInterval` n'est pas encore arrive, le cooldown reste a 0 et le
  // bouton est actif (mais le contrat rejettera de toute facon avec TooEarly).
  const cooldownSeconds = lastDripAt !== undefined && dripInterval.data !== undefined
    ? Number(lastDripAt) + Number(dripInterval.data) - Math.floor(Date.now() / 1000)
    : 0;
  const inCooldown = lastDripAt !== undefined && cooldownSeconds > 0;
  const faucetMissing = deployedFaucet === null;
  const dripAmountLabel = dripAmount.data !== undefined
    ? formatUnits(dripAmount.data, MRN_DECIMALS)
    : '...';
  const intervalHours = dripInterval.data !== undefined
    ? Number(dripInterval.data) / 3600
    : 0;

  return (
    <Panel>
      <p className='font-semibold pb-2'>Get MRN</p>
      <p className='text-sm pb-2'>
        Demande {dripAmountLabel} MRN au faucet du projet, qui redistribue depuis le reservoir
        pre-finance par l&apos;owner du pool au deploiement. Une demande toutes
        les {intervalHours} h par adresse.
      </p>
      {faucetMissing ? (
        <p className='text-sm pb-2 italic'>
          Faucet non deploye sur cette chaine : relancer <code>workMerion</code>.
        </p>
      ) : (
        <div className='flex flex-wrap gap-4 items-center'>
          <button
            className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
            onClick={drip}
            disabled={waiting || !userAddress || inCooldown}>
            {waiting ? 'Drip en cours' : `Demander ${dripAmountLabel} MRN`}
          </button>
          {inCooldown && (
            <span className='text-sm'>
              Prochain drip dans {Math.floor(cooldownSeconds / 60)} min.
            </span>
          )}
        </div>
      )}
      {error && <p>{error.message}</p>}
    </Panel>
  );
};

export default MrnGrant;