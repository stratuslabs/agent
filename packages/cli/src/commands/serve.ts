import type { ApprovalPolicy } from '@stratusagent/core';
import type {
  ApprovalTransport,
  GatewayChannelAdapter,
  HomeClaim,
  RestartOutcome,
} from '@stratusagent/gateway';
import {
  createFileCommandWhitelist,
  createPermissionPolicy,
  describeCommandScope,
  describeOriginScope,
  describeToolGrant,
  type CommandScope,
  type OriginScope,
  type PermissionDecision,
  type ToolGrant,
} from '@stratusagent/permissions';
import {
  agentsDirPath,
  loadChannelCredentials,
  readProcessEnv,
  logsDirPath,
  resolveAgentApprovals,
  resolveAgentPrincipals,
  servedRuntimes,
  discoverIgnoredUntrustedConfig,
} from '@stratusagent/state';
import { createLogWriter, truncateRedirectLogs, type LogWriter } from '../logs.ts';
import { describePrincipals, describeApprovers } from '../approvals.ts';
import { HomeHeldError, legacyDaemonServing, describeHeldHome } from '../daemon.ts';
import type { CliStreams, CliEnvironment, DashboardSession } from '../environment.ts';
import { formatEvent, eventDetail } from '../events.ts';
import { writeLine } from '../io.ts';
import { loadSlackAdapter, type GatewayFactory, loadControlApi } from '../loaders.ts';
import type { ParsedServeCommand } from '../parse.ts';
import { warnOnCredentialOverride, warnOnUntrustedConfig, warnOnIgnoredConfig } from '../runtime.ts';
import {
  RESTART_EXIT_CODE,
  UNDRAINED_RESTART_EXIT_CODE,
  SUPERVISED_ENV,
  BOUND_API_PORT_ENV,
  defaultSupervisorLink,
  superviseRestarts,
} from '../supervisor.ts';
import {
  loadServeApprovals,
  loadServePrincipals,
  loadServeApi,
  loadServePlugins,
} from '../trusted-config.ts';

export const runServe = async (
  command: ParsedServeCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // First, before anything that can throw. A broken install makes the
  // gateway import below fail, the manager restarts, and the CLI's error
  // and help text append to the redirect file again — the crash loop this
  // bounding exists for. Running it after the import would skip exactly
  // that case.
  if (command.logToFile !== false) {
    await truncateRedirectLogs(logsDirPath(env)).catch(() => undefined);
  }

  // Loaded lazily: the gateway pulls in node:sqlite, which every other CLI
  // command neither needs nor should pay for (Node still prints an
  // experimental warning for it).
  const { createGateway, claimHome, HomeClaimedError } = await import('@stratusagent/gateway');

  // Before anything of this daemon's is written or opened: a second daemon
  // on this home is refused here, with no log line, no store, and no sweep
  // or firing of its own.
  let claim: HomeClaim;
  try {
    claim = claimHome(env);
  } catch (error) {
    if (error instanceof HomeClaimedError) {
      throw new HomeHeldError(await describeHeldHome(env));
    }
    throw error;
  }
  let outcome: ServeOutcome;
  try {
    // The one daemon the claim cannot see: one that predates it.
    if (await legacyDaemonServing(env)) {
      throw new HomeHeldError(await describeHeldHome(env));
    }
    outcome = await serveHeldHome(command, streams, env, createGateway);
  } finally {
    // After everything: the store closed by stop(), or whatever a throw
    // reached — a preflight that rejected before the gateway existed
    // included, so a host that calls runServe again is not refused for a
    // daemon that never started. And never sooner, so a replacement cannot
    // open the store while this one still writes.
    claim.release();
  }
  // An announced restart, once the home is let go — the replacement claims
  // it next. A daemon the supervisor started asks it for the next one by
  // exiting; the first daemon becomes the supervisor itself. Either way the
  // process the service manager (or the terminal) started is what stays.
  if (outcome.code === RESTART_EXIT_CODE && !readProcessEnv(env)[SUPERVISED_ENV]) {
    return superviseRestarts(
      command,
      { ...(outcome.boundApiPort !== undefined ? { boundApiPort: outcome.boundApiPort } : {}), sessions: outcome.sessions },
      streams,
      env,
    );
  }
  return outcome.code;
};

/** Everything `stratus serve` does once it holds the home. */
/** How a served daemon ended, and what a replacement should know. */
interface ServeOutcome {
  code: number;
  /** The control API port this daemon bound, if it served one. See BOUND_API_PORT_ENV. */
  boundApiPort?: number;
  /** The dashboard sessions live when it stopped, for the replacement. See RestartHandoff. */
  sessions: DashboardSession[];
}

const serveHeldHome = async (
  command: ParsedServeCommand,
  streams: CliStreams,
  env: CliEnvironment,
  createGateway: GatewayFactory,
): Promise<ServeOutcome> => {
  // Under a service manager the daemon's stdout is gone, so everything it
  // says is also written to ~/.stratus/logs — that file is what `stratus
  // logs` reads, and the only record of an overnight run.
  const logWriter: LogWriter | undefined = command.logToFile === false
    ? undefined
    : createLogWriter({
        dir: logsDirPath(env),
        onError: (error) => writeLine(
          streams.stderr,
          `Warning: could not write the log file (${error instanceof Error ? error.message : String(error)}); continuing.`,
        ),
      });
  const log = (line: string): void => {
    writeLine(streams.stdout, line);
    void logWriter?.write({ ts: new Date().toISOString(), level: 'info', msg: line });
  };
  const warn = (line: string): void => {
    writeLine(streams.stderr, `Warning: ${line}`);
    void logWriter?.write({ ts: new Date().toISOString(), level: 'warn', msg: line });
  };

  // Agents with stored Slack tokens go live in Slack automatically — the
  // tokens are gateway infrastructure secrets in the channels namespace of
  // ~/.stratus/credentials.json (see @stratusagent/channel-slack's README
  // for the 2-minute per-agent app setup).
  // The approval policy and the Slack approver sets come from the same
  // config block, resolved once here: the daemon must not answer "who can
  // approve this" differently from "is anyone being asked at all".
  const approvalsConfig = await loadServeApprovals(env, command.configPath, warn);
  const approvalMode = command.approvals ?? approvalsConfig.mode ?? 'headless';
  const principalsConfig = await loadServePrincipals(env, command.configPath, warn);

  // Read here rather than inside the gateway for the same reason as the two
  // blocks above: the trust boundary is a property of *which file* said it,
  // and this is where the file precedence is already understood.
  const pluginsConfig = await loadServePlugins(env, command.configPath, warn);

  // Every kind of grant an agent holds — command scopes, origins, standing
  // tool grants — in one file per agent beside its soul, through one store
  // instance for the whole daemon. One instance, because the store caches
  // each file for the life of the process: the control API's list and
  // revoke go through this same object, which is what lets a revoke take
  // effect on the policy's very next decision rather than at the next
  // restart. A whitelist that exists and will not read is said here, once,
  // and never written over — the daemon's log is where a grant list going
  // quiet would otherwise go unnoticed.
  const grantStore = createFileCommandWhitelist({ directory: agentsDirPath(env), warn });

  // The control API is a channel adapter like any other: started after the
  // roster loads, stopped before the store drains. It is optional because
  // installing it is how an operator says they want a port open.
  const apiConfig = await loadServeApi(env, command.configPath, warn);
  const apiWanted = command.api ?? apiConfig.enabled ?? true;
  // Typed as the seam, not as whatever the first push happens to be: the
  // list holds the control API and the Slack adapter alike.
  const controlApiChannels: GatewayChannelAdapter[] = [];
  /** The API adapter itself, for what the seam does not carry: its address, and the sessions it hands across a restart. */
  let boundApi: {
    readonly url: string | undefined;
    adoptSessions(sessions: DashboardSession[]): void;
    sessionsAtStop(): DashboardSession[];
  } | undefined;
  if (apiWanted) {
    const createControlApi = await loadControlApi();
    // Resolved into locals first. Inlined, `a ?? b !== undefined` parses as
    // `a ?? (b !== undefined)` — so an explicit `--api-port 0`, which is how
    // you ask for any free port, was falsy and fell through to the default.
    // Everything still bound and every test still passed, on whichever port
    // nobody happened to be using.
    const apiHost = command.apiHost ?? apiConfig.host;
    const requestedPort = command.apiPort ?? apiConfig.port;
    // The port the last daemon bound, from the supervisor that started
    // this one — taken only where this daemon's own request is still for
    // any free port. See BOUND_API_PORT_ENV.
    const hinted = Number(readProcessEnv(env)[BOUND_API_PORT_ENV]);
    const apiPort = requestedPort === 0 && Number.isInteger(hinted) && hinted > 0 ? hinted : requestedPort;
    if (createControlApi) {
      const api = createControlApi({
        env,
        ...(apiHost !== undefined ? { host: apiHost } : {}),
        ...(apiPort !== undefined ? { port: apiPort } : {}),
        ...(command.configPath ? { configPath: command.configPath } : {}),
        grants: grantStore,
        log,
        warn,
      });
      boundApi = api;
      controlApiChannels.push(api);
    } else if (command.api === true || apiConfig.enabled === true) {
      // Only when someone asked for it explicitly. A daemon that was never
      // told to serve an API should not complain about not having one.
      warn(
        'the control API was requested, but @stratusagent/control-api is not installed. '
        + 'Run `npm install -g @stratusagent/control-api` to bring it online; starting without it.',
      );
    }
  }

  // Listening before anything else is awaited: what the supervisor hands
  // this daemon is queued in the channel until then, and the API keeps it
  // until it is serving.
  const supervised = Boolean(readProcessEnv(env)[SUPERVISED_ENV]);
  const link = env.supervisorLink ?? defaultSupervisorLink;
  if (supervised) {
    link.receive((message) => {
      if (message.type === 'stratusd.sessions') {
        boundApi?.adoptSessions(message.sessions);
      }
    });
  }

  const channelCredentials = await loadChannelCredentials(env);
  const slackAgents = Object.entries(channelCredentials.slack ?? {});
  const channels = [...controlApiChannels];
  // Tracked on its own, never as `channels.length`: the list now holds the
  // control API too, and "can anyone be asked for an approval" is a question
  // about the Slack adapter specifically. Reading it off the list length
  // would tell a daemon with an API and no Slack app that every agent is
  // reachable, and its gated calls would park with nobody rendering them.
  let slackAdapterUp = false;
  if (slackAgents.length > 0) {
    // Channel packages are optional peers: the CLI never bundles a
    // transport nobody asked for (the Slack SDKs alone are ~9 MB). A
    // missing one degrades like a broken app does — the daemon serves
    // every other channel — with an actionable line instead of a
    // module-not-found stack.
    const adapter = await loadSlackAdapter();
    if (adapter) {
      slackAdapterUp = true;
      channels.push(adapter({
        agents: slackAgents.map(([agentId, tokens]) => {
          const route = resolveAgentApprovals(approvalsConfig, agentId);
          const principals = resolveAgentPrincipals(principalsConfig, agentId);
          return {
            agentId,
            appToken: tokens.appToken,
            botToken: tokens.botToken,
            ...(route.slackApprovers ? { approvers: route.slackApprovers } : {}),
            ...(route.slackChannel ? { approvalChannel: route.slackChannel } : {}),
            ...(principals.slackUsers ? { principals: principals.slackUsers } : {}),
          };
        }),
        log,
        warn,
      }));
    } else {
      warn(
        `Slack tokens are stored for ${slackAgents.length} agent(s), but @stratusagent/channel-slack is not installed. `
        + 'Run `npm install -g @stratusagent/channel-slack` to bring them online; starting without the Slack channel.',
      );
    }
  }

  // A daemon is the costliest place for a silently demoted subscription:
  // every dispatch for as long as it runs, with nobody watching. The
  // gateway resolves each agent's soul independently on dispatch, so an
  // agent pinning anthropic can pick up an environment key even when the
  // daemon's own default is openai — checking only the default selection
  // would miss exactly the agent that is being billed. Each distinct
  // selection is resolved once here, and duplicate warnings are collapsed
  // so a ten-agent roster does not print ten identical lines.
  {
    const warned = new Set<string>();
    const collect = (line: string): void => {
      if (warned.has(line)) {
        return;
      }
      warned.add(line);
      // Through `warn`, not straight to stderr: under a service manager
      // stderr is gone, and a cost warning that only exists there is
      // invisible in exactly the deployment it matters for. `warn` adds
      // its own prefix, so the one already on the line comes off.
      warn(line.replace(/^Warning: /, ''));
    };
    const captured: CliStreams = {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { collect(chunk.replace(/\n$/, '')); return true; } },
    };
    // The same notice `run` and `chat` give, from config discovery rather
    // than from a resolved runtime: servedRuntimes drops a pass that fails
    // to resolve — a real provider with no usable credential — and that
    // daemon still starts, with nothing saying why the clone's persona is
    // not in force. The per-runtime record below repeats it for a pass
    // that did resolve; the dedupe above collapses the two to one line.
    warnOnIgnoredConfig(await discoverIgnoredUntrustedConfig(command.configPath ? { configPath: command.configPath } : {}, env), captured);
    // A pinned soul does not merely add a provider — the gateway DEMOTES
    // the daemon-wide defaults it outranks, including STRATUS_PROVIDER, so
    // each served runtime is resolved the way a dispatch resolves it.
    for (const served of await servedRuntimes(env, command.configPath)) {
      warnOnUntrustedConfig(served.runtime, captured);
      await warnOnCredentialOverride(served.runtime, captured, served.env);
    }
  }

  // The daemon had no policy at all: createGateway falls back to
  // AllowAllApprovalPolicy, so every tool call from every agent
  // auto-approved, indefinitely, with nobody watching. That was survivable
  // while `serve` was something you ran in a terminal you were sitting at;
  // it is not, now that setup installs it under launchd by default.
  //
  // There is no terminal behind a service manager, so the choice is
  // between refusing every gated call (`headless`) and parking the turn to
  // ask through a channel (`remote`). Headless stays the default: a daemon
  // that starts waiting on people who were never told they are on the hook
  // hangs turns instead of refusing them. Every refusal is logged — an
  // unattended denial that appears nowhere reads like an agent that decided
  // not to bother.
  const onDecision = (decision: PermissionDecision): void => {
    if (decision.allowed) {
      // A call that ran because somebody once said "always" is the one
      // allowed decision the trace records: it is how something happened
      // unattended, which is what an incident reconstruction needs to tell
      // apart from a tool that was simply safe. Name and date, never input.
      if (decision.grant) {
        const by = decision.grant.grantedBy ? ` by ${decision.grant.grantedBy}` : '';
        log(`${decision.agentId}: ${decision.toolName} ran under a standing grant (${describeToolGrant(decision.grant)}, granted ${decision.grant.grantedAt}${by}) (session ${decision.sessionId})`);
      }
      return;
    }
    warn(`${decision.agentId}: ${decision.reason} (session ${decision.sessionId})`);
  };
  // A factory, not a policy: remote mode parks turns on a transport the
  // gateway owns, so the policy cannot exist until the gateway is building
  // it. Headless takes the same path so there is one construction site.
  // The command-scope engine, which only has a caller once a shell pack is
  // installed. Wired unconditionally because it costs nothing without one:
  // a tool that carries no command string is judged by its risk exactly as
  // before. The whitelist lives beside the agent's soul, per agent.
  const commands = {
    whitelist: grantStore,
    onScopeRemembered: ({ agentId, scope }: { agentId: string; scope: CommandScope }) => {
      // An approval that widens what runs unattended, for every future
      // session, is precisely the decision that must not be the one leaving
      // no trace.
      log(`${agentId}: "${describeCommandScope(scope)}" now runs without asking`);
    },
  };
  // The origin-scope engine, whose grants live in the same file as the
  // command scopes: one place an operator looks to see what an agent may
  // do unattended. Wired unconditionally for the same reason — a tool that
  // names no origin is judged by its risk exactly as before.
  const origins = {
    whitelist: grantStore,
    onScopeRemembered: ({ agentId, scope }: { agentId: string; scope: OriginScope }) => {
      log(`${agentId}: ${describeOriginScope(scope)} is now acted on without asking`);
    },
  };
  const approvals = (transport: ApprovalTransport): ApprovalPolicy => {
    // The standing-grant engine, in the same file again — and the tool's
    // contributor from the gateway, so a grant records which package's
    // tool the operator said yes to and stops applying when that changes.
    const grants = {
      store: grantStore,
      contributorOf: transport.contributorOf,
      onGranted: ({ agentId, grant }: { agentId: string; grant: ToolGrant }) => {
        log(`${agentId}: ${describeToolGrant(grant)} now runs without asking, until revoked${grant.grantedBy ? ` (granted by ${grant.grantedBy})` : ''}`);
      },
    };
    return createPermissionPolicy(
      // The destination scope rides along in BOTH modes — it is what lets a
      // scheduled turn report to the channel a human approved with the
      // schedule, and headless (where every other gated call is refused) is
      // exactly the deployment it exists for. So do the grants: a standing
      // grant is the only path a scope-less gated tool has to running
      // unattended, and headless is where that matters.
      approvalMode === 'remote'
        ? { mode: 'remote', request: transport.request, onDecision, commands, origins, grants, destinations: transport.destinations }
        : { mode: 'headless', onDecision, commands, origins, grants, destinations: transport.destinations },
    );
  };

  if (approvalMode === 'remote') {
    // Only agents whose channel actually came up can be asked: tokens on
    // disk with the Slack package missing means nothing renders the
    // request, and the turn discovers that by hanging.
    const askable = slackAdapterUp ? slackAgents.map(([agentId]) => agentId) : [];
    log(`approvals: remote — gated calls are parked and asked in Slack (${describeApprovers(approvalsConfig, askable)})`);
  }
  if (slackAdapterUp) {
    // Said at startup, because the failure it names is silent otherwise: a
    // daemon with no principals serves every Slack message as `unknown`,
    // and the operator finds out when their agent's memory reads that way.
    log(`provenance: ${describePrincipals(principalsConfig, slackAgents.map(([agentId]) => agentId))}`);
  }

  /**
   * The one signal handler this daemon has, for the whole of its life —
   * installed by the wait below, removed in the finally after the drain.
   * See the wait for why it is never `once` and never removed sooner.
   */
  let stopSignal: (() => void) | undefined;
  let repeatWarned = false;

  // The gateway's restart hands the process back here once it has stopped:
  // the outcome is kept and the wait below released, and the tail of this
  // function decides what "come back" means for this process.
  let restart: RestartOutcome | undefined;
  /** A signal or the host's abort asked for a stop — set when the wait ends for that reason. */
  let stopRequested = false;
  let requestShutdown: () => void = () => {};
  const shutdownRequested = new Promise<void>((resolve) => {
    requestShutdown = resolve;
  });

  const gateway = createGateway({
    env,
    approvals,
    onRestart: (outcome) => {
      restart = outcome;
      requestShutdown();
    },
    ...(Object.keys(pluginsConfig).length > 0
      ? {
          plugins: pluginsConfig,
          // Resolved from *here*, not from inside the gateway.
          // `import.meta.resolve` answers relative to the module that calls
          // it, and a plugin is installed alongside the thing the operator
          // installed — this CLI. Letting the gateway resolve from its own
          // location works only where the layout happens to be flat.
          pluginHost: {
            resolve: (specifier: string) => import.meta.resolve(specifier),
            import: (specifier: string) => import(specifier),
          },
        }
      : {}),
    ...(approvalsConfig.timeoutMs !== undefined ? { approvalTimeoutMs: approvalsConfig.timeoutMs } : {}),
    ...(command.configPath ? { selection: { configPath: command.configPath } } : {}),
    ...(command.idleTimeoutMs !== undefined ? { idleTimeoutMs: command.idleTimeoutMs } : {}),
    ...(channels.length > 0 ? { channels } : {}),
    log,
    warn,
  });

  if (command.events) {
    gateway.bus.subscribe((event) => {
      const line = formatEvent(event);
      if (line) {
        writeLine(streams.stdout, line);
      }
    });
  }

  if (logWriter) {
    // Only session.created carries the agent id, so it seeds a map the
    // later events in that session read from. A session resumed after a
    // restart never re-creates, so an unmapped id falls back to the
    // durable store — which is exactly the case where attribution matters.
    const agentBySession = new Map<string, string>();
    // EventBus.emit awaits its subscribers, and a streaming provider awaits
    // the delta sink — so anything awaited here lands on the critical path
    // of every streamed token. This handler is deliberately synchronous:
    // provider.delta is dropped outright (it carries no detail worth
    // keeping, one record per token), the timestamp is taken now, and the
    // write is queued without awaiting it.
    gateway.bus.subscribe((event) => {
      if (event.type === 'provider.delta') {
        return;
      }
      const ts = new Date().toISOString();
      if (event.type === 'session.created') {
        agentBySession.set(event.sessionId, event.agentId);
      }
      const detail = eventDetail(event);
      const base = {
        ts,
        level: 'event' as const,
        event: event.type,
        sessionId: event.sessionId,
        ...(detail ? { detail } : {}),
      };
      const known = agentBySession.get(event.sessionId);
      if (known) {
        void logWriter.write({ ...base, agentId: known });
      } else {
        // A session resumed after a restart never re-creates, so its agent
        // is only in the store. That lookup is deferred off this path; the
        // timestamp above keeps ordering honest.
        void gateway.store.get(event.sessionId)
          .then((session) => {
            const agentId = session?.agent.id;
            if (agentId) {
              agentBySession.set(event.sessionId, agentId);
            }
            return logWriter.write({ ...base, ...(agentId ? { agentId } : {}) });
          })
          .catch(() => logWriter.write(base));
      }
      if (event.type === 'session.completed' || event.type === 'session.failed') {
        agentBySession.delete(event.sessionId);
      }
    });
  }

  await gateway.start();

  // Read now, while the API is bound: its stop forgets the address, and
  // a restart's respawn needs it (see ServeOutcome).
  const boundApiPort = boundApi?.url !== undefined ? Number(new URL(boundApi.url).port) : undefined;
  if (supervised && boundApiPort !== undefined && Number.isInteger(boundApiPort) && boundApiPort > 0) {
    link.send({ type: 'stratusd.bound-api-port', port: boundApiPort });
  }

  // Under one finally from here: a throw anywhere after the start — a
  // host's writable refusing a line, say — must still stop the gateway
  // before the claim on the home is released, or a live gateway would be
  // left behind a lock the next daemon can take.
  let redirectTimer: NodeJS.Timeout | undefined;
  try {
    // The roster is only known once the gateway has loaded it, and in remote
    // mode an agent no channel can ask for is the quietest failure this
    // feature has: its gated calls park with nobody rendering them and wait
    // out the whole timeout before being denied. No channel can detect this
    // on its own — a request is a broadcast, and no adapter knows whether
    // another one is about to answer — so it is reported here, where the
    // roster and the channel list are both in view.
    if (approvalMode === 'remote') {
      const askable = new Set(slackAdapterUp ? slackAgents.map(([agentId]) => agentId) : []);
      const unreachable = gateway.agents().map((agent) => agent.id).filter((id) => !askable.has(id));
      if (unreachable.length > 0) {
        warn(
          `no channel can ask for ${unreachable.join(', ')}, so their gated calls will wait out the `
          + 'approval timeout and then be denied. Connect a Slack app for them, or run with --approvals headless.',
        );
      }
    }

    writeLine(streams.stdout, 'Press Ctrl+C to stop.');

    // And periodically, for a long-running daemon that warns steadily
    // without ever writing enough records to rotate. Unref'd, so it never
    // holds the process open. Armed only once the daemon is actually
    // serving: every step above can throw, and runServe is an exported
    // function as much as a process entry point — in a host that survives
    // the failure, a timer armed before the throw would outlive the call
    // and go on truncating that environment's redirect logs. The finally
    // below takes it down on every other exit path.
    if (logWriter) {
      redirectTimer = setInterval(() => void truncateRedirectLogs(logsDirPath(env)), 5 * 60_000);
      redirectTimer.unref?.();
    }

    // Hold the event loop open until a shutdown request, then drain: new
    // dispatches are refused while in-flight turns finish.
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => {}, 2_147_000_000);
      let settled = false;
      const shutdown = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(keepAlive);
        resolve();
      };
      stopSignal = (): void => {
        if (!settled) {
          shutdown();
          return;
        }
        // A signal while a drain is already running — a repeat, or a stop
        // arriving during a restart's drain. Either way the drain goes on,
        // and a daemon told to stop does not come back.
        stopRequested = true;
        if (!repeatWarned) {
          repeatWarned = true;
          // Said from signal dispatch, outside the promise and its finally:
          // a stream that throws on write (a host's injected stderr) would
          // otherwise end the process from here — mid-drain, the very
          // thing this handler exists to prevent. The word is best effort.
          try {
            warn('stop signal received while draining; still draining, and this daemon will not come back (SIGKILL ends it at once)');
          } catch {
            // Nothing to say it to; the drain is what matters.
          }
        }
      };
      // `on`, never `once`, and not removed until the drain is over (the
      // finally below). `once` drops the listener before running it, Node
      // uninstalls its native handler the moment no listener is left, and
      // a second SIGTERM landing in that window ends the process by the
      // default action — mid-drain, with nothing said. The second signal
      // is the normal case, not an edge: a stop delivered to the process
      // group, as systemd's KillMode=control-group and a terminal's Ctrl+C
      // deliver it, reaches a supervised daemon once from the kernel and
      // once more forwarded by its supervisor. Reproduced two runs in
      // three: the replacement died and the supervisor exited 1 on a
      // `stratus service stop` after a restart. SIGKILL still ends the
      // process at once.
      process.on('SIGTERM', stopSignal);
      process.on('SIGINT', stopSignal);
      void shutdownRequested.then(shutdown);
      if (env.shutdownSignal?.aborted) {
        shutdown();
      } else {
        env.shutdownSignal?.addEventListener('abort', shutdown, { once: true });
      }
    });

    // Decided now, before the stop below: a restart's drain can still be
    // running when a stop signal releases this wait, and `onRestart` then
    // fires during that stop. A daemon told to stop does not come back,
    // whatever it was told before.
    if (!restart) {
      stopRequested = true;
    }
    if (restart) {
      // Already stopped: the gateway drained and closed before handing the
      // process over, and the stop() below finds nothing to do. Said here,
      // while the structured log still takes writes — the next lines
      // belong to a process that has none.
      if (!restart.drained) {
        // A turn that ignored its abort is still running in this process,
        // possibly still writing sessions. Starting a fresh daemon beside
        // it would be two processes on one store; exiting instead leaves
        // the service manager, where there is one, to bring it back.
        warn(`restart: something did not let go; exiting with status ${UNDRAINED_RESTART_EXIT_CODE} for the service manager to restart, instead of starting a new daemon beside it`);
      } else {
        log(`restarting stratusd${restart.reason ? ` (${restart.reason})` : ''}`);
      }
    } else {
      writeLine(streams.stdout, 'Stopping — draining in-flight turns.');
    }
  } finally {
    try {
      await gateway.stop();
      // Writes are queued and dropped on the hot path so logging never sits
      // on a streamed token. That makes the tail of the log the part most
      // likely to be lost — and the tail is the shutdown reason, the last
      // warning, the line explaining a restart.
      await logWriter?.flush();
    } finally {
      // The shutdown is over, the flush included: a stop signal from here
      // on is the process's to handle by default again — and a host that
      // calls runServe repeatedly (the tests) must not accumulate handlers.
      // Last, and under its own finally, because the listener is on the
      // global process: taken off before the flush, a repeated signal
      // landing during it would end the process by the default action
      // (which a supervisor reports as a failure, and a service manager
      // set to restart on failure would then bring back a daemon an
      // operator just stopped); left on by a stop() that rejects (its last
      // log line can throw through an injected stream), a settled handler
      // would swallow the host's next signal.
      if (stopSignal) {
        process.off('SIGTERM', stopSignal);
        process.off('SIGINT', stopSignal);
      }
      if (redirectTimer) {
        clearInterval(redirectTimer);
      }
    }
  }

  const bound = boundApiPort !== undefined && Number.isInteger(boundApiPort) && boundApiPort > 0
    ? { boundApiPort }
    : {};
  if (!restart || stopRequested) {
    return { code: 0, ...bound, sessions: [] };
  }
  if (!restart.drained) {
    (env.exitProcess ?? process.exit)(UNDRAINED_RESTART_EXIT_CODE);
    return { code: UNDRAINED_RESTART_EXIT_CODE, ...bound, sessions: [] };
  }
  // Coming back: the browser sessions live at the stop go to the
  // replacement — up the channel to the supervisor when this daemon has
  // one, else with the outcome to the supervisor this process becomes.
  const sessions = boundApi?.sessionsAtStop() ?? [];
  if (supervised && sessions.length > 0) {
    link.send({ type: 'stratusd.sessions', sessions });
  }
  // Asked to come back. Whether this process starts the next daemon or
  // exits for its supervisor to is `runServe`'s decision, after the home
  // is released: the claim is held until this returns, and a daemon
  // started before that would be refused as a second one on the home.
  return { code: RESTART_EXIT_CODE, ...bound, sessions };
};
