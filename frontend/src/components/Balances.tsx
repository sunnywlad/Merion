'use client';

import Link from 'next/link';
import { useConnection } from 'wagmi';
import { useUserBalances } from '@/hooks/useUserBalances';
import { useLpBalance } from '@/hooks/useLpBalance';
import { useReserves } from '@/hooks/useReserves';
import { MRN_DECIMALS } from '@/constants/addresses';
import { useAddresses } from '@/hooks/useAddresses';
import AmountLine from '@/components/AmountLine';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';
import { ReadErrorBoundary } from '@/components/ui/ReadErrorBoundary';

/**
 * Merion « Your position » — note d'inspiration §7, tâche 3.
 *
 * Famille « Your position » du brief : l'utilisateur (soldes, faucet,
 * claims). On sert ici :
 *   - Balances (BTC wrappé + MRN)
 *   - Shares (parts LP + pool share)
 *   - Claims (refund à retirer)
 *   - Faucet (raccourci vers /tools pour le `drip()` MRN)
 *
 * Toujours dépliée dans le rail, au-dessus du pli. Si le portefeuille
 * n'est pas connecté, les soldes ne sont pas lisibles : on rend l'état
 * dédié plutôt qu'une liste de zéros qui mentiraient à l'utilisateur.
 *
 * Les chiffres suivent la note §4 :
 *   - BTC wrappé : 4 décimales, troncature, sans grouping
 *   - MRN : 2 décimales, grouping français (« 90 004 980,00 »)
 *   - LP shares : 4 décimales (analogie BTC, pas de prescription stricte)
 *   - pool share : 2 décimales, `%` collé au nombre (cas mono)
 */
export default function Balances() {
  const { status } = useConnection();
  const { tokens: tokensInfo } = useAddresses();

  const { btcBalances, mrnBalance, refundBalance, isLoading, error } =
    useUserBalances();
  const { data: dataLp, isLoading: isLoadingLp, error: errorLp } =
    useLpBalance();
  const { supply: supplyEntry, isLoading: isLoadingR, error: errorR } =
    useReserves();
  const supply = supplyEntry?.status === 'success'
    ? supplyEntry.result
    : undefined;

  if (status !== 'connected') {
    return (
      <p className="text-small text-cloud/60">
        Connect your wallet to see your balances.
      </p>
    );
  }

  const sharePercent =
    dataLp !== undefined && supply && supply > 0n
      ? dataLp * 10000n / supply
      : undefined;

  return (
    <ReadErrorBoundary
      title="Could not read your balances"
      description={(msgs) => msgs[0] ?? 'Unable to read your balances.'}
      sources={[
        { message: 'Failed to read your balances', error },
        { message: 'Failed to read your LP shares', error: errorLp },
        { message: 'Failed to read the pool total supply', error: errorR }
      ]}
    >
    <div className="flex flex-col gap-3">
      <Group label="Balances">
        {tokensInfo.map((token, i) => {
          const entry = btcBalances[i];
          return (
            <AmountLine
              key={token.name}
              label={`Your ${token.name} balance`}
              isLoading={isLoading}
              error={error ?? entry?.error}
              value={
                entry?.status === 'success' ? entry.result : undefined
              }
              displayDecimals={4}
              tokenDecimals={8}
              unit={token.name}
            />
          );
        })}

        <AmountLine
          label="Your MRN balance"
          isLoading={isLoading}
          error={error ?? mrnBalance?.error}
          value={
            mrnBalance?.status === 'success' ? mrnBalance.result : undefined
          }
          displayDecimals={2}
          tokenDecimals={MRN_DECIMALS}
          grouping="fr"
          unit="MRN"
        />
      </Group>

      <Group label="Claims">
        <AmountLine
          label="Your refund to claim"
          isLoading={isLoading}
          error={error ?? refundBalance?.error}
          value={
            refundBalance?.status === 'success'
              ? refundBalance.result
              : undefined
          }
          displayDecimals={2}
          tokenDecimals={MRN_DECIMALS}
          grouping="fr"
          unit="MRN"
        />
      </Group>

      <Group label="Shares">
        <AmountLine
          label="Your LP shares"
          isLoading={isLoadingLp}
          error={errorLp}
          value={dataLp}
          displayDecimals={4}
          tokenDecimals={18}
          unit="LP"
        />

        <AmountLine
          label="Your pool share"
          isLoading={isLoadingLp || isLoadingR}
          error={errorLp ?? errorR}
          value={sharePercent}
          displayDecimals={2}
          tokenDecimals={2}
          unit="%"
        />
      </Group>

      {/*
        Faucet — la mécanique du `drip()` MRN vit sur `/tools` ; on
        signale ici qu'elle appartient à la famille « Your position » en
        posant un lien, sans dupliquer le composant ni déclencher une
        nouvelle lecture (cf. brief : pas de nouvelle lecture contrat).
      */}
      <p className="text-caption text-cloud/60 pt-1">
        Need MRN for testing?{' '}
        <Link
          href="/tools"
          className="text-merion-blue hover:underline underline-offset-2"
        >
          Open the faucet on /tools
        </Link>
        .
      </p>
    </div>
    </ReadErrorBoundary>
  );
}

/** Petit regroupement titré pour la famille « Your position ». Affiche
 *  une étiquette caption en petites capitales, puis les enfants. */
function Group({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-caption uppercase tracking-wide text-cloud/60">
        {label}
      </p>
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}
