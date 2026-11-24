// Types for the UI module a test imports. See grants.d.ts for why.
/** Apply a "prop: value; …" style string one CSSOM property at a time. */
export const applyStyle: (
  node: { style: { setProperty: (name: string, value: string, priority: string) => void } },
  text: string,
) => void;
