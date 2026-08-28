import Faucet from '@/components/Faucet';
import MrnGrant from '@/components/MrnGrant';

export default function ToolsPage() {
  return (
    <div className="flex flex-col gap-6">
      <Faucet />
      <MrnGrant />
    </div>
  );
}
