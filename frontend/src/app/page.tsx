import Connection from '@/components/Connection';
import Reserves from '@/components/Reserves';
import Balances from '@/components/Balances';
import Faucet from '@/components/Faucet';
import AddLiquidity from '@/components/AddLiquidity';
import RemoveLiquidity from '@/components/RemoveLiquidity';
import Swap from '@/components/Swap';

export default function Home() {
  return (
    <>
      <div className='p-4'>
        <p className='text-xl font-bold pb-2'>Welcome to Merion</p>
        <div className='grid gap-4 pb-2 grid-cols-1 md:grid-cols-2 xl:grid-cols-3'>
          <Reserves />
          <Connection>
            <Balances />
          </Connection>
          <AddLiquidity />
          <RemoveLiquidity />
          <Swap />
        </div>
        <Faucet />

      </div>
    </>
  );
}
