'use client';

import MintButton from './MintButton';
import MintAllButton from './MintAllButton';
import Panel from '@/components/Panel';
import { useAddresses } from '@/hooks/useAddresses';
import { Badge } from '@/components/ui/Badge';

const Faucet = () => {
  const { tokens } = useAddresses();
  return(
    <Panel title="Faucet">
      <p className="text-small text-cloud/70 pb-3">
        Mint test tokens for development. Each call mints a fixed amount to the
        connected wallet.
      </p>
      <div className='flex flex-wrap items-center gap-3'>
        {tokens.map((token) => (
          <MintButton key={token.name} name={token.name} address={token.address} />
        ))}
        <span aria-hidden="true" className="text-cloud/30">·</span>
        <MintAllButton tokens={tokens} />
        <Badge variant="beta">Test only</Badge>
      </div>
    </Panel>
  )
}

export default Faucet
