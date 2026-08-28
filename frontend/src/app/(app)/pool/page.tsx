import AddLiquidity from '@/components/AddLiquidity';
import RemoveLiquidity from '@/components/RemoveLiquidity';

export default function PoolPage() {
  return (
    <div className="flex flex-col gap-6">
      <AddLiquidity />
      <RemoveLiquidity />
    </div>
  );
}
