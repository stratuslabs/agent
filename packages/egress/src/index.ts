/**
 * One implementation of the address policy, shared.
 *
 * `tool-web` and `tool-browser` both reach the network on an agent's
 * instruction, and a second hand-rolled copy of "which addresses may a tool
 * reach" would not be a drift — it would be an SSRF hole in whichever copy
 * was not updated. So the rule lives here, once, and the packages that
 * enforce it import it.
 */
export {
  assertRequestAllowed,
  checkAddress,
  classifyAddress,
  egressPolicyFrom,
  EgressPolicyError,
  type AddressVerdict,
  type EgressPolicy,
} from './addresses.ts';

export {
  chromiumProxyArgs,
  chromiumProxyOptions,
  createEgressProxy,
  createPinnedLookup,
  policyKeyFor,
  requestThroughPolicy,
  type EgressProxy,
  type PolicyRequestOptions,
  type PolicyResponse,
} from './connect.ts';

export { HOSTILE_URLS, type HostileUrl } from './fixtures.ts';
