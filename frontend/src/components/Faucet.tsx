'use client';

import MintButton from './MintButton';
import MintAllButton from './MintAllButton';
import Panel from '@/components/Panel';
import {tokensInfo} from '@/constants/addresses';
import { Badge } from '@/components/ui/Badge';

const Faucet = () => {
  return(
    <Panel title="Faucet">
      <p className="text-small text-cloud/70 pb-3">
        Mint test tokens for development. Each call mints a fixed amount to the
        connected wallet.
      </p>
      <div className='flex flex-wrap items-center gap-3'>
        {tokensInfo.map((token) => (
          <MintButton key={token.name} name={token.name} address={token.address} />
        ))}
        <span aria-hidden="true" className="text-cloud/30">·</span>
        <MintAllButton tokens={tokensInfo} />
        <Badge variant="beta">Test only</Badge>
      </div>
    </Panel>
  )
}

export default Faucet
