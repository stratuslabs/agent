import type { AvatarTheme } from '@stratusagent/core';
import { listAgentSummaries, migrateLegacyMemory, type AgentSummary } from '@stratusagent/state';
import { gatewayToken } from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedAgentsCommand } from '../parse.ts';

/** Ask a running gateway for its roster, as data. */
const remoteAgentSummaries = async (
  command: ParsedAgentsCommand,
  env: CliEnvironment,
): Promise<AgentSummary[]> => {
  const token = await gatewayToken(env, command.token);
  const base = String(command.gateway).replace(/\/+$/, '');
  const fetchImpl = env.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable, so --gateway cannot reach a daemon from this runtime.');
  }

  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new Error(
      `Could not reach the gateway at ${base} (${error instanceof Error ? error.message : String(error)}). `
      + 'Is stratusd running, and does it have @stratusagent/control-api installed?',
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`The gateway at ${base} rejected this token. Check --token, STRATUS_GATEWAY_TOKEN, or ~/.stratus/gateway-token.`);
  }
  if (!response.ok) {
    throw new Error(`The gateway at ${base} answered HTTP ${response.status} for the roster.`);
  }
  const payload = await response.json() as { agents?: AgentSummary[] };
  return payload.agents ?? [];
};

export const runAgents = async (
  command: ParsedAgentsCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // The same listing either way — the shared builder produces it locally, and
  // the control API serves exactly what that builder produced. Rendering is
  // the only thing this command does with it.
  let listings: AgentSummary[];
  if (command.gateway) {
    listings = await remoteAgentSummaries(command, env);
  } else {
    // Fold any legacy per-directory memory in first so the counts below
    // reflect everything each agent actually remembers.
    await migrateLegacyMemory(env);
    listings = await listAgentSummaries(env, (message) => {
      writeLine(streams.stderr, `Warning: ${message}.`);
    });
  }

  // The palette travels structurally now, because a web or macOS surface has
  // to draw it. This output has always been one prose line, and a shape
  // change here would break every script reading it — so the rendering, not
  // the data, stays where it was.
  const describeAvatar = (avatar: AvatarTheme): string =>
    `${avatar.style} theme, hue ${avatar.hue}, palette ${avatar.palette.join(' ')}`;

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({
      agents: listings.map(({ default: isDefault, avatar, ...rest }) => ({
        ...rest,
        ...(avatar ? { avatar: describeAvatar(avatar) } : {}),
        default: isDefault,
      })),
    }, null, 2));
    return 0;
  }

  const describeRunsOn = (runsOn: { provider: string; model?: string }): string =>
    (runsOn.provider === 'demo' ? 'demo (offline)' : `${runsOn.provider}${runsOn.model ? ` · ${runsOn.model}` : ''}`);

  writeLine(streams.stdout, command.gateway ? `Agents on ${command.gateway}` : 'Agents');
  for (const agent of listings) {
    const labels = [
      ...(agent.default ? ['default'] : []),
      ...(agent.builtIn ? ['built-in'] : []),
    ];
    writeLine(streams.stdout);
    writeLine(streams.stdout, `  ${agent.name}${labels.length > 0 ? `  (${labels.join(', ')})` : ''}`);
    writeLine(streams.stdout, `    id        ${agent.id}`);
    if (agent.soulPath) {
      writeLine(streams.stdout, `    soul      ${agent.soulPath}`);
    }
    writeLine(streams.stdout, `    runs on   ${agent.provider ? describeRunsOn(agent.runsOn) : `follows your setup — currently ${describeRunsOn(agent.runsOn)}`}`);
    writeLine(streams.stdout, `    memory    ${agent.memories === 0 ? 'nothing yet' : `${agent.memories} remembered fact${agent.memories === 1 ? '' : 's'}`}`);
    if (agent.persona) {
      writeLine(streams.stdout, `    persona   ${agent.persona}`);
    }
    if (agent.avatar) {
      writeLine(streams.stdout, `    avatar    ${describeAvatar(agent.avatar)}`);
    }
  }
  writeLine(streams.stdout);
  writeLine(streams.stdout, listings.length === 1
    ? 'That is just the built-in default — create your own with: stratus agent new'
    : 'Talk to the default with stratus run, or to anyone with stratus run --soul <file>.');
  return 0;
};
