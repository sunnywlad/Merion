'use client';

import MintButton from './MintButton';
import Panel from '@/components/Panel';
import {tokensInfo} from '@/constants/addresses';

const Faucet = () => {
  return(
    <Panel>
      <p className='font-semibold pb-2'>Faucet</p>
      <div className='flex flex-wrap gap-4'>
        {tokensInfo.map((token) => {
          return <MintButton key={token.name} name={token.name} address={token.address} />
        })}
      </div>
    </Panel>
  )
}

export default Faucet
