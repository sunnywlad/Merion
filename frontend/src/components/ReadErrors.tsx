import type { ReadSource } from "@/lib/readErrors";
import Panel from "@/components/Panel";

// One line per failed read. `source.message` is the label the caller wrote
// ("Failed to read the pool reserves."), never the underlying viem error —
// no raw message reaches the screen, and nothing is logged to the console.
export default function ReadErrors({ sources }: { sources: ReadSource[] }) {
  return (
    <Panel>
      <ul>
        {sources.map((source) => (
          <li key={source.message}>{source.message}</li>
        ))}
      </ul>
    </Panel>
  );
}
