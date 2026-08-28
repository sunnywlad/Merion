'use client';

import { useConnection } from 'wagmi';
import { useUserBalances } from '@/hooks/useUserBalances';
import { useLpBalance } from '@/hooks/useLpBalance';
import { useReserves } from '@/hooks/useReserves';
import { MRN_DECIMALS, tokensInfo } from '@/constants/addresses';
import AmountLine from '@/components/AmountLine';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';

/**
 * Merion « Your position » — note d'inspiration §7.
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

  if (error || errorLp || errorR) {
    const first = error ?? errorLp ?? errorR;
    return (
      <AppStateBoundary
        state={{
          kind: 'error',
          title: 'Could not read your balances',
          description: first?.message,
        }}
      />
    );
  }

  const sharePercent =
    dataLp !== undefined && supply && supply > 0n
      ? dataLp * 10000n / supply
      : undefined;

  return (
    <ul className="flex flex-col min-w-0">
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
    </ul>
  );
}
