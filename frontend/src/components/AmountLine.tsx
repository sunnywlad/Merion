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
  // the display from the first.
  let content;
  if (isLoading) content = "Chargement...";
  else if (error) content = error.message;
  else if (value === undefined) content = "—";
  else content = formatUnits(value, decimals) + suffix;

  return <li>{label} : {content}</li>;
}
