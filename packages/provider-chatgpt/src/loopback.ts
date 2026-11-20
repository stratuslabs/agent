// The one-shot callback listener for a ChatGPT sign-in: plain HTTP on
// 127.0.0.1, because OpenAI accepts no other redirect host. It answers only
// the request carrying the attempt's `state`, so another page poking the port
// can't end the sign-in, and it closes on success, timeout or cancel.
import { createServer, type ServerResponse } from 'node:http';
import { ChatGPTAuthError } from './errors.ts';
import { CALLBACK_PATH } from './protocol.ts';

/** OpenAI's documented example port. Any other free port works on later sign-ins. */
export const PREFERRED_CALLBACK_PORT = 1455;
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;

export interface ListenForCallbackOptions {
  /** Ports to try in order; 0 asks the OS for a free one. Default `[1455, 0]`. */
  readonly ports?: readonly number[];
}

export interface WaitForCallbackOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CallbackListener {
  /** `http://127.0.0.1:<port>/auth/callback`, for the authorize URL and the code exchange. */
  readonly redirectUri: string;
  /**
   * Resolves with the query of the first callback carrying `state`, after the
   * browser has its answer; rejects on timeout, abort or `close()`. The
   * listener closes either way.
   */
  waitFor(state: string, options?: WaitForCallbackOptions): Promise<URLSearchParams>;
  close(): Promise<void>;
}

const page = (message: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stratus Agent</title></head><body><p>${message}</p></body></html>`;

const RECEIVED = page('Stratus received your ChatGPT sign-in. Go back to your terminal to finish.');
const NOT_COMPLETED = page("The ChatGPT sign-in didn't finish. Go back to your terminal for details.");
const MISMATCH = page("This sign-in doesn't match the one Stratus started. Go back to your terminal and start the sign-in again.");

const respond = (response: ServerResponse, status: number, body: string, done?: () => void): void => {
  response.writeHead(status, {
    'content-type': status === 404 ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    connection: 'close',
  });
  response.end(body, done);
};

const describeWait = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.max(1, Math.round(ms / 1000))} seconds`;

export const listenForCallback = async (options: ListenForCallbackOptions = {}): Promise<CallbackListener> => {
  let pending:
    | {
        readonly state: string;
        readonly settle: (params: URLSearchParams) => void;
        readonly fail: (error: Error) => void;
      }
    | undefined;

  const server = createServer((request, response) => {
    // Node's parser passes request targets that aren't URLs (`GET http://[`),
    // and a throw here would be uncaught and end the process mid-sign-in.
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      respond(response, 400, MISMATCH);
      return;
    }
    if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      respond(response, 404, 'Not found.');
      return;
    }
    const current = pending;
    if (current === undefined || url.searchParams.get('state') !== current.state) {
      respond(response, 400, MISMATCH);
      return;
    }
    pending = undefined;
    respond(response, 200, url.searchParams.has('error') ? NOT_COMPLETED : RECEIVED, () => current.settle(url.searchParams));
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // A wait still open would otherwise hold its timer, and the caller, until
    // the timeout: closing during a sign-in (Ctrl+C in setup) cancels it.
    const current = pending;
    pending = undefined;
    current?.fail(new ChatGPTAuthError('cancelled', 'The ChatGPT sign-in was cancelled.'));
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };

  const listenOn = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ port, host: '127.0.0.1', exclusive: true });
    });

  const ports = options.ports ?? [PREFERRED_CALLBACK_PORT, 0];
  let port: number | undefined;
  for (const candidate of ports) {
    try {
      port = await listenOn(candidate);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }
  if (port === undefined) {
    throw new Error(`No port was free for the ChatGPT sign-in callback (tried ${ports.join(', ')}).`);
  }

  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    waitFor: (state, waitOptions = {}) => {
      if (pending !== undefined) {
        return Promise.reject(new Error('This listener is already waiting for a sign-in.'));
      }
      const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
      const { signal } = waitOptions;
      return new Promise<URLSearchParams>((resolve, reject) => {
        const finish = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          pending = undefined;
          void close();
        };
        const onAbort = (): void => {
          finish();
          reject(new ChatGPTAuthError('cancelled', 'The ChatGPT sign-in was cancelled.'));
        };
        const timer = setTimeout(() => {
          finish();
          reject(new ChatGPTAuthError('timeout', `No sign-in came back from the browser within ${describeWait(timeoutMs)}. Start the sign-in again.`));
        }, timeoutMs);
        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        pending = {
          state,
          settle: (params) => {
            finish();
            resolve(params);
          },
          fail: (error) => {
            finish();
            reject(error);
          },
        };
      });
    },
    close,
  };
};
