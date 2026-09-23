import type { JsonObject } from '@stratusagent/core';
import type { ParsedSoul } from '@stratusagent/agents';
import type { ClaudeCodeQueryFn } from '@stratusagent/provider-claude-code';
import type { CodexRunTurn } from '@stratusagent/provider-codex';
import {
  type RegisteredProviderName,
  type StratusProviderName,
  isBuiltinProviderName,
  type CredentialProviderName,
} from './provider-names.ts';

/**
 * Who may approve one agent's gated calls, and where they are asked.
 * Approver ids are channel-native (Slack user ids) because that is where
 * the click comes from — mapping them through a Stratus identity would add
 * a lookup that can only ever be wrong.
 */
export interface AgentApprovalConfig {
  /**
   * Slack user ids allowed to decide. Nobody listed means nobody may — an
   * explicit empty array is how an agent is excluded from a global approver
   * list, and is kept distinct from the key being absent, which inherits.
   */
  slackApprovers?: string[];
  /**
   * Conversation to ask in when the turn is not itself in Slack. A turn
   * that arrived through Slack is answered in its own thread regardless.
   */
  slackChannel?: string;
}

/**
 * The longest an approval may wait: Node's maximum `setTimeout` delay.
 * Above it a timer does not wait longer, it fires almost immediately.
 */
export const MAX_APPROVAL_TIMEOUT_MS = 2_147_483_647;

/** The `approvals` block of ~/.stratus/config.json. */
export interface ApprovalsConfig extends AgentApprovalConfig {
  /**
   * How the daemon reaches a person. `headless` refuses every gated call;
   * `remote` parks the turn and asks through a channel. Default `headless`
   * — an unconfigured daemon must not start waiting on humans who were
   * never told they were on the hook.
   */
  mode?: 'headless' | 'remote';
  /** How long a parked call waits before denying itself, in milliseconds. */
  timeoutMs?: number;
  /** Per-agent overrides, keyed by agent id. */
  agents?: Record<string, AgentApprovalConfig>;
}

/**
 * Who counts as an agent's operator on a channel — the authorized
 * principals whose messages arrive as `user` rather than `unknown`.
 *
 * Needed because a channel's own checks establish nothing about who is
 * typing: the Slack adapter admits a message that has a user, is not a bot,
 * has no subtype, and is a DM or a mention — and any member of the
 * workspace can open a DM or type an `@mention`. Without a name here, a
 * stranger's instruction-shaped message would arrive as the trust root, one
 * `memory.remember` away from being the agent's own conclusion. So `user`
 * is earned by being listed, never inferred from the shape of a channel.
 *
 * Read only from a **trusted** config, like `approvals`: who an agent's
 * operator is cannot be a decision a cloned repository makes.
 */
export interface AgentPrincipalsConfig {
  /**
   * Slack user ids whose messages are the operator's. Nobody listed means
   * every sender is `unknown` — an explicit empty array excludes an agent
   * from a global list, and is kept distinct from the key being absent,
   * which inherits.
   */
  slackUsers?: string[];
  /**
   * Who gets a turn at all. `anyone` — the default — admits every sender
   * the adapter's own checks pass, labelling the unlisted ones `unknown`;
   * `principals` refuses everyone not in `slackUsers` before a turn
   * starts, and does not let the agent overhear them either. The label is
   * provenance; this is authorization, and an agent that holds tools
   * wants the second — a stranger's message is not merely uncertain, it
   * is a prompt they chose.
   */
  admit?: PrincipalsAdmit;
}

export type PrincipalsAdmit = 'anyone' | 'principals';

/** The `principals` block of ~/.stratus/config.json. */
export interface PrincipalsConfig extends AgentPrincipalsConfig {
  /** Per-agent overrides, keyed by agent id. */
  agents?: Record<string, AgentPrincipalsConfig>;
}

/**
 * The `api` block of ~/.stratus/config.json — whether `stratus serve` also
 * serves the control API, and where.
 *
 * Read only from a **trusted** config, for the same reason the approvals
 * block is: an auto-discovered project-local `stratus.config.json` can be
 * checked into any repository, and a cloned repo must not be able to decide
 * which interface a daemon binds.
 */
export interface ApiConfig {
  /** Default true when @stratusagent/control-api is installed. */
  enabled?: boolean;
  /** Interface to bind. Default 127.0.0.1 — loopback is the posture. */
  host?: string;
  /** Port to bind. Default 4123. */
  port?: number;
}

/**
 * One plugin's settings: whether it runs, its own configuration, and the
 * per-agent overrides beneath it.
 *
 * Typed as an open object because the keys belong to the plugin, not to
 * this file — the daemon validates them against the manifest's own schema
 * at load time, which is the only place that knows what `roots` means.
 * What this package owns is the three keys the *host* reads.
 */
export interface PluginConfigBlock extends JsonObject {
  /** Default true: a listed plugin runs unless it says otherwise. */
  enabled?: boolean;
  /**
   * Per-agent settings, keyed by agent id, over the defaults above them.
   * The same shape `approvals` already carries — and it matters more here,
   * because for a plugin like `tool-fs` these values are an access boundary
   * between agents rather than a preference.
   */
  agents?: JsonObject;
  /**
   * The operator's per-tool risk word, tool name to `safe`/`gated`/
   * `dangerous`, replacing the manifest's declaration for that name.
   * Host-owned and applied by the registration view — the plugin's code
   * never sees it — because a risk that *lowers* must come from the
   * trusted config, not from the code being judged. Validated against the
   * manifest at load, in `@stratusagent/plugins`.
   */
  toolRisks?: JsonObject;
}

/**
 * The `plugins` block of ~/.stratus/config.json, keyed by **package name**.
 *
 * By package because a plugin's identity is its package, and because a
 * plugin may contribute more than tools — a block keyed by toolset has
 * nowhere to put one that adds a channel and a memory store.
 *
 * Read only from a **trusted** config, and this is the sharpest case of
 * that rule rather than another instance of it: a plugin runs in-process
 * with the daemon, so a list an auto-discovered project-local
 * `stratus.config.json` could write is a list of code a cloned repository
 * gets to execute.
 */
export type PluginsConfig = Record<string, PluginConfigBlock>;

export interface StratusConfigFile {
  provider?: StratusProviderName;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  systemPrompt?: string;
  /** Path to a soul file, resolved relative to the working directory. */
  soul?: string;
  /** Model to retry with when the default model errors mid-run. */
  fallbackModel?: string;
  /** Provider serving the fallback model. Defaults to the main provider. */
  fallbackProvider?: StratusProviderName;
  /** Base URL for an openai-compatible fallback (e.g. a local model). */
  fallbackBaseUrl?: string;
  /**
   * Mark the stable head of each Anthropic request cacheable. Default true.
   * Turn it off for a fleet whose agents take one turn per burst and never
   * read a cached prefix back — there, the write premium is a pure surcharge.
   */
  promptCache?: boolean;
  /** Cache entry lifetime: '5m' (default) or '1h'. */
  promptCacheTtl?: '5m' | '1h';
  /**
   * The per-turn output cap sent to Anthropic. Default 16000.
   *
   * The API requires one, and it is not a budget — nothing is spent for
   * being allowed. It exists here because the provider takes arbitrary
   * model names and a `baseUrl` that may point at a proxy, so the
   * daemon-wide default cannot be right for every model an operator might
   * name: one whose ceiling is below the default would have every request
   * refused before generating, with no way to say otherwise.
   *
   * Raising it past roughly 20000 only works where the request streams —
   * the SDK refuses a non-streaming call whose cap puts its estimated
   * duration past ten minutes. `stratus serve` streams; `stratus run` does
   * not always.
   */
  maxTokens?: number;
  /**
   * Whether an OpenAI-compatible model takes images. Default true; set
   * false for a text-only model (a local runtime, usually), which would
   * otherwise reject every turn of a session an image was sent to.
   */
  vision?: boolean;
  /** Unattended-approval policy for `stratus serve`. */
  approvals?: ApprovalsConfig;
  /** Which channel senders are each agent's operator. Trusted configs only. */
  principals?: PrincipalsConfig;
  /** Control API binding for `stratus serve`. */
  api?: ApiConfig;
  /** Plugins to load, keyed by package name. Trusted configs only. */
  plugins?: PluginsConfig;
  /**
   * Which executor runs tool calls: `local` (the default), or the name a
   * plugin registered. Trusted configs only — an executor is where an
   * agent's commands run, and a cloned repository must not be able to
   * swap a sandbox for the host.
   */
  executor?: string;
  /**
   * Which store backs agent memory: `file` (the default), or the name a
   * plugin registered. Trusted configs only, for the same reason.
   */
  memoryStore?: string;
  /**
   * How many provider turns one dispatched turn may take before it is
   * failed as a runaway. Default 8 (`DEFAULT_MAX_TURNS` in core).
   *
   * The daemon had no way to say this: `--max-turns` reaches `stratus
   * run` only, so every Slack message, scheduled firing, and control-API
   * turn was held to the built-in 8 with no override anywhere. A task
   * needing nine tool calls failed on the ninth — after doing the work of
   * the first eight, and with no partial answer, because the ceiling is
   * checked before the provider call rather than after it.
   *
   * **Trusted configs only.** This is a runaway *and cost* guard, so both
   * directions are a decision a cloned repository must not get to make:
   * raising it spends the operator's tokens, and lowering it to 1 fails
   * every turn the daemon serves. An untrusted config naming it falls
   * through to the global file, as `executor` and `principals` do.
   */
  maxTurns?: number;
}

/** A resolved, ready-to-run fallback model (always a real provider). */
export interface FallbackRuntime {
  provider: 'anthropic' | 'openai' | 'codex' | RegisteredProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
  /**
   * The Agent SDK transport for a *subscription* fallback, which a primary
   * cannot always supply. A fallback inherits `fetch` from its primary
   * because both provider variants carry one — but `queryFn` exists only
   * on the Anthropic variant, so an OpenAI primary with a subscription
   * fallback has nothing to inherit and no other way to say it. Without
   * this, that configuration reaches the real Agent SDK the moment the
   * primary fails.
   */
  queryFn?: ClaudeCodeQueryFn;
  /**
   * The codex harness transport for a codex fallback — `queryFn`'s
   * counterpart, for the same reason: no other primary carries one.
   */
  codexRunTurn?: CodexRunTurn;
  /**
   * A codex fallback with no key runs on the machine's own `codex login`
   * sign-in. Recorded explicitly (from the stored subscription marker)
   * because "no key" alone must not count as a working sign-in — a
   * fallback without one is skipped, not discovered broken mid-rescue.
   */
  codexSubscription?: true;
  /**
   * The primary's caching settings, carried so an Anthropic fallback honors
   * them too. Without this an operator who turned caching off would still
   * pay the write surcharge on every rescued turn — the one setting whose
   * whole purpose is not paying it.
   */
  promptCache?: boolean;
  promptCacheTtl?: '5m' | '1h';
  /**
   * The daemon's `vision` setting, carried to an OpenAI-compatible fallback
   * for the same reason as the caching settings above: a session that has
   * gone fallback-sticky replays its images to the fallback, and a
   * text-only one would reject every turn from then on.
   */
  vision?: boolean;
}

/**
 * What an auto-discovered project-local config asked for and was refused.
 * Recorded rather than warned about at resolution time, because nothing is
 * logging yet when a run resolves; the CLI prints it once the run starts.
 */
export interface IgnoredUntrustedConfig {
  path: string;
  keys: Array<'soul' | 'systemPrompt'>;
}

type RuntimeConfigVariant =
  | { provider: 'demo'; soul?: ParsedSoul; soulPath?: string }
  | {
      provider: 'openai';
      model: string;
      baseUrl: string;
      apiKey: string;
      systemPrompt?: string;
      fetch?: typeof fetch;
      /** See StratusConfigFile.vision. Absent means the adapter's default (true). */
      vision?: boolean;
      soul?: ParsedSoul;
      /** Absolute path the soul was loaded from, for callers that re-read it. */
      soulPath?: string;
      /**
       * The environment variable the API key came from, when it came from
       * the environment rather than the credential store. Callers report
       * it verbatim — guessing the name gets it wrong whenever a custom
       * variable or the legacy prefix supplied the key.
       */
      apiKeyEnvVar?: string;
      fallback?: FallbackRuntime;
    }
  | {
      provider: 'anthropic';
      model: string;
      baseUrl?: string;
      apiKey?: string;
      /** Claude subscription auth (Claude Code setup token). */
      authToken?: string;
      /** See StratusConfigFile.maxTokens. Absent means the adapter's default. */
      maxTokens?: number;
      systemPrompt?: string;
      fetch?: typeof fetch;
      /**
       * The subscription path's transport seam, and the counterpart to
       * `fetch` above: this variant serves both Anthropic modes, and an
       * API key reaches the wire through `fetch` while a subscription
       * token reaches it through the Agent SDK's `query`. Without both,
       * only half of what this config can select is reachable from a
       * test.
       */
      queryFn?: ClaudeCodeQueryFn;
      /** See StratusConfigFile.promptCache. Absent means the adapter's default (on). */
      promptCache?: boolean;
      /** See StratusConfigFile.promptCacheTtl. Absent means the adapter's default ('5m'). */
      promptCacheTtl?: '5m' | '1h';
      soul?: ParsedSoul;
      /** Absolute path the soul was loaded from, for callers that re-read it. */
      soulPath?: string;
      /** See the openai variant — the variable that supplied the key. */
      apiKeyEnvVar?: string;
      fallback?: FallbackRuntime;
    }
  | {
      provider: 'codex';
      model: string;
      /**
       * OpenAI API key for metered billing, handed to the codex harness.
       * Absent means the machine's own `codex login` (ChatGPT) sign-in
       * serves the run — the harness holds those tokens itself, under
       * ~/.codex, and Stratus never reads them.
       */
      apiKey?: string;
      systemPrompt?: string;
      /**
       * Not consumed by the harness itself (codex owns its transport);
       * carried so a cross-provider fallback still inherits the
       * environment's pinned fetch.
       */
      fetch?: typeof fetch;
      /**
       * The harness transport seam — this provider's counterpart to the
       * anthropic variant's `queryFn`. Without it a codex config is the
       * one runtime a test cannot drive.
       */
      codexRunTurn?: CodexRunTurn;
      soul?: ParsedSoul;
      /** Absolute path the soul was loaded from, for callers that re-read it. */
      soulPath?: string;
      /** See the openai variant — the variable that supplied the key. */
      apiKeyEnvVar?: string;
      fallback?: FallbackRuntime;
    }
  | {
      /**
       * A provider a plugin registered. No key, endpoint, or transport
       * rides here: a contributed provider takes its settings from its own
       * config block and its credentials through the manifest-bound
       * resolver, so resolution has nothing to select for it but the model
       * — which it may leave unset, in which case the provider's own
       * default serves.
       */
      provider: RegisteredProviderName;
      model?: string;
      systemPrompt?: string;
      /** Carried so a built-in fallback behind a contributed primary inherits the pinned transport. */
      fetch?: typeof fetch;
      soul?: ParsedSoul;
      soulPath?: string;
      fallback?: FallbackRuntime;
    };

export type RuntimeConfig = RuntimeConfigVariant & {
  ignoredFromUntrustedConfig?: IgnoredUntrustedConfig;
};

/**
 * A runtime served by a built-in provider that carries a sign-in of its
 * own — every variant but `demo` and a plugin's. What the surfaces that
 * explain credentials (`doctor`, the control API's credential source, the
 * override warning) narrow on, so a contributed provider reads as "its
 * plugin's business" there rather than as a missing key.
 */
export type SignedInRuntimeConfig = Extract<RuntimeConfig, { provider: CredentialProviderName }>;

export const isSignedInRuntime = (config: RuntimeConfig): config is SignedInRuntimeConfig =>
  isBuiltinProviderName(config.provider) && config.provider !== 'demo';

/**
 * The provider/model/config selection for one run — the subset of a CLI
 * command (or a gateway dispatch) that config resolution cares about.
 */
export interface RuntimeSelection {
  provider?: StratusProviderName;
  model?: string;
  baseUrl?: string;
  configPath?: string;
  /** Path to a soul file defining the agent to run as. */
  soul?: string;
  /**
   * An already-parsed soul used verbatim instead of loading any file —
   * for callers serving from a cache while the backing file is
   * unreadable. Outranks soul paths and the config file's default soul,
   * so no other agent's soul can substitute its pins. Pass null to
   * resolve with no soul at all (a soul-less agent must not inherit the
   * config file's default soul either).
   */
  presetSoul?: ParsedSoul | null;
  /**
   * An already-loaded config snapshot used instead of reading any file —
   * for long-running callers serving the last known-good config while
   * the file on disk is temporarily broken. Carries the trust flag (and
   * path, for messages) the snapshot was loaded with; an empty config
   * ({ config: {}, trusted: true }) resolves as if no file existed.
   */
  presetConfig?: { config: StratusConfigFile; trusted: boolean; path?: string };
}
