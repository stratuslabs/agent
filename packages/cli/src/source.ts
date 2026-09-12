import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readWorkingDirectory } from '@stratusagent/state';
import type { CliEnvironment } from './environment.ts';

/**
 * What a `skill add` source string means, in order: a directory on this
 * machine, a GitHub `owner/repo` shorthand, or a URL git can clone. The
 * shorthand is the form skills.sh and its CLI print, so a skill published
 * there installs by the name its listing shows.
 */
export const resolveSource = async (
  source: string,
  env: CliEnvironment,
  what: 'skill' | 'template',
): Promise<{ kind: 'local'; directory: string } | { kind: 'git'; url: string }> => {
  const localPath = path.resolve(readWorkingDirectory(env), source);
  try {
    if ((await stat(localPath)).isDirectory()) {
      // The real directory, not the path as typed: a source that is
      // itself a symlink would otherwise be copied as that link — an
      // installed entry pointing back at the source tree, which the
      // loader ignores as not-a-directory.
      return { kind: 'local', directory: await realpath(localPath) };
    }
  } catch {
    // Not a local directory; read it as a remote source.
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return { kind: 'git', url: `https://github.com/${source}` };
  }
  if (/^(https?|git|ssh|file):\/\//.test(source) || /^git@[\w.-]+:/.test(source)) {
    return { kind: 'git', url: source };
  }
  throw new Error(
    `Cannot read ${JSON.stringify(source)} as a ${what} source. Pass a GitHub owner/repo, a git URL, or a local path.`,
  );
};

/**
 * A source URL safe to print: userinfo stripped. A token travels in exactly
 * this position (`https://user:token@host/repo.git`), stdout is commonly
 * retained in CI logs, and git's own stderr already redacts — only the
 * unredacted URL is handed to git itself.
 */
export const redactedSourceUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    // scp-style (git@host:path) or anything else URL() refuses: keep the
    // shape, hide whatever sits before the @.
    return url.replace(/^[^@/]+@/, '***@');
  }
};

/** Shallow-clone a source repository. Git owns every transport we would otherwise re-implement. */
export const cloneSource = async (url: string, destination: string): Promise<void> => {
  const display = redactedSourceUrl(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', '--quiet', url, destination], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      reject(new Error(`Could not run git to fetch ${display}: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // git redacts credentials in its own messages; the URL we echo is
        // ours to redact.
        reject(new Error(`git clone failed for ${display}: ${stderr.trim() || `exit code ${code}`}`));
      }
    });
  });
};
