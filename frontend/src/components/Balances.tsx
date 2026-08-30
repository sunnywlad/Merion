'use client';

import { useConnection, useBalance } from 'wagmi';
import { useUserBalances } from '@/hooks/useUserBalances';
import { useLpBalance } from '@/hooks/useLpBalance';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import AmountLine from '@/components/AmountLine';
import { ReadErrorBoundary } from '@/components/ui/ReadErrorBoundary';

/**
 * Merion « Your position » — note d'inspiration §7, tâche 3.
 *
 * Version allégée : la fenêtre ne sert plus que les balances on-chain —
 * les BTC wrappés (wBTC / cbBTC / LBTC), l'ETH natif du réseau, et les
 * parts LP (cf. demande : ajout de « LP Shares »). Le MRN et les claims
 * ont été retirés pour garder la page swap simple. Le solde ETH natif
 * vient de `useBalance` (sans `token` : balance native de la chaîne
 * courante) ; les parts LP de `useLpBalance`.
 *
 * Affichage minimal : à gauche le symbole, à droite le montant, sans
 * phrase « Your … balance » ni en-tête de groupe.
 *
 * Les chiffres suivent la note §4 :
 *   - BTC wrappé : 4 décimales, troncature, sans grouping
 *   - ETH natif : 4 décimales (même logique mono que le BTC)
 *   - LP shares : 4 décimales (analogie BTC)
 */
export default function Balances() {
  const { status, address: userAddress } = useConnection();
  const { tokens: tokensInfo } = useDeployedChainId();

  const { btcBalances, isLoading, error } = useUserBalances();
  const {
    data: ethBalance,
    isLoading: isLoadingEth,
    error: errorEth,
  } = useBalance({ address: userAddress });
  const { data: dataLp, isLoading: isLoadingLp, error: errorLp } =
    useLpBalance();

  if (status !== 'connected') {
    return (
      <p className="text-small text-cloud/60">
        Connect your wallet to see your balances.
      </p>
    );
  }

  return (
    <ReadErrorBoundary
      title="Could not read your balances"
      description={(msgs) => msgs[0] ?? 'Unable to read your balances.'}
      sources={[
        { message: 'Failed to read your balances', error },
        { message: 'Failed to read your LP shares', error: errorLp },
        { message: 'Failed to read your ETH balance', error: errorEth },
      ]}
    >
    <ul className="flex flex-col gap-1">
      {tokensInfo.map((token, i) => {
        const entry = btcBalances[i];
        return (
          <AmountLine
            key={token.name}
            label={token.name}
            isLoading={isLoading}
            error={error ?? entry?.error}
            value={
              entry?.status === 'success' ? entry.result : undefined
            }
            displayDecimals={4}
            tokenDecimals={8}
          />
        );
      })}

      <AmountLine
        label="ETH"
        isLoading={isLoadingEth}
        error={errorEth}
        value={ethBalance?.value}
        displayDecimals={4}
        tokenDecimals={18}
      />

      <AmountLine
        label="LP"
        isLoading={isLoadingLp}
        error={errorLp}
        value={dataLp}
        displayDecimals={4}
        tokenDecimals={18}
        unit="LP"
      />
    </ul>
    </ReadErrorBoundary>
  );
}
