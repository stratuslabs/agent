import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A real `stratus serve` in its own process, driven over the control API.
// Shared by the tests that need a daemon a unit test can't stand in for:
// restart recovery (a real SIGKILL) and session isolation (real concurrency).

const cliEntry = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

export interface Daemon {
  child: ChildProcess;
  output: () => string;
  api: (method: string, route: string, body?: unknown) => Promise<{ status: number; json: any }>;
}

/** A real `stratus serve` in its own process, on any free port. */
export const startDaemon = async (home: string): Promise<Daemon> => {
  const child = spawn(process.execPath, ['--experimental-strip-types', cliEntry, 'serve', '--no-events', '--api-port', '0'], {
    cwd: home,
    // Nothing from the developer's shell: no keys, no STRATUS_* settings.
    env: { HOME: home, PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  // Until the caller holds the daemon, its cleanup can't reach the child, so
  // any failure here kills it before rethrowing. Otherwise a startup that
  // stalls leaves serve running and the suite hangs instead of failing.
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve never announced its control API:\n${output}`)), 20_000);
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        const found = /control API on (http:\/\/\S+?)\s/.exec(output);
        if (found?.[1]) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      };
      child.stdout!.on('data', read);
      child.stderr!.on('data', read);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`serve exited (${code ?? signal}) before serving:\n${output}`));
      });
    });
    const token = (await readFile(path.join(home, '.stratus', 'gateway-token'), 'utf8')).trim();
    return {
      child,
      output: () => output,
      async api(method, route, body) {
        const response = await fetch(`${url}/api/v1${route}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, json: await response.json() };
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await exited(child);
    throw error;
  }
};

export const exited = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', () => resolve()));

/** SIGKILL: no shutdown hook runs, nothing is denied or drained. */
export const crash = async (daemon: Daemon): Promise<void> => {
  daemon.child.kill('SIGKILL');
  await exited(daemon.child);
  assert.equal(daemon.child.signalCode, 'SIGKILL');
};

/** The ordinary way out, for the last daemon of a test. */
export const stop = async (daemon: Daemon): Promise<void> => {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
    return;
  }
  daemon.child.kill('SIGTERM');
  const timer = setTimeout(() => daemon.child.kill('SIGKILL'), 15_000);
  await exited(daemon.child);
  clearTimeout(timer);
};

export const waitFor = async <T>(probe: () => Promise<T | undefined>, what: string, daemon: Daemon): Promise<T> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = await probe();
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}; daemon output:\n${daemon.output()}`);
};
