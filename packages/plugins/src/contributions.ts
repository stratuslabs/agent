import {
  ChannelRegistry,
  ContributionRegistry,
  channelClaimKey,
  type ChannelContribution,
  type ChannelRegistrationHandle,
  type ChannelTransportSecrets,
  type ExecutorContribution,
  type ExecutorRegistrationHandle,
  type MemoryRegistrationHandle,
  type MemoryStoreContribution,
  type ProviderContribution,
  type ProviderRegistrationHandle,
} from '@stratusagent/core';

import {
  PluginManifestError,
  type PluginManifest,
  type PluginNamedContributionKind,
} from './manifest.ts';

/**
 * Where a plugin's non-tool contributions land once it has loaded whole.
 * A host passes the registries it serves from; the loader supplies private
 * ones for any it omits, so a plugin contributing a kind this host does not
 * carry still loads — recorded, and going nowhere, the way a contributed
 * skill is ignored by a host with no catalog.
 */
export interface ContributionTargets {
  providers: ContributionRegistry<ProviderContribution>;
  channels: ChannelRegistry;
  memory: ContributionRegistry<MemoryStoreContribution>;
  executors: ContributionRegistry<ExecutorContribution>;
}

export const createContributionTargets = (partial: Partial<ContributionTargets> = {}): ContributionTargets => ({
  providers: partial.providers ?? new ContributionRegistry<ProviderContribution>(),
  channels: partial.channels ?? new ChannelRegistry(),
  memory: partial.memory ?? new ContributionRegistry<MemoryStoreContribution>(),
  executors: partial.executors ?? new ContributionRegistry<ExecutorContribution>(),
});

/**
 * Which package owns each registered name, per kind, across every plugin
 * a loader has committed — so a collision can name both packages, the way
 * the tool `owners` map does. Channels key on (agent, kind).
 */
export interface ContributionOwners {
  providers: Map<string, string>;
  channels: Map<string, string>;
  memory: Map<string, string>;
  executors: Map<string, string>;
}

export const createContributionOwners = (): ContributionOwners => ({
  providers: new Map(),
  channels: new Map(),
  memory: new Map(),
  executors: new Map(),
});

/**
 * How the host answers a channel plugin's request for its transport
 * secrets: the values under `channels.<kind>.<agentId>` in the credential
 * store, by agent. The host owns this path — see
 * `ChannelRegistrationHandle.transportSecrets` in `@stratusagent/core`.
 */
export type ChannelSecretSource = (kind: string) => Promise<ChannelTransportSecrets>;

/** What the daemon knows a loaded plugin contributed besides tools and skills. */
export interface PluginContributionRecords {
  providers: string[];
  channels: Array<{ kind: string; agents: string[] }>;
  memory: string[];
  executors: string[];
}

const KIND_LABEL: Record<PluginNamedContributionKind, string> = {
  providers: 'provider',
  channels: 'channel',
  memory: 'memory store',
  executors: 'executor',
};

/**
 * The manifest-bound views a plugin's `setup()` registers providers,
 * channels, memory stores, and executors through.
 *
 * Same reasoning as `ManifestBoundToolRegistry`, four kinds over: the
 * manifest says what a plugin *claims*, and only a view that checks
 * registrations against it makes the claim enforceable. A plugin that
 * declares a channel and registers a provider is refused at load, naming
 * the package and the undeclared kind; two plugins registering the same
 * provider name are refused rather than one silently winning.
 *
 * Staged, not committed, for the same reason tools are: a plugin that
 * registers a provider and then throws must not leave the provider live.
 * Unlike the tool view, nothing here stays live after commit — a provider
 * or an executor has no reconnect-time discovery to serve, and a
 * registration after `setup()` returned is refused as the mistake it is.
 */
export class ManifestBoundContributions {
  readonly providers: ProviderRegistrationHandle;

  readonly channels: ChannelRegistrationHandle;

  readonly memory: MemoryRegistrationHandle;

  readonly executors: ExecutorRegistrationHandle;

  private readonly manifest: PluginManifest;

  private readonly targets: ContributionTargets;

  private readonly owners: ContributionOwners;

  private readonly channelSecrets: ChannelSecretSource | undefined;

  private readonly stagedProviders = new Map<string, ProviderContribution>();

  private readonly stagedMemory = new Map<string, MemoryStoreContribution>();

  private readonly stagedExecutors = new Map<string, ExecutorContribution>();

  private readonly stagedChannels: ChannelContribution[] = [];

  private committed = false;

  constructor(options: {
    manifest: PluginManifest;
    targets: ContributionTargets;
    owners: ContributionOwners;
    channelSecrets?: ChannelSecretSource;
  }) {
    this.manifest = options.manifest;
    this.targets = options.targets;
    this.owners = options.owners;
    this.channelSecrets = options.channelSecrets;
    this.providers = { register: (contribution) => this.registerProvider(contribution) };
    this.channels = {
      register: (contribution) => this.registerChannel(contribution),
      transportSecrets: (kind) => this.transportSecrets(kind),
    };
    this.memory = { register: (contribution) => this.registerMemory(contribution) };
    this.executors = { register: (contribution) => this.registerExecutor(contribution) };
  }

  private assertDeclared(kind: PluginNamedContributionKind, name: string): void {
    if (this.committed) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName} tried to register ${KIND_LABEL[kind]} ${name} after it had loaded. `
        + 'Providers, channels, memory stores, and executors register during setup().',
      );
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName} tried to register a ${KIND_LABEL[kind]} with no name.`,
      );
    }
    if (!this.manifest.contributes[kind].some((declared) => declared.name === name)) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName} tried to register ${KIND_LABEL[kind]} ${name}, which its manifest does not declare. `
        + `Add it to contributes.${kind} in the package's stratus manifest.`,
      );
    }
  }

  private assertUnclaimed(kind: Exclude<PluginNamedContributionKind, 'channels'>, name: string, staged: Map<string, unknown>): void {
    if (staged.has(name)) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName} registered ${KIND_LABEL[kind]} ${name} twice.`,
      );
    }
    const owner = this.owners[kind].get(name);
    if (owner !== undefined) {
      throw new PluginManifestError(
        `${KIND_LABEL[kind]} name collision: ${name} is contributed by both ${owner} and ${this.manifest.packageName}. `
        + `Disable one of them; a ${KIND_LABEL[kind]} name is unique per install.`,
      );
    }
    if (this.targets[kind].has(name)) {
      throw new PluginManifestError(
        `${KIND_LABEL[kind]} name collision: ${name} is already registered by the host. `
        + `Plugin ${this.manifest.packageName} cannot replace it.`,
      );
    }
  }

  private registerProvider(contribution: ProviderContribution): void {
    this.assertDeclared('providers', contribution.name);
    if (typeof contribution.create !== 'function') {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName}: provider ${contribution.name} has no create(selection). A contributed provider is a factory — see ProviderContribution.`,
      );
    }
    this.assertUnclaimed('providers', contribution.name, this.stagedProviders);
    this.stagedProviders.set(contribution.name, contribution);
  }

  private registerMemory(contribution: MemoryStoreContribution): void {
    this.assertDeclared('memory', contribution.name);
    if (!contribution.store || typeof contribution.store.append !== 'function') {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName}: memory store ${contribution.name} is not an AgentMemoryStore.`,
      );
    }
    this.assertUnclaimed('memory', contribution.name, this.stagedMemory);
    this.stagedMemory.set(contribution.name, contribution);
  }

  private registerExecutor(contribution: ExecutorContribution): void {
    this.assertDeclared('executors', contribution.name);
    if (!contribution.executor || typeof contribution.executor.execute !== 'function') {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName}: executor ${contribution.name} is not an Executor.`,
      );
    }
    this.assertUnclaimed('executors', contribution.name, this.stagedExecutors);
    this.stagedExecutors.set(contribution.name, contribution);
  }

  private registerChannel(contribution: ChannelContribution): void {
    const kind = contribution.adapter?.name;
    this.assertDeclared('channels', kind);
    if (typeof contribution.adapter.start !== 'function' || typeof contribution.adapter.stop !== 'function') {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName}: channel ${kind} is not a ChannelAdapter (it needs start and stop).`,
      );
    }
    if (!Array.isArray(contribution.agents)) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName}: channel ${kind} must say which agents it carries.`,
      );
    }
    const seen = new Set<string>();
    for (const agentId of contribution.agents) {
      if (seen.has(agentId)) {
        throw new PluginManifestError(
          `Plugin ${this.manifest.packageName} registered channel ${kind} for agent ${agentId} twice.`,
        );
      }
      seen.add(agentId);
      this.assertChannelUnclaimed(kind, agentId);
    }
    this.stagedChannels.push(contribution);
  }

  private assertChannelUnclaimed(kind: string, agentId: string): void {
    const key = channelClaimKey(kind, agentId);
    if (this.stagedChannels.some((staged) => staged.adapter.name === kind && staged.agents.includes(agentId))) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName} registered channel ${kind} for agent ${agentId} twice.`,
      );
    }
    const owner = this.owners.channels.get(key);
    if (owner !== undefined) {
      throw new PluginManifestError(
        `channel collision: ${kind} for agent ${agentId} is contributed by both ${owner} and ${this.manifest.packageName}. `
        + 'Disable one of them; an agent is carried on each channel kind by one adapter.',
      );
    }
    if (this.targets.channels.claimed(kind, agentId)) {
      throw new PluginManifestError(
        `channel collision: ${kind} for agent ${agentId} is already carried by the host. `
        + `Plugin ${this.manifest.packageName} cannot replace it.`,
      );
    }
  }

  private async transportSecrets(kind: string): Promise<ChannelTransportSecrets> {
    if (!this.manifest.contributes.channels.some((declared) => declared.name === kind)) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName} asked for the transport secrets of channel ${kind}, which its manifest does not declare. `
        + 'Add it to contributes.channels in the package\'s stratus manifest.',
      );
    }
    if (!this.channelSecrets) {
      throw new Error(
        `This host stores no channel transport secrets, so channel ${kind} cannot start here. `
        + 'A channel runs under stratus serve, which reads them from ~/.stratus/credentials.json.',
      );
    }
    return this.channelSecrets(kind);
  }

  /**
   * Refuse now if committing would collide — checked before anything else
   * of the plugin lands, so a plugin never ends up with its tools live and
   * its provider refused. Registration already checked all of this; a
   * second pass costs nothing and holds if a host registers between.
   */
  preflightCommit(): void {
    for (const name of this.stagedProviders.keys()) {
      this.assertCommittable('providers', name);
    }
    for (const name of this.stagedMemory.keys()) {
      this.assertCommittable('memory', name);
    }
    for (const name of this.stagedExecutors.keys()) {
      this.assertCommittable('executors', name);
    }
    for (const staged of this.stagedChannels) {
      for (const agentId of staged.agents) {
        const key = channelClaimKey(staged.adapter.name, agentId);
        const owner = this.owners.channels.get(key);
        if (owner !== undefined || this.targets.channels.claimed(staged.adapter.name, agentId)) {
          throw new PluginManifestError(
            `channel collision: ${staged.adapter.name} for agent ${agentId} is contributed by both ${owner ?? 'the host'} and ${this.manifest.packageName}.`,
          );
        }
      }
    }
  }

  private assertCommittable(kind: Exclude<PluginNamedContributionKind, 'channels'>, name: string): void {
    const owner = this.owners[kind].get(name);
    if (owner !== undefined || this.targets[kind].has(name)) {
      throw new PluginManifestError(
        `${KIND_LABEL[kind]} name collision: ${name} is contributed by both ${owner ?? 'the host'} and ${this.manifest.packageName}.`,
      );
    }
  }

  /** Land everything staged in the shared registries and record ownership. */
  commit(): PluginContributionRecords {
    this.preflightCommit();
    const packageName = this.manifest.packageName;
    for (const [name, contribution] of this.stagedProviders) {
      this.targets.providers.register(name, contribution);
      this.owners.providers.set(name, packageName);
    }
    for (const [name, contribution] of this.stagedMemory) {
      this.targets.memory.register(name, contribution);
      this.owners.memory.set(name, packageName);
    }
    for (const [name, contribution] of this.stagedExecutors) {
      this.targets.executors.register(name, contribution);
      this.owners.executors.set(name, packageName);
    }
    for (const contribution of this.stagedChannels) {
      this.targets.channels.register(contribution);
      for (const agentId of contribution.agents) {
        this.owners.channels.set(channelClaimKey(contribution.adapter.name, agentId), packageName);
      }
    }
    this.committed = true;
    return {
      providers: [...this.stagedProviders.keys()],
      channels: this.stagedChannels.map((contribution) => ({
        kind: contribution.adapter.name,
        agents: [...contribution.agents],
      })),
      memory: [...this.stagedMemory.keys()],
      executors: [...this.stagedExecutors.keys()],
    };
  }
}
