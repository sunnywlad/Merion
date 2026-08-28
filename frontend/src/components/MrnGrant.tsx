'use client';

import { useState, useRef, useEffect } from 'react';
import { useWriteContract, useConnection, useWaitForTransactionReceipt, useReadContract, useWatchAsset } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { deployedFaucet, deployedMrn, MRN_DECIMALS } from '@/constants/addresses';
import { mrnFaucetAbi } from '@/constants/abi';
import Panel from '@/components/Panel';
import { Button } from '@/components/ui/Button';
import { KpiCard } from '@/components/ui/KpiCard';
import { StatusDot } from '@/components/ui/StatusDot';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';

// II.2d — chain id the pool is deployed on, mirrored from constants/addresses.
const EXPECTED_CHAIN_ID = 31337;

// V.0 — Un seul bouton : `drip()` sur le faucet. Plus de « envoyer à mon
// adresse », qui ne fonctionnait que depuis l'owner et restait silencieusement
// cassé pour quiconque. Le faucet redistribue depuis un réservoir pré-financé,
// sans mint (cf. `MrnFaucet.sol` commentaire d'en-tête).
const MrnGrant = () => {
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
  // II.2d — connection pulled here so `userAddress` is available for the
  // `lastDrip` args, while hook order stays unconditional for the rest.
  const connection = useConnection();
  const userAddress = connection.address;
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
  // sont en secondes (block.timestamp), `now` aussi : l'ecart est direct.
  // Si `dripInterval` n'est pas encore arrive, le cooldown reste a 0 et le
  // bouton est actif (mais le contrat rejettera de toute facon avec TooEarly).
  // `now` est tenu via un `useState` initial + un `setInterval` parce que
  // `react-hooks/purity` refuse `Date.now()` en corps de rendu ; le tick à
  // la seconde suffit pour un affichage de cooldown.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, []);
  const cooldownSeconds = lastDripAt !== undefined && dripInterval.data !== undefined
    ? Number(lastDripAt) + Number(dripInterval.data) - now
    : 0;
  const inCooldown = lastDripAt !== undefined && cooldownSeconds > 0;
  const faucetMissing = deployedFaucet === null;
  const dripAmountLabel = dripAmount.data !== undefined
    ? formatUnits(dripAmount.data, MRN_DECIMALS)
    : '...';
  const intervalHours = dripInterval.data !== undefined
    ? Number(dripInterval.data) / 3600
    : 0;

  const stateTone: 'success' | 'warning' | 'neutral' = faucetMissing
    ? 'neutral'
    : inCooldown
      ? 'warning'
      : 'success';
  const stateLabel = faucetMissing
    ? 'Faucet not deployed'
    : inCooldown
      ? 'Cooldown active'
      : 'Ready to claim';

  // II.2d — wallet gate at the bottom of the hook stack so reads above stay
  // unconditional.
  if (connection.status === 'disconnected') {
    return <AppStateBoundary state={{ kind: 'wallet-not-connected' }} />;
  }
  if (connection.status === 'connected' && connection.chainId !== EXPECTED_CHAIN_ID) {
    return <AppStateBoundary state={{ kind: 'wrong-network' }} />;
  }

  return (
    <Panel title="Get MRN">
      <div className="flex flex-col gap-4">
        <p className="text-small text-cloud/70">
          Request {dripAmountLabel} MRN from the project faucet, which redistributes
          from the reservoir pre-funded by the pool owner at deployment. One request
          every {intervalHours} h per address.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <KpiCard
            label="Drip amount"
            value={
              <span className="font-mono">
                {dripAmountLabel} <span className="text-cloud/60 text-small">MRN</span>
              </span>
            }
          />
          <KpiCard
            label="Cooldown"
            value={
              <span className="font-mono">
                {intervalHours} <span className="text-cloud/60 text-small">h</span>
              </span>
            }
          />
        </div>

        {faucetMissing ? (
          <p className="text-small text-warning italic" role="status">
            Faucet not deployed on this chain: rerun <code className="font-mono">workMerion</code>.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <StatusDot tone={stateTone} label={stateLabel} />
            <Button
              level="primary"
              onClick={drip}
              aria-busy={waiting || undefined}
              disabled={waiting || !userAddress || inCooldown}>
              {waiting ? 'Drip pending' : `Claim ${dripAmountLabel} MRN`}
            </Button>
            {inCooldown && (
              <span className="text-small text-cloud/70">
                Next drip in <span className="font-mono">{Math.floor(cooldownSeconds / 60)}</span> min.
              </span>
            )}
          </div>
        )}

        {error && (
          <p className="text-small text-danger" role="alert">
            {error.message}
          </p>
        )}
      </div>
    </Panel>
  );
};

export default MrnGrant;
