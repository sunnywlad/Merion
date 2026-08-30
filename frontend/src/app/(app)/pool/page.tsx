import AddLiquidity from '@/components/AddLiquidity';
import RemoveLiquidity from '@/components/RemoveLiquidity';
import ClaimableRentPanel from '@/components/ClaimableRentPanel';

export default function PoolPage() {
  return (
    <div className="flex flex-col gap-6">
      <AddLiquidity />
      <ClaimableRentPanel />
      <RemoveLiquidity />
    </div>
  );
}
