/*
 * The credential contract: whose a named credential is, how a request for
 * one reaches a person, the resolver that hands an agent its credentials,
 * and the allowlist check that keeps them scoped per agent. A module of its
 * own because channel plugins and hosts build against it. `index.ts`
 * re-exports every name, so the package's one public entry is unchanged.
 */
import {
  type AgentDefinition,
} from './index.ts';

/**
 * Resolves named credentials for an agent. Implementations must enforce the
 * agent's `credentials` allowlist so secrets stay scoped per agent.
 */
/** Whose a named credential is: one agent's own, or the whole fleet's. */
export type CredentialScope = 'agent' | 'shared';

/**
 * How a credential request reaches a person: a form in the conversation's
 * own channel, or a one-time link the agent passes on.
 */
export type CredentialDelivery = 'form' | 'link';

export interface CredentialResolver {
  resolve(agent: AgentDefinition, name: string): Promise<string | undefined>;
  /**
   * The environment variables this agent's stored keys were bound to, with
   * their values, read now: an approver answered a form that said the key
   * would be readable by this agent's shell as that variable, or an
   * operator bound it with `stratus credential env`. Only names the agent's
   * `credentials:` list grants, by `assertCredentialAllowed`'s rule
   * (skipped rather than thrown), and a bound name with nothing stored is
   * left out.
   *
   * Optional: a host that omits it has no bindings, and its shell commands
   * see only what the operator's config maps. A plugin is handed it only
   * when its manifest says `"envBindings": true`, since the values it
   * returns are names the manifest never listed.
   */
  envBindings?(agent: AgentDefinition): Promise<Record<string, string>>;
}

export interface ScopedCredentials {
  get(name: string): Promise<string>;
}

/**
 * The allowlist half of every `CredentialResolver`, so a second
 * implementation cannot quietly become a second policy.
 *
 * This is the check that makes an agent's `credentials:` list mean
 * something, and it belongs to the contract rather than to whichever
 * resolver a host happens to install — a file-backed resolver that forgot
 * it would hand every agent every key while still satisfying the interface.
 */
export const assertCredentialAllowed = (agent: AgentDefinition, name: string): void => {
  if (!agent.credentials?.includes(name)) {
    throw new Error(`Agent ${agent.id} is not allowed to access credential: ${name}`);
  }
};

export class EnvCredentialResolver implements CredentialResolver {
  private readonly env: Record<string, string | undefined>;

  // Pass process.env (or any map) explicitly — core stays platform-agnostic.
  constructor(env: Record<string, string | undefined>) {
    this.env = env;
  }

  async resolve(agent: AgentDefinition, name: string): Promise<string | undefined> {
    assertCredentialAllowed(agent, name);
    return this.env[name];
  }
}

export const scopeCredentials = (
  agent: AgentDefinition,
  resolver: CredentialResolver,
): ScopedCredentials => ({
  async get(name) {
    const value = await resolver.resolve(agent, name);
    if (value === undefined) {
      throw new Error(`Credential not found: ${name}`);
    }
    return value;
  },
});
