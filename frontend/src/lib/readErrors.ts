export type ReadSource = {
  message: string;
  error: Error | null | undefined;
};

// The two failure levels of useReadContracts (whole-request `error` vs a single `data[i].error`)
// never overlap: a dead request leaves `data` undefined, so the per-entry sources simply don't
// exist to report anything. No dedup needed.
export function collectReadErrors(sources: ReadSource[]): ReadSource[] {
  return sources.filter((source) => source.error);
}
