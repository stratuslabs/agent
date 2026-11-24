// Types for the UI module a test imports. See grants.d.ts for why.
/** A schedule's cadence (`describeCadence`'s compact form) in words. */
export const humanCadence: (cadence: unknown) => string;
/** Recurring, once, or event. */
export const cadenceKind: (cadence: unknown) => 'recurring' | 'once' | 'event';
