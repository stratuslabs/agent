import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { request as httpRequest } from 'node:http';
import path from 'node:path';

import { createGateway, type ApprovalTransport, type Gateway, type GatewayOptions } from '@stratusagent/gateway';
import type { StateEnvironment } from '@stratusagent/state';
import { WebSocket } from 'ws';

import { createControlApi, type ControlApi, type ControlApiOptions } from '../src/index.ts';

export interface Harness {
  home: string;
  gateway: Gateway;
  api: ControlApi;
  /**
   * The approval transport, when the harness was asked for one. Captured the
   * way `stratus serve` captures it — every tool the fleet registers today is
   * `safe`, so nothing can park a call through a real turn yet, and the
   * transport is what remote approval is actually made of.
   */
  transport: ApprovalTransport | undefined;
  url: string;
  token: string;
  /** Authenticated fetch, bearer by default. */
  call(pathname: string, init?: RequestInit & { auth?: 'bearer' | 'cookie' | 'none'; cookie?: string }): Promise<Response>;
  stop(): Promise<void>;
}

/**
 * A POST with headers `fetch` will not let a caller set — `Host` above all,
 * which is exactly what the wildcard-bind rule turns on.
 */
export const rawPost = (
  port: number,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { ...headers, 'content-length': '0' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });

/** A GET with headers `fetch` will not set, reporting the cookie it was handed. */
export const rawGet = (
  port: number,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; setCookie: string | undefined }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (response) => {
        response.resume();
        const raw = response.headers['set-cookie'];
        resolve({ status: response.statusCode ?? 0, setCookie: Array.isArray(raw) ? raw[0] : raw });
      },
    );
    request.on('error', reject);
    request.end();
  });

export const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-api-'));

export const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

/**
 * A gateway and its API, in-process, on the demo provider.
 *
 * No network and no Slack: every route below is exercised against the same
 * objects `stratus serve` wires together, so a test that passes here is a
 * statement about the real daemon rather than about a mock of it.
 */
export const startApi = async (
  setup: {
    home?: string;
    options?: ControlApiOptions;
    approvals?: boolean;
    /**
     * Extra environment for both the gateway and the API — an injected
     * `fetch` above all, which is the only way to make a turn fail inside
     * the runner rather than before it.
     */
    env?: Partial<StateEnvironment>;
    /** Extra gateway options — plugins, above all, which nothing else can inject. */
    gateway?: Partial<GatewayOptions>;
  } = {},
): Promise<Harness> => {
  const home = setup.home ?? await newHome();
  const env: StateEnvironment = { homeDir: home, cwd: home, processEnv: {}, ...setup.env };
  let transport: ApprovalTransport | undefined;
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    ...setup.gateway,
    ...(setup.approvals
      ? {
          approvals: (given: ApprovalTransport) => {
            transport = given;
            return { async approve() { return true; } };
          },
        }
      : {}),
  });
  const api = createControlApi({ env, port: 0, ...setup.options });
  await gateway.start();
  await api.start(gateway);

  const url = api.url;
  const token = api.token;
  assert.ok(url && token, 'the API reports where it bound and what it accepts');

  return {
    home,
    gateway,
    api,
    transport,
    url,
    token,
    async call(pathname, init = {}) {
      const { auth = 'bearer', cookie, headers, ...rest } = init;
      return fetch(`${url}${pathname}`, {
        ...rest,
        headers: {
          ...(auth === 'bearer' ? { authorization: `Bearer ${token}` } : {}),
          ...(auth === 'cookie' && cookie ? { cookie } : {}),
          ...(headers as Record<string, string> | undefined),
        },
      });
    },
    async stop() {
      await api.stop();
      await gateway.stop();
    },
  };
};

/**
 * Awaits something only the feature under test can settle, with a way to
 * lose. Every wait below is for a frame or a turn that a regression makes
 * never arrive — and a suite with no timeout would hang rather than fail,
 * which reads as broken infrastructure instead of as the defect it is.
 *
 * The bound is not a timing assertion: 5s is orders of magnitude above what
 * any of these take, so slack on a loaded runner costs nothing and proves
 * exactly the same thing.
 */
export const settles = async <T>(work: Promise<T>, what: string): Promise<T> => {
  const hung = Symbol('hung');
  const gaveUp = new Promise<typeof hung>((resolve) => {
    const timer = setTimeout(() => resolve(hung), 5_000);
    timer.unref?.();
  });
  const result = await Promise.race([work, gaveUp]);
  assert.notEqual(result, hung, `${what} never settled`);
  return result as T;
};

/**
 * A connected (or refused) event-stream client.
 *
 * Frames are buffered from construction, not from when the caller gets the
 * socket back. The server sends its subscribe acknowledgement the moment the
 * handshake completes, and a helper that attached its listener after `open`
 * resolved would miss it — a race in the test, not in the server, and one
 * that reads as a hang.
 */
export interface SocketClient {
  socket: WebSocket;
  opened: boolean;
  status: number | undefined;
  /** Every frame received, in order. */
  frames: Array<Record<string, unknown>>;
  /**
   * The next frame matching a predicate, read forward from what earlier waits
   * already consumed — so waiting twice for the same frame type reads the
   * second one, the way a stream reader would.
   */
  waitFor<T = Record<string, unknown>>(
    matches: (frame: Record<string, unknown>) => boolean,
    what: string,
  ): Promise<T>;
  close(): void;
}

/** Open an event-stream client, resolving once it is either open or refused. */
export const openSocket = (
  url: string,
  options: { headers?: Record<string, string> } = {},
): Promise<SocketClient> =>
  new Promise((resolve) => {
    const socket = new WebSocket(url, options.headers ? { headers: options.headers } : {});
    const frames: Array<Record<string, unknown>> = [];
    let cursor = 0;
    const waiters: Array<() => void> = [];

    // Attached synchronously, before the handshake can complete.
    socket.on('message', (data) => {
      frames.push(JSON.parse(String(data)) as Record<string, unknown>);
      for (const wake of waiters.splice(0)) {
        wake();
      }
    });

    const client: SocketClient = {
      socket,
      opened: false,
      status: undefined,
      frames,
      async waitFor<T>(matches: (frame: Record<string, unknown>) => boolean, what: string): Promise<T> {
        for (;;) {
          for (let index = cursor; index < frames.length; index += 1) {
            const frame = frames[index];
            if (frame && matches(frame)) {
              cursor = index + 1;
              return frame as T;
            }
          }
          cursor = frames.length;
          await settles(
            new Promise<void>((wake) => {
              waiters.push(wake);
            }),
            what,
          );
        }
      },
      close() {
        socket.close();
      },
    };

    socket.once('open', () => resolve({ ...client, opened: true, waitFor: client.waitFor, close: client.close }));
    socket.once('unexpected-response', (_request, response) => {
      socket.terminate();
      resolve({ ...client, opened: false, status: response.statusCode, waitFor: client.waitFor, close: client.close });
    });
    socket.once('error', () => resolve({ ...client, opened: false, waitFor: client.waitFor, close: client.close }));
  });
