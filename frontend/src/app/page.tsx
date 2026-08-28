import Connection from '@/components/Connection';
import Reserves from '@/components/Reserves';
import Balances from '@/components/Balances';
import Faucet from '@/components/Faucet';
import AddLiquidity from '@/components/AddLiquidity';
import RemoveLiquidity from '@/components/RemoveLiquidity';
import Swap from '@/components/Swap';
import MandatePanel from '@/components/MandatePanel';
import AuctionPanel from '@/components/AuctionPanel';
import MrnGrant from '@/components/MrnGrant';

export default function Home() {
  return (
    <div className='flex flex-col lg:flex-row lg:items-stretch'>
      {/* Lecture seule : aucune action ne part d'ici, d'où l'absence de Panel. */}
      <aside className='shrink-0 p-4 border-b lg:w-72 lg:border-b-0 lg:border-r'>
        <Reserves />
        <div className='mt-6 pt-6 border-t'>
          <MandatePanel />
        </div>
        <div className='mt-6 pt-6 border-t'>
          <Connection>
            <Balances />
          </Connection>
        </div>
      </aside>

      <main className='min-w-0 flex-1 p-4'>
        <p className='text-xl font-bold pb-2'>Welcome to Merion</p>
        <div className='grid gap-4 grid-cols-1 xl:grid-cols-2'>
          <AddLiquidity />
          <RemoveLiquidity />
          <Swap />
          <Faucet />
          <MrnGrant />
          <AuctionPanel />
        </div>
      </main>
    </div>
  );
}
