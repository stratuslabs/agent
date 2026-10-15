// Types for a UI module a test imports (see latest.d.ts).
export interface ServedRuntime {
  provider: string;
  model?: string;
  credentials: string;
  /** Why no run can start on this runtime, when one can't. */
  problem?: string;
}
export interface ServingRow {
  title: string;
  detail: string;
  /** True when `detail` is the reason runs fail, not the credential source. */
  problem: boolean;
}
export const servingRow: (runtime: ServedRuntime) => ServingRow;
