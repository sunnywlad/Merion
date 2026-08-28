import { formatUnits } from 'viem';

type AmountLineProps = {
  label: string;
  isLoading: boolean;
  error: Error | null | undefined;
  value: bigint | undefined;
  decimals?: number;
  suffix?: string;
};

// Pure display: it knows nothing of contracts, it only picks which of the four states to show.
// The value arrives RAW because props are evaluated before this component runs: formatting at
// the call site would throw on `undefined` before any branch here could protect it.
export default function AmountLine({
  label,
  isLoading,
  error,
  value,
  decimals = 8,
  suffix = ""
}: AmountLineProps) {

  // Order matters: while loading, `value` is undefined too, and the third branch would steal
  // the display from the first. Per brand book §2, numeric values carry no semantic color
  // by default — Success is reserved for healthy *statuses*, not for "a number that exists".
  let content: string;
  let contentClass: string;
  if (isLoading) {
    content = 'Loading...';
    contentClass = 'text-cloud/60';
  } else if (error) {
    content = error.message;
    contentClass = 'text-danger';
  } else if (value === undefined) {
    content = '—';
    contentClass = 'text-cloud/60';
  } else {
    content = `${formatUnits(value, decimals)}${suffix ? ' ' + suffix : ''}`;
    contentClass = 'text-cloud';
  }

  return (
    <li className="flex items-baseline justify-between gap-4 py-1 text-body">
      <span className="text-cloud/80">{label}</span>
      <span className={`font-mono text-code ${contentClass}`}>{content}</span>
    </li>
  );
}
