'use client';

import { useEffect, useState } from 'react';
import { parseUnits } from 'viem';
import { useConnection, useBalance } from 'wagmi';
import { useUserBalances } from '@/hooks/useUserBalances';
import { useLpBalance } from '@/hooks/useLpBalance';
import { useClaimableRent } from '@/hooks/useClaimableRent';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { MRN_DECIMALS } from '@/constants/addresses';
import { formatAmount, smartBtcAmount } from '@/components/ui/formatAmount';
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
 * phrase « Your … balance » ni en-tête de groupe. Tailles de police
 * alignées sur le rail gauche « Pool » (cf. demande).
 *
 * Les chiffres suivent la note §4 :
 *   - BTC wrappé : 4 décimales, troncature, sans grouping
 *   - ETH natif : 4 décimales (même logique mono que le BTC)
 *   - LP shares : 4 décimales (analogie BTC)
 */
export default function Balances() {
  const { status, address: userAddress } = useConnection();
  const { tokens: tokensInfo } = useDeployedChainId();

  const { btcBalances, mrnBalance, isLoading, error } = useUserBalances();
  const {
    data: ethBalance,
    isLoading: isLoadingEth,
    error: errorEth,
  } = useBalance({ address: userAddress });
  const { data: dataLp, isLoading: isLoadingLp, error: errorLp } =
    useLpBalance();
  const { data: rentData } = useClaimableRent(userAddress);

  // `?demo=1` : loyer factice pour visualiser la ligne « MRN to claim »
  // sans avoir joué un cycle d'enchère complet. Lu via `window.location`
  // pour ne pas imposer de frontière Suspense (`useSearchParams`).
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    // Lecture ponctuelle de l'URL après montage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDemo(new URLSearchParams(window.location.search).get('demo') === '1');
  }, []);
  const claimable = demo ? parseUnits('1234.56', MRN_DECIMALS) : rentData;
  const hasClaim = claimable !== undefined && claimable > 0n;

  if (status !== 'connected') {
    return (
      <p className="text-body-lg text-cloud/60">
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
        { message: 'Failed to read your MRN balance', error: mrnBalance?.error },
      ]}
    >
      <ul className="flex flex-col gap-3">
        {tokensInfo.map((token, i) => {
          const entry = btcBalances[i];
          return (
            <PositionRow
              key={token.name}
              label={token.name}
              isLoading={isLoading}
              error={error ?? entry?.error}
              value={
                entry?.status === 'success' ? entry.result : undefined
              }
              // V.5/bug-balances-fake-zero — Pour les BTC wrappes on
              // utilise `smartBtcAmount` (< 0.0001 BTC -> 8 decimales),
              // au lieu du `formatAmount` 4-decimales qui masquait la
              // poussiere (cf. Reserves, meme logique).
              format={smartBtcAmount}
            />
          );
        })}

        <PositionRow
          label="LP Shares"
          isLoading={isLoadingLp}
          error={errorLp}
          value={dataLp}
          displayDecimals={4}
          tokenDecimals={18}
        />

        <PositionRow
          label="MRN"
          isLoading={isLoading}
          error={error ?? mrnBalance?.error}
          value={mrnBalance?.status === 'success' ? mrnBalance.result : undefined}
          displayDecimals={4}
          tokenDecimals={MRN_DECIMALS}
        />

        {/* Loyer à réclamer : ligne affichée seulement quand il y a un
            montant non nul, pour ne pas encombrer le rail le reste du temps. */}
        {hasClaim && (
          <PositionRow
            label="MRN to claim"
            isLoading={false}
            error={null}
            value={claimable}
            displayDecimals={4}
            tokenDecimals={MRN_DECIMALS}
          />
        )}

        <PositionRow
          label="ETH"
          isLoading={isLoadingEth}
          error={errorEth}
          value={ethBalance?.value}
          displayDecimals={4}
          tokenDecimals={18}
        />
      </ul>
    </ReadErrorBoundary>
  );
}

type PositionRowProps = {
  label: string;
  isLoading: boolean;
  error: Error | null | undefined;
  value: bigint | undefined;
  displayDecimals?: number;
  tokenDecimals?: number;
  /** Formateur optionnel surchargeant `formatAmount` (ex. `smartBtcAmount`). */
  format?: (value: bigint | undefined) => string;
  unit?: string;
};

/**
 * Ligne de balance du rail droit « Your position ».
 *
 * Même logique et mêmes tailles que la ligne de montant du rail gauche
 * « Pool » (`Reserves.TokenAmountRow`) : libellé à gauche en
 * `text-body-lg`, montant à droite en `text-body-lg` mono, unité en
 * `text-code`. Calque la gestion des états loading / erreur / `—`.
 */
function PositionRow({
  label,
  isLoading,
  error,
  value,
  displayDecimals,
  tokenDecimals,
  format,
  unit,
}: PositionRowProps) {
  let content: string;
  let contentClass: string;
  if (isLoading) {
    content = 'Loading…';
    contentClass = 'text-cloud/60';
  } else if (error) {
    content = 'Read failed';
    contentClass = 'text-danger';
  } else if (value === undefined) {
    content = '—';
    contentClass = 'text-cloud/60';
  } else if (format) {
    content = format(value);
    contentClass = 'text-cloud';
  } else {
    content = formatAmount(value, { displayDecimals: displayDecimals ?? 4, tokenDecimals: tokenDecimals ?? 18, grouping: 'none' });
    contentClass = 'text-cloud';
  }
  return (
    <li className="flex items-baseline justify-between gap-4 py-1 text-body-lg">
      <span className="text-cloud/80">{label}</span>
      <span className="flex items-baseline min-w-0">
        <span className={`font-mono text-code-lg num-tabular ${contentClass}`}>
          {content}
        </span>
        {unit ? (
          <span className="font-mono text-code text-neutral">
            {' '}
            {unit}
          </span>
        ) : null}
      </span>
    </li>
  );
}
