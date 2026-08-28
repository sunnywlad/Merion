'use client';

import {useReserves} from '@/hooks/useReserves';
import { tokensInfo } from '@/constants/addresses';
import AmountLine from '@/components/AmountLine';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';
import ReservesBar from '@/components/ReservesBar';

export default function Reserves() {
  const { reserves, supply, isLoading, error } = useReserves();

  // II.2d — whole-request error short-circuits to the boundary. Per-entry
  // errors keep showing through AmountLine, where they belong.
  if (error) {
    console.error('[Merion] reserves read failed', error);
    return (
      <AppStateBoundary
        state={{
          kind: 'error',
          title: 'Could not read reserves',
          description: 'Unable to read the reserves.',
          cause: error.message,
        }}
      />
    );
  }

  // II.3 — share of each token in the pool. Computed only when all three
  // reserves have settled, so a half-loaded pool renders `0` (neutral fill)
  // rather than a misleading percentage. Tokens share the same 8-decimals
  // scale, so direct `bigint` arithmetic is safe.
  const reserveResults =
    reserves?.length === tokensInfo.length
      ? reserves.map((entry) =>
          entry?.status === 'success' ? entry.result : undefined,
        )
      : undefined;
  const allLoaded =
    reserveResults !== undefined &&
    reserveResults.every((v) => v !== undefined);
  const totalReserves = allLoaded
    ? reserveResults!.reduce<bigint>((acc, v) => acc + (v ?? 0n), 0n)
    : 0n;
  const shares = tokensInfo.map((_token, i) => {
    const v = reserveResults?.[i];
    if (v === undefined || totalReserves === 0n) return 0;
    // Two extra decimals on the basis-point side: `Number(bigint)` would
    // lose precision past 2^53 on the reserve sums, so we collapse the
    // `* 10000 / total` ratio back to `Number` only at the end.
    return Number((v * 10000n) / totalReserves) / 10000;
  });

  return (
    <section className='min-w-0'>
      <h2 className='text-sm font-semibold pb-2'>Pool reserves</h2>

      {/* II.3 — relative view first: the bars answer "is the pool balanced?"
          before the user has to read any number. The absolute table sits
          below for users who want the underlying amounts. */}
      <div className='flex flex-col gap-2 pb-3'>
        {tokensInfo.map((token, i) => (
          <ReservesBar
            key={token.name}
            tokenSymbol={token.name}
            share={shares[i]}
          />
        ))}
      </div>

      <ul className='text-sm border-t border-cloud/10 pt-2'>
        {tokensInfo.map((token, i) => {
          const entry = reserves?.[i];
          return (
            <AmountLine
              key={token.name}
              label={`${token.name} reserves`}
              isLoading={isLoading}
              error={error ?? entry?.error}
              value={entry?.status === 'success' ? entry.result : undefined}
            />
          );
        })}

        <AmountLine
          label="Total LP shares"
          isLoading={isLoading}
          error={error ?? supply?.error}
          value={supply?.status === 'success' ? supply.result : undefined}
        />
      </ul>
    </section>
  )
}
