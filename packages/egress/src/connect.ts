import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { assertRequestAllowed, checkAddress, EgressPolicyError, type EgressPolicy } from './addresses.ts';

/**
 * A DNS lookup that hands the socket only addresses the policy allows.
 *
 * This is the whole point of the module. Resolving a name in one place and
 * connecting in another is a DNS rebinding race: the attacker's server
 * answers `93.184.216.34` for the check and `169.254.169.254` a moment
 * later for the connection, and a checker that looked the name up itself
 * would have validated an address nothing ever connected to. Node lets the
 * connection's *own* resolution be replaced, so the addresses this returns
 * are the addresses the socket uses — there is no second lookup to lose to.
 */
export const createPinnedLookup = (policy: EgressPolicy): net.LookupFunction => {
  const lookup: net.LookupFunction = (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          error,
          '',
          0,
        );
        return;
      }
      const permitted = addresses.filter((entry) => checkAddress(policy, hostname, entry.address).allowed);
      if (permitted.length === 0) {
        const first = addresses[0];
        const verdict = first ? checkAddress(policy, hostname, first.address) : undefined;
        (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          new EgressPolicyError(
            `Refusing to connect to ${hostname}: ${verdict?.reason ?? 'it resolves to no public address'}`,
          ) as NodeJS.ErrnoException,
          '',
          0,
        );
        return;
      }
      if ((options as dns.LookupOneOptions & { all?: boolean }).all) {
        (callback as unknown as (err: null, addresses: dns.LookupAddress[]) => void)(null, permitted);
        return;
      }
      const [chosen] = permitted;
      (callback as (err: null, address: string, family: number) => void)(
        null,
        chosen?.address ?? '',
        chosen?.family ?? 4,
      );
    });
  };
  return lookup;
};

export interface PolicyRequestOptions {
  policy?: EgressPolicy;
  headers?: Record<string, string>;
  /** Give up on the whole exchange after this long. */
  timeoutMs?: number;
  /** Stop reading here. A tool's output is bounded; so is what it downloads. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface PolicyResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** True when `maxBytes` cut the body short. */
  truncated: boolean;
}

/**
 * One HTTP exchange, pinned to a validated address.
 *
 * Redirects are deliberately **not** followed here: each hop is a new
 * request to a new host, so each one has to face the policy again. A
 * caller loops and re-enters this, which is what makes "an approved public
 * URL that redirects into the metadata endpoint" a refusal rather than a
 * fetch.
 */
export const requestThroughPolicy = async (
  rawUrl: string,
  options: PolicyRequestOptions = {},
): Promise<PolicyResponse> => {
  const policy = options.policy ?? {};
  const url = assertRequestAllowed(rawUrl, policy);
  const transport = url.protocol === 'https:' ? https : http;
  const maxBytes = options.maxBytes ?? 2_000_000;

  return new Promise<PolicyResponse>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers: options.headers ?? {},
        lookup: createPinnedLookup(policy),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (response) => {
        let body = '';
        let bytes = 0;
        let truncated = false;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (truncated) {
            return;
          }
          const size = Buffer.byteLength(chunk, 'utf8');
          if (bytes + size > maxBytes) {
            truncated = true;
            // Kept to the cap, not to the end of whichever chunk crossed
            // it: a single response can arrive in one piece, and "stop
            // after the chunk that went over" is no cap at all.
            body += chunk.slice(0, Math.max(0, maxBytes - bytes));
            bytes = maxBytes;
            // Stop the transfer rather than reading a gigabyte into a
            // string we have already decided not to keep.
            response.destroy();
            return;
          }
          bytes += size;
          body += chunk;
        });
        response.on('error', (error) => {
          if (truncated) {
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body, truncated });
            return;
          }
          reject(error);
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body, truncated });
        });
        response.on('close', () => {
          if (truncated) {
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body, truncated });
          }
        });
      },
    );

    if (options.timeoutMs) {
      request.setTimeout(options.timeoutMs, () => {
        request.destroy(new Error(`Timed out after ${options.timeoutMs}ms: ${url.href}`));
      });
    }
    request.on('error', reject);
    request.end();
  });
};

export interface EgressProxy {
  /** `http://127.0.0.1:<port>` — what a browser is launched pointing at. */
  url: string;
  port: number;
  /** Requests this proxy refused, newest last. Surfaced to the agent as the reason a page is blank. */
  refusals: string[];
  close(): Promise<void>;
}

/**
 * A proxy that owns every connection a browser makes, so the browser's own
 * resolver never decides where a request goes.
 *
 * Playwright can intercept requests, but interception happens in the
 * browser and the browser resolves the name itself afterwards — validating
 * there is the rebinding race again, one process further away. Routing
 * Chromium through a proxy that resolves, validates, and connects means the
 * socket the page gets is the socket this policy opened, for the address it
 * checked. Redirects and subresources come back through here too, because
 * every request does.
 */
export const createEgressProxy = async (policy: EgressPolicy = {}): Promise<EgressProxy> => {
  const refusals: string[] = [];
  const sockets = new Set<net.Socket>();

  const dial = async (host: string, port: number): Promise<net.Socket> => {
    const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    const permitted = addresses.find((entry) => checkAddress(policy, host, entry.address).allowed);
    if (!permitted) {
      const first = addresses[0];
      const verdict = first ? checkAddress(policy, host, first.address) : undefined;
      throw new EgressPolicyError(
        `Refusing to connect to ${host}: ${verdict?.reason ?? 'it resolves to no public address'}`,
      );
    }
    // Connected to the checked address itself, not to the name: a second
    // resolution is a second answer, and the attacker chooses when it
    // changes.
    return net.connect({ host: permitted.address, port });
  };

  const server = http.createServer();

  server.on('connect', (request, clientSocket: net.Socket, head: Buffer) => {
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    const [host, rawPort] = (request.url ?? '').split(':');
    const port = Number(rawPort ?? 443);
    if (!host || !Number.isInteger(port)) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    dial(host, port).then(
      (upstream) => {
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        refusals.push(reason);
        // 403 rather than a dropped socket: the page sees a refusal it can
        // render, and the reason reaches the agent through `refusals`.
        clientSocket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${reason}`);
      },
    );
  });

  server.on('request', (request, response) => {
    // Plain HTTP arrives as an absolute-URI request rather than a CONNECT.
    let target: URL;
    try {
      target = assertRequestAllowed(request.url ?? '', policy);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      refusals.push(reason);
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(reason);
      return;
    }

    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port ? Number(target.port) : 80,
        path: `${target.pathname}${target.search}`,
        method: request.method ?? 'GET',
        headers: request.headers,
        lookup: createPinnedLookup(policy),
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', (error) => {
      refusals.push(error.message);
      if (!response.headersSent) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end(error.message);
    });
    request.pipe(upstream);
  });

  await new Promise<void>((resolve) => {
    // Loopback only: this proxy exists to narrow what one process may
    // reach, and a proxy on a shared interface is an open relay.
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    refusals,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

/**
 * What a Chromium launch needs to be actually pinned to a proxy.
 *
 * `--proxy-bypass-list=<-loopback>` is not optional: Chromium bypasses the
 * proxy for loopback and `localhost` by default, so a browser pointed at
 * this proxy would still reach `http://127.0.0.1:8080` directly — which is
 * one of the exact destinations the proxy exists to refuse.
 */
export const chromiumProxyOptions = (proxy: Pick<EgressProxy, 'url'>): { server: string; bypass: string } => ({
  server: proxy.url,
  // Same reason as the flag below, in the form Playwright takes.
  bypass: '<-loopback>',
});

export const chromiumProxyArgs = (proxy: Pick<EgressProxy, 'url'>): string[] => [
  `--proxy-server=${proxy.url}`,
  '--proxy-bypass-list=<-loopback>',
];
