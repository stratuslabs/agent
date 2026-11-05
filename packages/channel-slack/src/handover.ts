/*
 * Who a thread was handed to: one entry of `threadAddressee`, the record
 * the adapter keeps in Slack receipt order of which agent each thread was
 * last handed to. In a module of its own so the adapter's parts outside
 * `index.ts` can name it. Nothing here is public: `index.ts` imports it,
 * and the package's one public entry is unchanged.
 */

// `cold`: rebuilt from a thread read rather than seen live. Those are
// posts only (a mention nobody has answered yet is not one), so the
// owner rule may use them but `holderAt` (who was asked last) may not.
export type Handover = { agentId: string; ts: string; takes?: boolean; cold?: boolean };
