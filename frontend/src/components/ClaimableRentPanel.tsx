'use client';

import { useEffect } from 'react';
import { useConnection, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { useClaimableRent } from '@/hooks/useClaimableRent';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { MRN_DECIMALS } from '@/constants/addresses';
import { describeTxError } from '@/lib/txError';
import { poolAbi } from '@/constants/abi';
import { Button } from '@/components/ui/Button';
import { ReadErrorBoundary } from '@/components/ui/ReadErrorBoundary';
import { formatAmount } from '@/components/ui/formatAmount';
import { Panel } from '@/components/Panel';

/**
 * Loyer réclamable — encadré autonome, monté sur `/pool` entre
 * « Add liquidity » et « Remove liquidity ».
 *
 * Il vit hors de la page `/auction` : le loyer s'accumule d'epoch en epoch
 * tant qu'il n'est pas réclamé, il n'appartient pas à l'epoch courante.
 * Le montant se lit par adresse ; sans connexion, la réponse honnête n'est
 * pas zéro mais « connect ».
 */
export default function ClaimableRentPanel() {
  const user = useConnection().address;
  const { pool: deployedPool } = useDeployedChainId();
  const queryClient = useQueryClient();
  const rent = useClaimableRent(user);

  const { mutate: claimRent, isPending, error: claimError, data: claimHash } =
    useWriteContract();
  const { isLoading: claimConfirming, isSuccess: claimConfirmed } =
    useWaitForTransactionReceipt({ hash: claimHash });
  const claiming = isPending || claimConfirming;
  useEffect(() => {
    if (claimConfirmed) queryClient.invalidateQueries();
  }, [claimConfirmed, queryClient]);

  const claimable = rent.data;
  const hasClaim = claimable !== undefined && claimable > 0n;

  return (
    <ReadErrorBoundary
      title="Could not read your rent position"
      description={(msgs) => `Unable to read the rent. ${msgs.join('; ')}`}
      sources={[{ message: 'Failed to read your rent position', error: rent.error }]}
    >
      <Panel title="Claimable rent">
        <div className='text-body flex items-center justify-between gap-4'>
          <div>{user
            ? <span className='font-mono num-tabular'>
                {formatAmount(claimable, { displayDecimals: 2, tokenDecimals: MRN_DECIMALS, grouping: 'fr' })}
                <span className='text-code-sm text-neutral'>{' '}MRN</span>
              </span>
            : 'Connect to read.'}</div>
          {user && (
            <Button
              level='primary'
              onClick={() => {
                if (!user || deployedPool === undefined) return;
                claimRent({ address: deployedPool, abi: poolAbi, functionName: 'claimRent', args: [] });
              }}
              aria-busy={claiming || undefined}
              disabled={claiming || !user || !hasClaim}>
              {claiming ? 'Claiming…' : 'Claim MRN'}
            </Button>
          )}
        </div>
        {claimError && (
          <p className='text-caption text-danger pt-1' role='alert'>
            {describeTxError(claimError)}
          </p>
        )}
      </Panel>
    </ReadErrorBoundary>
  );
}
