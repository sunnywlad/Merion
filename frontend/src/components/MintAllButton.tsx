'use client';

import { useState } from 'react';
import { useConnection, useWriteContract, usePublicClient, useWatchAsset } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { parseUnits, Address } from 'viem';
import { mockWrappedBTCAbi } from '@/constants/abi';
import { describeTxError } from '@/lib/txError';
import { useIsWrongNetwork } from '@/hooks/useIsWrongNetwork';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';

// Même montant que `MintButton`, gardé en propre plutôt qu'importé pour que
// `MintAllButton` reste lisible seul et que la constante puisse diverger
// sans casser l'autre.
const mintedAmount = parseUnits("10", 8);
// I.6 — les trois mocks BTC codent `decimals()` en dur à 8, comme dans
// `MintButton`. `watchAsset` a besoin de cette valeur pour proposer
// l'ajout au wallet.
const BTC_MOCK_DECIMALS = 8;

const MintAllButton = ({ tokens }: { tokens: readonly { name: string; address: Address }[] }) => {
  const userAddress = useConnection().address;
  const wrongNetwork = useIsWrongNetwork();
  const publicClient = usePublicClient();
  const { mutateAsync } = useWriteContract();
  const { mutate: watchAsset } = useWatchAsset();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Trois mints enchaînés dans l'ordre du tableau, chacun attendant son reçu
  // avant le suivant. Une réversion en cours de route laisse la boucle
  // `catch` poser l'erreur et le `finally` dégriser le bouton ; les mints
  // déjà confirmés ne sont pas rejoués (l'utilisateur relance s'il le faut).
  // Après chaque reçu, `watchAsset` propose l'ajout du token au wallet —
  // même comportement que `MintButton`, appliqué aux trois tokens.
  const handleMintAll = async () => {
    if (!userAddress || !publicClient || wrongNetwork) return;
    setError(null);
    setPending(true);
    try {
      for (const token of tokens) {
        const hash = await mutateAsync({
          address: token.address,
          abi: mockWrappedBTCAbi,
          functionName: 'mint',
          args: [userAddress, mintedAmount]
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === 'success') {
          watchAsset({
            type: 'ERC20',
            options: { address: token.address, symbol: token.name, decimals: BTC_MOCK_DECIMALS },
          });
        }
      }
      queryClient.invalidateQueries();
    } catch (e) {
      setError(describeTxError(e));
    } finally {
      setPending(false);
    }
  };

  const stateTone: 'success' | 'warning' | 'danger' | 'neutral' = error
    ? 'danger'
    : pending
      ? 'warning'
      : 'neutral';
  const stateLabel = error
    ? 'Mint failed'
    : pending
      ? 'Minting all tokens'
      : wrongNetwork
        ? 'Wrong network'
        : !userAddress
          ? 'Connect a wallet'
          : 'Ready to mint';

  return (
    <div className="flex flex-col gap-2">
      <Button
        level="primary"
        onClick={handleMintAll}
        aria-busy={pending || undefined}
        disabled={pending || !userAddress || wrongNetwork}
      >
        {pending ? 'Minting all three…' : 'Mint 10 × 3'}
      </Button>
      <StatusDot tone={stateTone} label={stateLabel} />
      {error && (
        <p className="text-caption text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

export default MintAllButton;
