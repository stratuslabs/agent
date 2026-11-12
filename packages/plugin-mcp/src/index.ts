import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { resolve } from 'node:path';

import {
  leastTrusted,
  sessionTrustOf,
  type ExecutionContext,
  type JsonObject,
  type JsonValue,
  type Plugin,
  type Session,
  type Tool,
  type ToolRegistry,
} from '@stratusagent/core';
import { createFileLedger, workspacePreparer, workspaceResolver, type TaintedWriteLedger } from '@stratusagent/plugins';

import {
  isObject,
  McpConfigError,
  type McpServerSpec,
  pathGrant,
  resolveServerSpec,
} from './config.ts';
import {
  bridgedToolName,
  sanitizeToolSegment,
  bridgedDescription,
  bridgedSchema,
  BRIDGED_SCHEMA_MAX_LENGTH,
  BRIDGED_SCHEMA_MAX_DEPTH,
  BRIDGED_SEGMENT_MAX_LENGTH,
} from './descriptors.ts';
import { boundServerText, normalizeCallResult } from './normalize.ts';
import {
  boundedSink,
  buildTransport,
  describeEndpoint,
  describeError,
  describeTransportError,
  isConnectionFailure,
  resolveCommandPath,
  sealedStdioEnv,
  stdioOverflowBytes,
} from './transport.ts';

/**
 * What this client tells an MCP server it is. Moves with the package
 * manifests on a release, like CLI_VERSION and CONTROL_API_VERSION — a
 * server that logs or keys compatibility on clientInfo.version otherwise
 * goes on seeing the release this literal was last touched at.
 *
 * Exported for the same reason theirs are: so a test can pin it to
 * package.json, because nothing else fails when a release bumps the
 * manifest and leaves the literal behind.
 */
export const PLUGIN_MCP_VERSION = '0.14.14';

export {
  BRIDGED_DESCRIPTION_MAX_LENGTH,
  BRIDGED_SCHEMA_MAX_LENGTH,
  BRIDGED_SCHEMA_MAX_DEPTH,
  BRIDGED_SEGMENT_MAX_LENGTH,
  bridgedDescription,
  bridgedSchema,
  bridgedToolName,
  sanitizeToolSegment,
  SERVER_NAME_PATTERN,
} from './descriptors.ts';
export { boundServerText, normalizeCallResult } from './normalize.ts';
export { BRIDGED_RESULT_MAX_LENGTH, BRIDGED_RESULT_MIN_LENGTH, boundedResultLimit } from './result-budget.ts';
export type { McpServerSpec } from './config.ts';
export { sealedStdioEnv, pathGrant, resolveCommandPath };

/**
 * The MCP bridge: mounts Model Context Protocol servers as Stratus tools.
 *
 * Each configured server's tools register as `mcp.<server>.<tool>`, so a
 * soul allowlists `mcp.linear.*` and an operator can see at a glance which
 * tools are somebody else's code. Risk is ours, not the server's: the
 * manifest declares the `mcp.*` namespace `gated`, the registration view
 * enforces it, and an operator who has read a server lowers a specific
 * tool through the host's `toolRisks` key — never through anything this
 * package could do on its own.
 *
 * Lifecycle: connect at startup, reconnect with backoff, and a server that
 * is down degrades to its tools being unavailable rather than failing the
 * daemon's start. Tool descriptors are built once per connect; a server
 * that changes its list mid-run is picked up on reconnect, and the change
 * is logged because an agent's allowlist may no longer mean what it meant.
 */

const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
/**
 * How many pages of `tools/list` discovery will follow. The per-request
 * timeout bounds each page, not the walk — a server that always answers
 * with a nextCursor would otherwise hold `setup()`, and with it the
 * daemon's start, forever. Which is exactly the kind of say-so this
 * package's trust model exists to not extend to a remote server.
 */
const MAX_TOOL_LIST_PAGES = 100;

export interface McpPluginOptions {
  /** The environment `passEnv` grants *from*. Defaults to the daemon's. */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Transport seam for tests: hand back a connected pair instead of
   * spawning or dialing. The default builds stdio or Streamable HTTP from
   * the spec.
   */
  transportFor?: (spec: McpServerSpec) => Transport | Promise<Transport>;
  /**
   * Reconnect pacing, attempt (0-based) to delay. The default doubles from
   * one second and caps at one minute; tests shrink it so a reconnect is
   * an event to await rather than a wall-clock to sleep through.
   */
  reconnectDelayMs?: (attempt: number) => number;
  /**
   * Called after a server (re)connects and its tools are registered — the
   * gate a test holds instead of guessing at timers, and a hook a host
   * could count connections with.
   */
  onConnected?: (server: string) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /**
   * Clock seam for the discovery deadline: the budget arithmetic only shows
   * itself when time passes mid-walk, which a real clock makes a race.
   */
  now?: () => number;
}

/** The slice of a `tools/list` entry the bridge reads. */
interface AdvertisedTool {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
}

/** What the bridge knows about one discovered tool, snapshotted at connect. */
interface DiscoveredTool {
  /** The name the server knows it by — what `tools/call` is sent. */
  mcpName: string;
  description?: string;
  parameters?: JsonObject;
}

interface ServerState {
  spec: McpServerSpec;
  client: Client | undefined;
  /**
   * The transport of a connect still in flight, from the moment it exists
   * until the connect settles. `dispose()` closes it directly: without
   * this, a dispose racing a handshake could only wait for the connect's
   * own `disposed` re-checks to run — for a stdio server, a spawned child
   * holding granted env would live on until the connect timeout expired.
   */
  pending: Transport | undefined;
  connected: boolean;
  connecting: boolean;
  /**
   * Why the live connection is closing, when the transport said so before
   * it did — kept so the call that then fails with a bare "Connection
   * closed" can say why. Exactly one error qualifies: the SDK's stdio
   * reader refusing a single message over its buffer limit, which it
   * follows with a close of its own. Every other transport error is logged
   * and forgotten here, because the SDK keeps the connection through them
   * — a stray line, a schema miss, a stdin EPIPE — and a server that dies
   * during a later call must not be blamed on one. Being tied to a close
   * the SDK has already started, nothing clears it but the next connect.
   */
  closeCause: string | undefined;
  attempt: number;
  timer: NodeJS.Timeout | undefined;
  /** Registered name → what it bridges to. The live descriptor cache. */
  tools: Map<string, DiscoveredTool>;
}

export const createMcpPlugin = (config: JsonObject = {}, options: McpPluginOptions = {}): Plugin => {
  // Reassigned at setup when the host offers its own log and the caller
  // did not: the daemon's structured log is where these lines belong, and
  // stderr is the fallback for a host that has nothing better. Every line
  // is bounded on its way out, whatever composed it — a server names its
  // own tools, at any length it likes, and the daemon log rotates at 8 MB.
  let log = boundedSink(options.log ?? ((message: string) => console.error(`[plugin-mcp] ${message}`)));
  let warn = boundedSink(options.warn ?? ((message: string) => console.error(`[plugin-mcp] ${message}`)));
  const processEnv = options.processEnv ?? process.env;
  const delayFor = options.reconnectDelayMs
    ?? ((attempt: number) => Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS));
  const workspaceRoot = typeof config.workspaceRoot === 'string' ? config.workspaceRoot : undefined;
  // The same ledger `tool-fs` reads, so a server's image or audio block
  // written here reads back labelled there — and a *different* location
  // from the artifacts it records. An operator may point this plugin's
  // output at a volume of their own (`workspaceRoot`); the ledger follows
  // the host's `workspaces` seam regardless, because `tool-fs` writes the
  // same one and `fs.read` consults exactly one — a file recorded in a
  // second ledger reads back unlabelled. `ledgerRoot` and `workspaceRoot`
  // are the fallback for a host that wires this plugin by hand and has no
  // layout to offer.
  //
  // Both resolvers are built in `setup`, because the seam arrives with the
  // context; this holds only what config said.
  const handWiredLedgerRoot = typeof config.ledgerRoot === 'string' ? config.ledgerRoot : workspaceRoot;
  let workspaceFor: ((agentId: string) => string) | undefined;
  let ledger: TaintedWriteLedger | undefined;

  if (!isObject(config.servers)) {
    throw new McpConfigError(
      'plugins["@stratusagent/plugin-mcp"] needs a "servers" object — one entry per MCP server, keyed by the name its tools mount under.',
    );
  }
  const states: ServerState[] = Object.entries(config.servers).map(([name, block]) => ({
    spec: resolveServerSpec(name, block, processEnv),
    client: undefined,
    pending: undefined,
    connected: false,
    connecting: false,
    closeCause: undefined,
    attempt: 0,
    timer: undefined,
    tools: new Map(),
  }));

  let view: ToolRegistry | undefined;
  let disposed = false;

  const proxyTool = (state: ServerState, registeredName: string, info: DiscoveredTool): Tool => ({
    name: registeredName,
    // The fallback is built from the server's tool name, which the SDK
    // accepts as any string — bounded the same way, or a nameless tool's
    // name is the description a server writes.
    description: info.description ?? bridgedDescription(`Tool ${info.mcpName} on the MCP server ${state.spec.name}.`),
    ...(info.parameters ? { parameters: info.parameters } : {}),
    // No risk claim, deliberately: what a bridged tool registers at is the
    // namespace's declared risk (and any operator override), applied by
    // the manifest-bound view — the server's opinion of itself never
    // enters, and neither does this package's.
    //
    // Provenance is a different question, and the operator's to answer, not
    // the server's: whatever comes back is the server's text, so it is
    // `external` unless the operator vouched for this server in trusted
    // config (see `resolveOutputTrust`). No per-call judgement of the
    // response shape could make it otherwise.
    outputTrust: state.spec.outputTrust,
    async execute(input: JsonObject, session: Session, context?: ExecutionContext): Promise<JsonValue> {
      const client = state.connected ? state.client : undefined;
      if (!client) {
        throw new Error(
          `MCP server ${state.spec.name} is not connected; ${registeredName} is unavailable until it comes back.`,
        );
      }
      // Identity, not equality, against the live map: syncTools keeps the
      // same descriptor object across a reconnect exactly when nothing
      // about the tool changed. A call can be held between issue and
      // execution — parked on a human's approval — and a reconnect that
      // swapped the definition underneath it must fail the call rather
      // than run the replacement with input approved for the original.
      if (state.tools.get(registeredName) !== info) {
        throw new Error(
          `${registeredName} changed on MCP server ${state.spec.name} after this call was issued — the server now advertises a different definition, or none. Call it again to run the updated tool.`,
        );
      }
      let result;
      try {
        result = await client.callTool({ name: info.mcpName, arguments: input }, undefined, {
          timeout: state.spec.callTimeoutMs,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        // A session-loss surfaces here, not on onclose — see
        // isConnectionFailure. Guarded on the client this call used, so a
        // reconnect that already replaced it is left alone.
        if (isConnectionFailure(error) && state.client === client) {
          dropConnection(state, error);
        }
        // "Connection closed" is all the SDK says about a request the
        // transport died under. When the transport said why, say so here,
        // where the agent reads it.
        //
        // Bounded on the way out, both of them. A `tools/call` that fails
        // at the protocol level never produces a result for
        // `normalizeCallResult` to cap: a JSON-RPC error arrives as an
        // `McpError` whose message the server wrote, and a transport
        // failure can carry an HTTP body. Both reach the agent as a thrown
        // message, which `DefaultExecutor` copies into `ToolResult.error`
        // — persisted on the session and replayed to the provider on every
        // later turn, exactly like output. Failing must not be a wider
        // channel into the transcript than answering.
        const described = error instanceof Error ? error.message : String(error);
        const limit = state.spec.maxResultChars;
        if (isConnectionFailure(error) && state.closeCause !== undefined) {
          throw new Error(boundServerText(`${described} — ${state.closeCause}`, limit, 'error message'));
        }
        throw new Error(boundServerText(described, limit, 'error message'));
      }
      // The resolver, not its answer: resolving creates the workspace and
      // settles its permissions, and a text-only result must not be
      // reported as a failure over a directory it never needed — the remote
      // call has already happened, and a retry does the side effect twice.
      const resolve = workspaceFor;
      return normalizeCallResult(result, {
        server: state.spec.name,
        tool: info.mcpName,
        agentId: session.agent.id,
        maxResultChars: state.spec.maxResultChars,
        // The server's label, lowered to the session's: a file is written
        // from this call's arguments as well as the server's answer, and a
        // session that has read a stranger's text can steer both. Vouching
        // for a server says what it returns, not what was asked of it —
        // the same label `fs.write` records for this session.
        trust: leastTrusted(state.spec.outputTrust, sessionTrustOf(session)),
        ...(resolve !== undefined ? { workspace: () => resolve(session.agent.id) } : {}),
        ...(ledger !== undefined ? { ledger } : {}),
      });
    },
  });

  /** Every page of `tools/list`, not just the first. */
  const listAllTools = async (
    client: Client,
    spec: McpServerSpec,
    remainingMs: () => number,
  ): Promise<AdvertisedTool[]> => {
    const tools: AdvertisedTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      if (pages > MAX_TOOL_LIST_PAGES) {
        throw new Error(
          `MCP server ${spec.name} returned more than ${MAX_TOOL_LIST_PAGES} pages of tools/list; refusing discovery rather than following its cursors forever.`,
        );
      }
      // One budget for the whole walk, not one per page: a fresh timeout
      // for every request would let a slowly paginating server multiply
      // the advertised connect bound by its page count, holding setup —
      // and daemon start — for minutes on end.
      const budget = remainingMs();
      if (budget <= 0) {
        throw new Error(
          `MCP server ${spec.name} did not finish tool discovery within its ${spec.connectTimeoutMs}ms connect budget.`,
        );
      }
      // A cursor is the server's opaque string, the empty string included —
      // dropped on truthiness, an "" cursor would refetch the first page
      // until the page guard condemned a compliant server.
      const page = await client.listTools(cursor !== undefined ? { cursor } : undefined, { timeout: budget });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  };

  /**
   * Reconcile what a server advertises with what is registered — first
   * connect and reconnect run the identical path, through the identical
   * manifest-bound gate. Every difference is logged: a tool appearing,
   * disappearing, or changing shape changes what an agent's allowlist
   * selects.
   */
  const syncTools = (
    state: ServerState,
    advertised: AdvertisedTool[],
    firstConnect: boolean,
  ): void => {
    if (!view) {
      return;
    }
    const next = new Map<string, DiscoveredTool>();
    for (const tool of advertised) {
      // A name too long to bridge leaves that one tool unbridged, named by
      // its length rather than in full — quoting three thousand characters
      // back into the log would be the attack succeeding one line lower.
      // Judged on the name as the server wrote it, ahead of the segment
      // refusal below: that refusal quotes the name and takes the whole
      // plugin down, so a long name of nothing but characters the segment
      // drops (sixty-five emoji) would otherwise reach it and do both.
      if (Array.from(tool.name).length > BRIDGED_SEGMENT_MAX_LENGTH) {
        warn(
          `mcp server ${state.spec.name}: a tool whose name is ${Array.from(tool.name).length} characters long was not bridged: `
          + `a name may be at most ${BRIDGED_SEGMENT_MAX_LENGTH} characters, because it is sent as the tool's name in every `
          + 'model request. Shorten it on the server.',
        );
        continue;
      }
      const segment = sanitizeToolSegment(tool.name);
      if (segment === undefined) {
        throw new McpConfigError(
          `MCP server ${state.spec.name} advertises a tool named ${JSON.stringify(tool.name)}, which leaves nothing usable as a name segment.`,
        );
      }
      const registered = bridgedToolName(state.spec.name, segment);
      // The schema's own prose is bounded the way the description is. A
      // schema too long even then leaves that one tool unbridged, named in
      // the log — not the server refused, and not the plugin: registrations
      // are staged until setup succeeds, so a load-time throw here would
      // take every tool of every configured server down over one page of
      // parameters. The server's to shorten; everything else keeps working.
      // Judged before the collision check below, so a tool that will not
      // be bridged cannot collide with one that will: the order the server
      // lists them in must not decide whether the whole plugin loads.
      const parameters = isObject(tool.inputSchema) ? bridgedSchema(tool.inputSchema) : undefined;
      if (isObject(tool.inputSchema) && parameters === undefined) {
        warn(
          `mcp server ${state.spec.name}: ${registered} was not bridged: its input schema is longer than `
          + `${BRIDGED_SCHEMA_MAX_LENGTH} characters once its descriptions are bounded, or nests deeper than `
          + `${BRIDGED_SCHEMA_MAX_DEPTH} levels, and a schema like that is a page, not a parameter list. Shorten it on the server.`,
        );
        continue;
      }
      if (next.has(registered)) {
        // Folding two of the server's names into one registered name would
        // make the second silently answer calls meant for the first —
        // refused, the same reason any collision is.
        throw new McpConfigError(
          `MCP server ${state.spec.name} advertises two tools that both bridge to ${registered} (one of them ${JSON.stringify(tool.name)}). Rename one on the server.`,
        );
      }
      next.set(registered, {
        mcpName: tool.name,
        ...(typeof tool.description === 'string' ? { description: bridgedDescription(tool.description) } : {}),
        ...(parameters !== undefined ? { parameters: parameters as JsonObject } : {}),
      });
    }

    for (const registered of state.tools.keys()) {
      if (!next.has(registered)) {
        view.unregister(registered);
        log(`mcp server ${state.spec.name} no longer advertises ${registered} — unregistered; souls allowlisting it select nothing until it returns`);
      }
    }
    for (const [registered, info] of next) {
      const existing = state.tools.get(registered);
      const changed = existing !== undefined
        && (existing.mcpName !== info.mcpName
          || existing.description !== info.description
          || JSON.stringify(existing.parameters) !== JSON.stringify(info.parameters));
      if (existing !== undefined && !changed) {
        // The identical descriptor keeps its identity across the
        // reconnect, on purpose: the proxy's staleness check compares the
        // object it captured against this map, and only an actual change
        // may fail a call that was issued — or approved — before it.
        next.set(registered, existing);
        continue;
      }
      if (changed) {
        view.unregister(registered);
      }
      try {
        view.register(proxyTool(state, registered, info));
      } catch (error) {
        // On first connect this is a load-time refusal and propagates; on
        // reconnect there is no load to refuse, so the one colliding tool
        // is skipped, named, and everything else keeps working.
        if (firstConnect) {
          throw error;
        }
        next.delete(registered);
        warn(`mcp server ${state.spec.name}: ${registered} was not registered: ${describeError(error)}`);
        continue;
      }
      if (!firstConnect) {
        log(`mcp server ${state.spec.name} ${changed ? 'changed' : 'added'} ${registered}${changed ? '' : ' — an allowlist naming mcp.' + state.spec.name + '.* now grants it'}`);
      }
    }
    state.tools = next;
  };

  /**
   * Treat a server whose connection failed mid-call as down: further calls
   * refuse with "not connected" instead of re-sending into a dead session,
   * and the reconnect loop brings it back. The onclose handler is keyed to
   * `state.client`, already cleared here, so closing cannot schedule a
   * second reconnect.
   */
  const dropConnection = (state: ServerState, cause: unknown): void => {
    const client = state.client;
    if (!client || disposed) {
      return;
    }
    state.client = undefined;
    state.connected = false;
    warn(
      `mcp server ${state.spec.name} connection failed mid-call — its tools are unavailable until it reconnects: `
      + describeError(cause),
    );
    void client.close().catch(() => {});
    scheduleReconnect(state);
  };

  const scheduleReconnect = (state: ServerState): void => {
    if (disposed || state.timer !== undefined || state.connecting) {
      return;
    }
    const delay = delayFor(state.attempt);
    state.attempt += 1;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void connect(state, false).catch((error) => {
        warn(`mcp server ${state.spec.name} reconnect failed: ${describeError(error)}`);
        scheduleReconnect(state);
      });
    }, delay);
    // A daemon holds the process open anyway; a one-shot CLI run must not
    // be kept alive by a server that is never coming back.
    state.timer.unref?.();
  };

  const connect = async (state: ServerState, firstConnect: boolean): Promise<void> => {
    if (disposed || state.connecting) {
      return;
    }
    state.connecting = true;
    try {
      const transport = await (options.transportFor ?? buildTransport)(state.spec);
      // `disposed` is re-checked after every await from here on: dispose()
      // closes state.client, and a connect still in flight when it runs —
      // one server's load failing while another is mid-handshake — would
      // otherwise finish afterwards and strand a connected client, which
      // for a stdio server is an orphaned subprocess holding granted env.
      if (disposed) {
        await transport.close().catch(() => {});
        return;
      }
      // Tracked from here until the connect settles (the finally below),
      // so dispose() can cut a handshake short instead of waiting for
      // these awaits to notice `disposed` on their own.
      state.pending = transport;
      state.closeCause = undefined;
      // The transport's errors otherwise go nowhere, and the one that
      // closes a stdio connection — a reply over the reader's buffer limit
      // — arrives here moments before the onclose that the tool call then
      // reports as a bare "Connection closed". Hooked on the transport, not
      // on `client.onerror`: the client funnels its own protocol errors
      // through that too, and one of them — a reply landing after its
      // request timed out — carries the entire serialized response in its
      // message. Logged, that is a tool result in the daemon log; retained,
      // it is what an unrelated later failure would be blamed on.
      // `client.connect` wraps whatever handler the transport already has,
      // so this one keeps running underneath the SDK's.
      transport.onerror = (error) => {
        if (disposed) {
          return;
        }
        const described = describeTransportError(error, state.spec);
        warn(`mcp server ${state.spec.name} transport error: ${described}`);
        if (stdioOverflowBytes(error, state.spec) !== undefined) {
          state.closeCause = described;
        }
      };
      const client = new Client({ name: '@stratusagent/plugin-mcp', version: PLUGIN_MCP_VERSION });
      // A close that lands before this client is published cannot be
      // dropped: the identity guard below would discard it, and connect()
      // would then mark an already-closed client connected — leaving the
      // first tool call to fail for nothing and recovery to the call-path
      // classifier.
      let closedBeforePublish = false;
      client.onclose = () => {
        if (disposed) {
          return;
        }
        if (state.client !== client) {
          closedBeforePublish = true;
          return;
        }
        state.connected = false;
        state.client = undefined;
        warn(`mcp server ${state.spec.name} disconnected — its tools are unavailable until it comes back`);
        scheduleReconnect(state);
      };
      // One deadline for the handshake and the whole discovery walk — see
      // listAllTools for why the walk must not get a fresh budget per page.
      const clock = options.now ?? Date.now;
      const deadline = clock() + state.spec.connectTimeoutMs;
      await client.connect(transport, { timeout: state.spec.connectTimeoutMs });
      try {
        const advertised = await listAllTools(client, state.spec, () => deadline - clock());
        if (disposed) {
          throw new Error(`disposed while discovering ${state.spec.name}`);
        }
        if (closedBeforePublish) {
          throw new Error(`MCP server ${state.spec.name} closed the connection during discovery.`);
        }
        syncTools(state, advertised, firstConnect);
      } catch (error) {
        // The client is connected but not yet stored, so nothing else will
        // ever close it — for a stdio server that is a spawned subprocess
        // left running. Let go before reporting the failure.
        await client.close().catch(() => {});
        throw error;
      }
      state.client = client;
      state.connected = true;
      state.attempt = 0;
      log(`mcp server ${state.spec.name} connected — ${state.tools.size} tool${state.tools.size === 1 ? '' : 's'} under mcp.${state.spec.name}.*`);
      options.onConnected?.(state.spec.name);
    } finally {
      state.connecting = false;
      state.pending = undefined;
    }
  };

  return {
    name: '@stratusagent/plugin-mcp',

    async setup(context) {
      view = context.tools;
      // Where the bytes land: the operator's `workspaceRoot` if they wrote
      // one, else the host's layout — see `workspaceResolver`. Without
      // either, a binary block is dropped with a line saying so rather
      // than written somewhere this plugin chose.
      // Prepared rather than resolved: this one is only ever asked when a
      // binary block is about to be written.
      workspaceFor = workspacePreparer(context.workspaces, workspaceRoot);
      // Where the record of them lands: the host's seam wins here, so
      // relocating the output cannot fork the ledger.
      const ledgerRoot = context.workspaces === undefined ? handWiredLedgerRoot : undefined;
      const ledgerWorkspaceFor = workspaceResolver(context.workspaces, ledgerRoot);
      const ledgerPrepareFor = workspacePreparer(context.workspaces, ledgerRoot);
      ledger = ledgerWorkspaceFor !== undefined && ledgerPrepareFor !== undefined
        ? createFileLedger(ledgerWorkspaceFor, ledgerPrepareFor)
        : undefined;
      if (options.log === undefined && context.log !== undefined) {
        log = boundedSink(context.log);
      }
      if (options.warn === undefined && context.warn !== undefined) {
        warn = boundedSink(context.warn);
      }
      await Promise.all(states.map(async (state) => {
        try {
          await connect(state, true);
        } catch (error) {
          // A configuration or trust refusal fails the plugin at load; a
          // server that is merely unreachable must not — the daemon goes
          // on serving every other agent, and this server's tools appear
          // when it does.
          if (error instanceof McpConfigError || (error as Error | undefined)?.name === 'PluginManifestError') {
            throw error;
          }
          warn(
            `mcp server ${state.spec.name} is unreachable — starting without its tools; they register when it comes back. `
            + `Check ${state.spec.command !== undefined ? `the command (${state.spec.command})` : `the endpoint (${describeEndpoint(state.spec.url as string)})`} `
            + `under plugins["@stratusagent/plugin-mcp"].servers.${state.spec.name}. `
            + `(${describeError(error)})`,
          );
          scheduleReconnect(state);
        }
      }));
    },

    async dispose() {
      disposed = true;
      await Promise.allSettled(states.map(async (state) => {
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        // A connect still mid-handshake first: closing its transport kills
        // the child and rejects the in-flight awaits, so shutdown does not
        // wait out a connect timeout on a server that is never answering.
        const pending = state.pending;
        state.pending = undefined;
        await pending?.close().catch(() => {});
        const client = state.client;
        state.client = undefined;
        state.connected = false;
        await client?.close();
      }));
    },
  };
};

/** The loader's ABI. See `docs/architecture/plugins.md`. */
export const createPlugin = (config: JsonObject): Plugin => createMcpPlugin(config);
