'use client';

import { useState } from 'react';
import { useConnection, useWriteContract, usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { parseUnits, Address } from 'viem';
import { mockWrappedBTCAbi } from '@/constants/abi';

// Même montant que `MintButton`, gardé en propre plutôt qu'importé pour que
// `MintAllButton` reste lisible seul et que la constante puisse diverger
// sans casser l'autre.
const mintedAmount = parseUnits("10", 8);

const MintAllButton = ({ tokens }: { tokens: { name: string; address: Address }[] }) => {
  const userAddress = useConnection().address;
  const publicClient = usePublicClient();
  const { mutateAsync } = useWriteContract();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Trois mints enchaînés dans l'ordre du tableau, chacun attendant son reçu
  // avant le suivant. Une réversion en cours de route laisse la boucle
  // `catch` poser l'erreur et le `finally` dégriser le bouton ; les mints
  // déjà confirmés ne sont pas rejoués (l'utilisateur relance s'il le faut).
  const handleMintAll = async () => {
    if (!userAddress || !publicClient) return;
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
        await publicClient.waitForTransactionReceipt({ hash });
      }
      queryClient.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <button
        className='border rounded px-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
        onClick={handleMintAll}
        disabled={pending || !userAddress}
      >
        {pending ? 'Mint des trois en cours…' : 'Mint 10 × 3'}
      </button>
      {error && <p>{error}</p>}
    </div>
  );
};

export default MintAllButton;
