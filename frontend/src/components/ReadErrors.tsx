'use client';

import { useEffect } from "react";
import type { ReadSource } from "@/lib/readErrors";
import Panel from "@/components/Panel";

// One child per failed read, so the logging follows THAT read alone. React mounts this component
// when the read starts failing and unmounts it when it recovers; a sibling appearing or vanishing
// leaves it untouched, which a single effect over the whole array could never achieve.
// The dependency is the viem message, not the source object: the object is rebuilt on every
// render of the parent and would fire the effect every time, while the message is stable as long
// as the failure has the same cause. It also covers the read that keeps failing for a NEW reason,
// a timeout turning into a revert: the displayed line does not move, the log does.
function ReadError({ source }: { source: ReadSource }) {
  const detail = source.error?.message;

  useEffect(() => {
    console.error(detail);
  }, [detail]);

  return <li>{source.message}</li>;
}

export default function ReadErrors({ sources }: { sources: ReadSource[] }) {
  return (
    <Panel>
      <ul>
        {sources.map((source) => <ReadError key={source.message} source={source} />)}
      </ul>
    </Panel>
  );
}
