import { createInterface } from 'node:readline';
import type { CliStreams, CliEnvironment } from './environment.ts';
import { writeLine } from './io.ts';
import { CLI_VERSION } from './npm.ts';

// Printed commands must survive copy-paste into a shell, so anything outside
// the safe character set gets single-quoted.
export const quoteShellArg = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** How a menu was answered: a picked option, free text, or backed out. */
type MenuAnswer =
  | { kind: 'index'; index: number }
  | { kind: 'text'; text: string }
  | { kind: 'back' };

interface MenuOptions {
  /** Preselected option (defaults to 0). */
  defaultIndex?: number;
  /** Non-interactive mode: a non-numeric line becomes a 'text' answer. */
  allowText?: boolean;
  /** Extra line printed under the heading (e.g. overflow notes). */
  footnote?: string;
}

// The fixed header drawn at the top of every interactive screen.
export const stratusHeaderLines = (): string[] => {
  const title = 'Stratus Agent';
  const version = `v${CLI_VERSION}`;
  const gap = '   ';
  const content = `  ${title}${gap}${version}  `;
  return [
    `\u001b[2m╭${'─'.repeat(content.length)}╮\u001b[0m`,
    `\u001b[2m│\u001b[0m  \u001b[1m${title}\u001b[0m${gap}\u001b[2m${version}\u001b[0m  \u001b[2m│\u001b[0m`,
    `\u001b[2m╰${'─'.repeat(content.length)}╯\u001b[0m`,
  ];
};

interface PrompterView {
  /** Lines drawn at the top of every interactive menu screen. */
  header(): string[];
  /** Recent status lines to carry onto the next screen (consumed). */
  consumeNotices(): string[];
}

interface SetupPrompter {
  ask(question: string, opts?: { prefill?: string }): Promise<string>;
  /** Like ask, but typed characters are not echoed on interactive TTYs. */
  askSecret(question: string): Promise<string>;
  /** True when menus are arrow-key driven on a real terminal. */
  isInteractive(): boolean;
  /**
   * Present a menu. On interactive TTYs this is arrow-key navigation with a
   * highlighted cursor (↑/↓ or j/k to move, Enter to pick, digits to jump,
   * Esc/q to back out). With piped input it renders the numbered list and
   * reads one line, so scripts and tests drive it exactly as before.
   */
  select(heading: string, options: string[], opts?: MenuOptions): Promise<MenuAnswer>;
  isClosed(): boolean;
  close(): void;
}

export const createSetupPrompter = (
  streams: CliStreams,
  env: CliEnvironment,
  view?: PrompterView,
): SetupPrompter => {
  // On a real TTY, menus are arrow-key driven and secrets are read without
  // echo; with piped input (tests, scripts) everything is plain lines.
  const interactive = env.setupInput === undefined && process.stdin.isTTY === true;

  if (interactive) {
    let closed = false;
    process.stdin.once('end', () => {
      closed = true;
    });

    const question = (prompt: string, secret: boolean, prefill?: string): Promise<string> => {
      const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      if (secret) {
        const internal = readline as unknown as { _writeToOutput?: (chunk: string) => void };
        const original = internal._writeToOutput?.bind(readline);
        internal._writeToOutput = (chunk: string) => {
          // Echo the prompt itself, swallow the typed secret.
          if (chunk.startsWith(prompt)) {
            original?.(prompt);
          }
        };
      }
      return new Promise((resolve) => {
        readline.on('SIGINT', () => {
          readline.close();
          streams.stdout.write('\n');
          process.exit(130);
        });
        readline.question(prompt, (answer) => {
          readline.close();
          if (secret) {
            streams.stdout.write('\n');
          }
          resolve(answer.trim());
        });
        if (prefill) {
          // Pre-typed and editable: backspace over it or press Enter to keep.
          readline.write(prefill);
        }
      });
    };

    // Each menu replaces the screen: clear, draw the header, carry over the
    // most recent status lines, then the menu itself.
    const drawScreen = (out: Pick<typeof process.stdout, 'write'>): void => {
      out.write('\u001b[2J\u001b[H');
      for (const line of view?.header() ?? []) {
        out.write(`${line}\n`);
      }
      const notices = view?.consumeNotices() ?? [];
      if (notices.length > 0) {
        for (const line of notices) {
          out.write(`\u001b[2m${line}\u001b[0m\n`);
        }
        out.write('\n');
      }
    };

    const selectInteractive = (
      heading: string,
      options: string[],
      opts: MenuOptions,
    ): Promise<MenuAnswer> => new Promise((resolve) => {
      const stdin = process.stdin;
      const out = streams.stdout;
      let index = Math.min(Math.max(opts.defaultIndex ?? 0, 0), options.length - 1);

      const wasRaw = stdin.isRaw === true;
      stdin.setRawMode?.(true);
      stdin.resume();

      const render = (redraw: boolean): void => {
        if (redraw) {
          out.write(`\u001b[${options.length}A`);
        } else {
          drawScreen(out);
          if (heading.length > 0) {
            out.write(`${heading}\n`);
          }
          if (opts.footnote) {
            out.write(`${opts.footnote}\n`);
          }
        }
        options.forEach((option, i) => {
          const active = i === index;
          out.write(`\u001b[2K\r${active ? '\u001b[36m\u276f ' : '  '}${i + 1}) ${option}${active ? '\u001b[0m' : ''}\n`);
        });
      };

      const finish = (answer: MenuAnswer): void => {
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer);
          pendingTimer = undefined;
        }
        stdin.off('data', onData);
        if (!wasRaw) {
          stdin.setRawMode?.(false);
        }
        // Pause so keys typed between menus buffer for the next consumer
        // instead of being dropped by a flowing stream with no listener.
        stdin.pause();
        if (pendingEscape.length > 0) {
          stdin.unshift(Buffer.from(pendingEscape, 'utf8'));
          pendingEscape = '';
        }
        resolve(answer);
      };

      const handleKey = (key: string): boolean => {
        if (key === '\u0003') {
          // Ctrl-C: restore the terminal and leave setup entirely.
          stdin.setRawMode?.(false);
          out.write('\n');
          process.exit(130);
        }
        if (key === '\u001b[A' || key === '\u001bOA' || key === 'k') {
          index = (index - 1 + options.length) % options.length;
          render(true);
          return false;
        }
        if (key === '\u001b[B' || key === '\u001bOB' || key === 'j' || key === '\t') {
          index = (index + 1) % options.length;
          render(true);
          return false;
        }
        if (key === '\r' || key === '\n') {
          finish({ kind: 'index', index });
          return true;
        }
        if (key === '\u001b' || key === 'q') {
          finish({ kind: 'back' });
          return true;
        }
        if (/^[1-9]$/.test(key)) {
          const jump = Number(key) - 1;
          if (jump < options.length) {
            index = jump;
            render(true);
            finish({ kind: 'index', index });
            return true;
          }
        }
        return false;
      };

      // Key repeat and pasted input arrive as one chunk containing several
      // sequences — split it into individual keys before handling. Bytes
      // that follow the selecting key (e.g. a pasted "2sk-ant-…") are
      // pushed back onto stdin for whatever prompt comes next. Terminals
      // and SSH can also split an escape sequence ACROSS chunks (ESC, then
      // "[A"), so an incomplete escape tail is held briefly: completed by
      // the next chunk, or treated as a real Esc press after a beat.
      let pendingEscape = '';
      let pendingTimer: ReturnType<typeof setTimeout> | undefined;

      const processText = (text: string): void => {
        let position = 0;
        while (position < text.length) {
          const remaining = text.length - position;
          if (text[position] === '\u001b' && remaining < 3
            && (remaining === 1 || text[position + 1] === '[' || text[position + 1] === 'O')) {
            pendingEscape = text.slice(position);
            pendingTimer = setTimeout(() => {
              // No continuation arrived: it was a genuine Esc press.
              pendingEscape = '';
              pendingTimer = undefined;
              handleKey('\u001b');
            }, 75);
            return;
          }
          let key: string;
          if (text[position] === '\u001b' && (text[position + 1] === '[' || text[position + 1] === 'O')) {
            key = text.slice(position, position + 3);
            position += 3;
          } else {
            key = text[position]!;
            position += 1;
          }
          if (handleKey(key)) {
            const rest = text.slice(position);
            if (rest.length > 0) {
              stdin.unshift(Buffer.from(rest, 'utf8'));
            }
            return;
          }
        }
      };

      const onData = (chunk: Buffer): void => {
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer);
          pendingTimer = undefined;
        }
        const text = pendingEscape + chunk.toString('utf8');
        pendingEscape = '';
        processText(text);
      };

      render(false);
      stdin.on('data', onData);
    });

    return {
      ask: (q, opts) => question(q, false, opts?.prefill),
      askSecret: (q) => question(q, true),
      isInteractive: () => true,
      async select(heading, options, opts = {}) {
        if (options.length === 0) {
          return { kind: 'back' };
        }
        return selectInteractive(heading, options, opts);
      },
      isClosed: () => closed,
      close: () => {
        // A resumed raw-mode stdin keeps the event loop alive; release it
        // so the process can exit once setup returns.
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
      },
    };
  }

  const input = env.setupInput ?? process.stdin;
  const readline = createInterface({ input, terminal: false });
  const pendingLines: string[] = [];
  let closed = false;

  readline.on('line', (line) => {
    pendingLines.push(line);
  });
  readline.once('close', () => {
    closed = true;
  });

  const nextLine = async (): Promise<string> => {
    while (pendingLines.length === 0) {
      if (closed) {
        return '';
      }
      await new Promise<void>((resolve) => {
        readline.once('line', () => resolve());
        readline.once('close', () => resolve());
      });
    }
    return (pendingLines.shift() ?? '').trim();
  };

  const selectPlain = async (
    heading: string,
    options: string[],
    opts: MenuOptions,
  ): Promise<MenuAnswer> => {
    const defaultIndex = Math.min(Math.max(opts.defaultIndex ?? 0, 0), options.length - 1);
    while (true) {
      streams.stdout.write(`${heading}\n`);
      if (opts.footnote) {
        streams.stdout.write(`${opts.footnote}\n`);
      }
      for (const [i, option] of options.entries()) {
        streams.stdout.write(`  ${i + 1}) ${option}\n`);
      }
      streams.stdout.write(`Choose [${defaultIndex + 1}]: `);
      const line = await nextLine();

      if (line === '') {
        if (closed && pendingLines.length === 0) {
          return { kind: 'back' };
        }
        return { kind: 'index', index: defaultIndex };
      }
      if (/^\d+$/.test(line)) {
        const picked = Number(line) - 1;
        if (picked >= 0 && picked < options.length) {
          return { kind: 'index', index: picked };
        }
        writeLine(streams.stdout, `Pick a number between 1 and ${options.length}.`);
        continue;
      }
      if (/^(back|b|q(uit)?)$/i.test(line)) {
        return { kind: 'back' };
      }
      if (opts.allowText) {
        return { kind: 'text', text: line };
      }
      const matched = options.findIndex((option) => option.toLowerCase().includes(line.toLowerCase()));
      if (matched !== -1) {
        return { kind: 'index', index: matched };
      }
      writeLine(streams.stdout, `Pick a number between 1 and ${options.length}.`);
    }
  };

  return {
    async ask(q, opts) {
      streams.stdout.write(q);
      const line = await nextLine();
      return line || (opts?.prefill ?? '');
    },
    async askSecret(q) {
      // Piped input never echoes, so plain reads are safe here.
      streams.stdout.write(q);
      return nextLine();
    },
    isInteractive: () => false,
    async select(heading, options, opts = {}) {
      if (options.length === 0) {
        return { kind: 'back' };
      }
      return selectPlain(heading, options, opts);
    },
    isClosed: () => closed && pendingLines.length === 0,
    close: () => {
      readline.close();
    },
  };
};
