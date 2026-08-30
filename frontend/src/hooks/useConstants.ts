import { useMerionReadContracts } from '@/hooks/useMerionReadContracts';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import {poolAbi} from '@/constants/abi';

// Les constantes du Pool qui ne bougent jamais : denominateurs et bornes de fee, bandes de
// reserve, split protocole/gestionnaire. Un seul multicall, staleTime infini : une lecture par session.
export function useConstants() {
  const { pool } = useDeployedChainId();
  const { data, isLoading, error } = useMerionReadContracts({
    contracts: [{
        address: pool,
        abi: poolAbi,
        functionName: 'FEE_DEN',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'MAX_FEE_NUM',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'MIN_FEE_NUM',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'floor',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'ceiling',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'NOMINAL_FEE_NUM',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'PROTOCOL_FEE_BPS',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'SPLIT_DEN',
        args: []
      }
    ] as const,
    query: { staleTime: Infinity }
  })
  return {
    feeDen: data?.[0],
    maxFeeNum: data?.[1],
    minFeeNum: data?.[2],
    /**
     * Bandes de reserve, en pourcentage de la somme post-swap. Toutes deux `constant` dans
     * `Pool.sol`, sans setter, donc lues une seule fois par session. Embarquees dans ce
     * multicall que Swap paie deja : un hook separe serait un second aller-retour pour deux uint8.
     */
    floorBps: data?.[3],
    ceilingBps: data?.[4],
    /**
     * Split de fee, necessaire pour reproduire la part d'une entree qui atteint vraiment les
     * reserves : `Pool.swap` verse les coupes dans des registres pull-only. `NOMINAL_FEE_NUM`
     * est immutable (constructeur), les deux autres constant : leur place est ici.
     */
    nominalFeeNum: data?.[5],
    protocolFeeBps: data?.[6],
    splitDen: data?.[7],
    isLoading,
    error
  }
}
