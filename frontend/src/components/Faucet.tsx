'use client';

import MintButton from './MintButton';
import MintAllButton from './MintAllButton';
import Panel from '@/components/Panel';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';

// Panneau Faucet : un bouton de mint par mock BTC, plus un bouton « tout minter ».
const Faucet = () => {
  const { tokens } = useDeployedChainId();
  return(
    <Panel title="Faucet">
      <div className='flex flex-wrap items-center gap-3'>
        {tokens.map((token) => (
          <MintButton key={token.name} name={token.name} address={token.address} />
        ))}
        <span aria-hidden="true" className="text-cloud/30">·</span>
        <MintAllButton tokens={tokens} />
      </div>
    </Panel>
  )
}

export default Faucet
