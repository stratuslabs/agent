import { randomUUID } from 'node:crypto';
import {
  AgentRunner,
  EventBus,
  SkillRegistry,
  ToolRegistry,
  missingSkillRequirements,
  describeToolAllowlistFinding,
  unmatchedToolAllowlist,
  type AgentDefinition,
  type JsonValue,
  type Session,
  type StratusEvent,
} from '@stratusagent/core';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';
import { loadPlugins, type LoadedPlugin } from '@stratusagent/plugins';
import {
  createForgetTool,
  createRecallTool,
  createRememberTool,
  GATEWAY_ONLY_TOOL_NAMES,
} from '@stratusagent/agents';
import {
  createDemoTool,
  createFileCredentialResolver,
  createFileMemoryStore,
  createRuntimeProvider,
  defaultApiKeyEnvName,
  DEFAULT_STRATUS_AGENT,
  loadCredentials,
  loadOperatorSkills,
  memoryFilePath,
  migrateLegacyMemory,
  readNonEmptyString,
  readProcessEnv,
  resolveRuntimeConfig as resolveStateRuntimeConfig,
  withLegacyDefaultMemories,
  workspacesDirPath,
  type RuntimeSelection,
  type RuntimeConfig,
} from '@stratusagent/state';
import { createApprovalPolicy } from './approvals.ts';
import type { CliStreams, CliEnvironment } from './environment.ts';
import { formatEvent } from './events.ts';
import { writeLine, stringifyValue } from './io.ts';
import type { CliApprovalMode, ParsedRunCommand } from './parse.ts';
import { loadServePlugins } from './trusted-config.ts';

/**
 * Kept with its historical CLI signature: a parsed run command is a
 * RuntimeSelection plus CLI-only fields the resolver ignores.
 *
 * Those fields are *permitted*, not required. Demanding a whole
 * `ParsedRunCommand` made the type claim the resolver cared about
 * `approvals`, `format`, and `events` — it reads none of them — so every
 * caller with a selection in hand had to invent values to get past it.
 */
export const resolveRuntimeConfig = (
  command: RuntimeSelection & Partial<Omit<ParsedRunCommand, keyof RuntimeSelection>>,
  env: CliEnvironment = {},
): Promise<RuntimeConfig> => resolveStateRuntimeConfig(command, env);

/**
 * A saved subscription sign-in silently demoted to per-token billing is the
 * one config surprise that costs money — an API key in the environment
 * outranks the stored credential, and the run otherwise looks identical.
 * Detected from the resolved config: an apiKey where the stored credential
 * is a subscription token means the environment won.
 */
export const warnOnCredentialOverride = async (
  runtime: RuntimeConfig,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<void> => {
  if (runtime.provider === 'demo') {
    return;
  }
  const credentials = await loadCredentials(env);
  const processEnv = readProcessEnv(env);
  // The resolver records the variable that actually won — guessing it here
  // would name the wrong one whenever a custom apiKeyEnv supplied the key,
  // sending the reader to unset something that was never the cause.
  const primaryOverride = runtime.apiKey !== undefined
    ? { provider: runtime.provider, envVar: runtime.apiKeyEnvVar }
    : undefined;
  // Both subscription sign-ins demote the same way: a Claude setup token
  // and the codex ChatGPT marker each lose to an environment API key, and
  // the run otherwise looks identical while billing per token.
  for (const target of ['anthropic', 'codex'] as const) {
    if (credentials[target]?.type !== 'oauth_token') {
      continue;
    }
    const planName = target === 'anthropic'
      ? 'Claude subscription sign-in'
      : 'ChatGPT (codex login) sign-in';
    const primary = primaryOverride?.provider === target ? primaryOverride.envVar : undefined;
    // A fallback demoted the same way costs exactly as much, and only bites
    // once the primary is already failing — the worst moment to discover it.
    // The fallback path consults the provider's own conventional variable.
    const conventionalVar = defaultApiKeyEnvName(target);
    const fallbackVar = runtime.fallback?.provider === target
      && runtime.fallback.apiKey !== undefined
      && readNonEmptyString(processEnv[conventionalVar]) === runtime.fallback.apiKey
      ? conventionalVar
      : undefined;
    const culprit = primary ?? fallbackVar;
    if (!culprit) {
      continue;
    }
    writeLine(
      streams.stderr,
      `Warning: ${culprit} in your environment outranks the ${planName} saved by \`stratus setup\`, `
      + `so ${primary ? 'this run is' : 'a fallback retry would be'} billed per token instead of through your plan. `
      + 'Unset it to use the subscription, or run `stratus doctor` to see everything that is being overridden.',
    );
  }
};

// The shared wiring behind every conversational command: memory (with
// legacy migration), tools, events, provider (with fallback), and the
// agent the runtime resolved. run uses it for one shot; chat keeps the
// runner alive and resumes the same session turn after turn.
export const createAgentRuntime = async (
  streams: CliStreams,
  options: {
    events?: boolean;
    /** Replaces the default event printer when provided. */
    onEvent?: (event: StratusEvent) => void;
    /** Answers --approvals ask questions when the caller owns stdin. */
    askApproval?: (prompt: string) => Promise<string>;
    runtime: RuntimeConfig;
    approvals?: CliApprovalMode;
    /** The mode came from `defaultApprovalMode`, not from a flag. */
    approvalsDefaulted?: boolean;
    maxTurns?: number;
    env?: CliEnvironment;
    /** The config this command was pinned to, for reading its `plugins` block. */
    configPath?: string;
  },
) => {
  const runEnv = options.env ?? {};
  await migrateLegacyMemory(runEnv);
  const memory = withLegacyDefaultMemories(createFileMemoryStore(memoryFilePath(runEnv)));

  const tools = new ToolRegistry();
  tools.register(createDemoTool());
  tools.register(createRememberTool(memory));
  tools.register(createRecallTool(memory));
  tools.register(createForgetTool(memory));

  // The same skills the daemon would serve, from the same directory, for
  // the same reason the plugins below match: a skill that routes in
  // `stratus run` routes in `stratus serve`, and one that is broken is
  // broken (and warned about) in both. The runner registers `skill.read`
  // itself, gated on the soul enabling any skill.
  const skills = new SkillRegistry();
  await loadOperatorSkills(runEnv, skills, (line) => {
    writeLine(streams.stderr, `Warning: ${line}`);
  });

  const bus = new EventBus({
    onError: (error) => {
      writeLine(streams.stderr, `Warning: event handler failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  if (options.onEvent) {
    const onEvent = options.onEvent;
    bus.subscribe(async (event) => {
      onEvent(event);
    });
  } else if (options.events ?? true) {
    bus.subscribe(async (event) => {
      const line = formatEvent(event);
      if (line) {
        writeLine(streams.stdout, line);
      }
    });
  }

  // The same plugins the daemon would load, from the same trusted config,
  // so a tool that works in `stratus run` works in `stratus serve` and a
  // tool that is missing is missing in both. A local test that silently ran
  // a different toolset than the daemon would be worse than no local test.
  const pluginsConfig = await loadServePlugins(runEnv, options.configPath, (line) => {
    writeLine(streams.stderr, `Warning: ${line}`);
  });
  const loadedPlugins: LoadedPlugin[] = [];
  if (Object.keys(pluginsConfig).length > 0) {
    const result = await loadPlugins({
      config: pluginsConfig,
      host: {
        resolve: (specifier) => import.meta.resolve(specifier),
        import: (specifier) => import(specifier),
      },
      tools,
      skills,
      bus,
      credentials: createFileCredentialResolver(runEnv),
      workspaceRoot: workspacesDirPath(runEnv),
    });
    loadedPlugins.push(...result.loaded);
    for (const failure of result.failures) {
      writeLine(streams.stderr, `Warning: plugin ${failure.package} did not load: ${failure.reason}`);
    }
  }

  // The Claude Code runtime executes kernel tools by calling back into the
  // runner built just below — late-bound because the runner needs the
  // provider first.
  let hostedRunner: AgentRunner | undefined;
  const runtimeProvider = createRuntimeProvider(
    options.runtime,
    (error) => {
      const fallback = options.runtime.provider === 'demo' ? undefined : options.runtime.fallback;
      writeLine(
        streams.stderr,
        `Warning: the default model failed (${error instanceof Error ? error.message : String(error)}); falling back to ${fallback?.model ?? 'the fallback model'}.`,
      );
    },
    async (session, call, context) => {
      if (!hostedRunner) {
        throw new Error('The Stratus runtime is not ready to execute tools yet.');
      }
      return hostedRunner.executeHostedToolCall(session, call, context);
    },
    options.maxTurns,
  );

  const runner = new AgentRunner({
    provider: runtimeProvider,
    tools,
    executor: createLocalCommandExecutor(),
    approvals: createApprovalPolicy(
      options.approvals ?? 'always',
      streams,
      options.env ?? {},
      options.askApproval,
      options.approvalsDefaulted ?? false,
    ),
    bus,
    skills,
    memory,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  });

  hostedRunner = runner;
  await runner.initialize();

  // A soul is a full identity — without one, every provider serves the
  // same built-in Stratus persona.
  const agent: AgentDefinition = options.runtime.soul?.agent ?? DEFAULT_STRATUS_AGENT;

  // The same advisory the daemon gives at roster load, from the same
  // kernel check: a soul enabling a skill whose `requires:` its `tools:`
  // does not cover must warn here too, or the local test stays silent
  // about a configuration `stratus serve` flags.
  for (const { skill, missing } of missingSkillRequirements(agent, skills)) {
    writeLine(
      streams.stderr,
      `Warning: agent ${agent.id} enables skill ${skill.id}, which expects tools the agent is not allowed: ${missing.join(', ')}`,
    );
  }

  // And the same for the tools themselves, after `initialize()` so the
  // plugins have registered theirs: an allowlist entry naming a tool
  // nothing provides grants nothing and says nothing, and a soul made only
  // of those runs with no tools while its persona still talks about them.
  const finding = unmatchedToolAllowlist(
    agent,
    tools.describe().map((tool) => tool.name),
    {
      mayRegister: loadedPlugins.flatMap(
        (plugin) => plugin.manifest.contributes.toolsDiscovered.map((declared) => declared.namespace),
      ),
      // A local run has no dispatcher, store, or channels, so it registers
      // none of the daemon's tools. A soul written for `stratus serve` is
      // not wrong for naming them here — it is in the wrong process.
      elsewhere: GATEWAY_ONLY_TOOL_NAMES,
    },
  );
  for (const line of finding ? describeToolAllowlistFinding(agent.id, finding) : []) {
    writeLine(streams.stderr, `Warning: ${line}`);
  }
  // The kernel leaves this one to the host, because only the host knows
  // which process it is not.
  if (finding && finding.elsewhere.length > 0) {
    writeLine(
      streams.stderr,
      `Warning: agent ${agent.id} lists ${finding.elsewhere.join(', ')}, which only the daemon provides`
        + ' — the names are right, but stratus run cannot call them; stratus serve can',
    );
  }


  const metadata = options.runtime.provider === 'demo'
    ? { provider: 'demo' as const, executor: 'local-command' }
    : {
        provider: options.runtime.provider,
        model: options.runtime.model,
        ...(options.runtime.provider === 'openai' ? { baseUrl: options.runtime.baseUrl } : {}),
      };

  // Handed back so a command can release what a plugin acquired — a browser
  // above all. A one-shot `stratus run` that left a Chromium behind would
  // be a leak per invocation.
  const disposePlugins = async (): Promise<void> => {
    for (const plugin of loadedPlugins) {
      try {
        await plugin.instance.dispose?.();
      } catch (error) {
        writeLine(
          streams.stderr,
          `Warning: plugin ${plugin.package} failed to shut down: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  return { runner, agent, metadata, disposePlugins };
};

export const runSingleLoop = async (
  prompt: string,
  streams: CliStreams,
  options: {
    events?: boolean;
    runtime: RuntimeConfig;
    approvals?: CliApprovalMode;
    /** The mode came from `defaultApprovalMode`, not from a flag. */
    approvalsDefaulted?: boolean;
    maxTurns?: number;
    env?: CliEnvironment;
    configPath?: string;
  },
): Promise<Session> => {
  const { runner, agent, metadata, disposePlugins } = await createAgentRuntime(streams, options);
  try {
    return await runner.run({
      sessionId: randomUUID(),
      agent,
      userMessage: prompt,
      metadata,
    });
  } finally {
    // Even when the run failed: a plugin that started a browser started it
    // before the turn could fail.
    await disposePlugins();
  }
};

export const printSessionSummary = (session: Session, streams: CliStreams): void => {
  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Messages');

  for (const message of session.messages) {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const calls = message.toolCalls
        .map((call) => `${call.toolName}(${JSON.stringify(call.input)})`)
        .join(', ');
      const prefix = message.content ? `${message.content} ` : '';
      writeLine(streams.stdout, `[assistant] ${prefix}→ tool call ${calls}`);
      continue;
    }

    if (message.role === 'assistant' && message.content.length === 0) {
      // A turn nobody asked for that said nothing — see `RunInput.addressed`.
      continue;
    }
    const nameSuffix = message.name ? `:${message.name}` : '';
    const content = message.role === 'tool' ? stringifyValue(JSON.parse(message.content) as JsonValue) : message.content;
    writeLine(streams.stdout, `[${message.role}${nameSuffix}] ${content}`);
  }
};

export const formatRuntimeBanner = (runtime: RuntimeConfig): string => {
  const soulSuffix = runtime.soul ? ` as ${runtime.soul.agent.name}` : '';

  if (runtime.provider === 'demo') {
    return `Starting Stratus Agent local loop with provider=demo${soulSuffix}`;
  }

  const fallbackSuffix = runtime.fallback ? ` fallback=${runtime.fallback.model}` : '';
  return `Starting Stratus Agent local loop with provider=${runtime.provider} model=${runtime.model}${fallbackSuffix}${soulSuffix}`;
};
