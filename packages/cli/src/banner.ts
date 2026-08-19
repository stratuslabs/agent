/**
 * The logo-beside-facts welcome screen, in the shape `neofetch` made familiar.
 *
 * Shown when somebody types `stratus` with no arguments — which is a person
 * asking "what is this", not a script — and nowhere else. It is not shown for
 * an explicit `stratus help` or `--help`, which is reference material somebody
 * may well be piping into a pager or a grep.
 *
 * `shouldShowBanner` is the whole policy in one function so that a second call
 * site cannot invent its own rules. This is the easiest thing in a CLI to make
 * obnoxious, and the gating is more of the work than the art.
 *
 * Colour is gated on **stdout**, not stdin. The rest of this CLI checks
 * `process.stdin.isTTY`, which is the wrong stream: `stratus chat > file` has a
 * terminal on stdin and a file on stdout, and writes escape codes into the
 * file. Nothing here repeats that.
 */

const CYAN = '[36m';
const DIM = '[90m';
const RESET = '[0m';

export const STRATUS_ART: readonly string[] = [
  ' #### ##### ####   ###  ##### #   #  ####',
  '#       #   #   # #   #   #   #   # #',
  ' ###    #   ####  #####   #   #   #  ###',
  '    #   #   #  #  #   #   #   #   #     #',
  '####    #   #   # #   #   #    ###  ####',
];

export interface BannerFact {
  label: string;
  value: string;
}

export interface BannerConditions {
  /** Whether **stdout** is a terminal. Not stdin — see the note above. */
  stdoutIsTty: boolean;
  processEnv: NodeJS.ProcessEnv;
}

/**
 * The CI variables worth checking. Not exhaustive by design — every provider
 * that matters sets `CI`, and the rest are here because they are cheap and
 * their absence would be noticed.
 */
const CI_VARS = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'BUILDKITE', 'TEAMCITY_VERSION'];

const isCI = (processEnv: NodeJS.ProcessEnv): boolean =>
  CI_VARS.some((name) => {
    const value = processEnv[name];
    return value !== undefined && value !== '' && value !== '0' && value !== 'false';
  });

/**
 * May the banner be shown?
 *
 * Each clause is a way this becomes noise rather than charm:
 *
 * - **not a TTY** — it is being piped or redirected, and art in a file is
 *   corruption, not decoration.
 * - **CI** — nobody reads it, and it costs a screen of every build log.
 * - **`NO_COLOR` / `TERM=dumb`** — the user has asked for plain output; a
 *   wordmark drawn out of hashes is the opposite of that.
 */
export const shouldShowBanner = ({ stdoutIsTty, processEnv }: BannerConditions): boolean => {
  if (!stdoutIsTty) {
    return false;
  }
  if (isCI(processEnv)) {
    return false;
  }
  if (processEnv['NO_COLOR'] !== undefined || processEnv['TERM'] === 'dumb') {
    return false;
  }
  return true;
};

/**
 * The facts beside the art.
 *
 * Deliberately local: version, runtime, platform. Nothing here reads a config
 * file, a credential, or the network. This renders before the user has asked
 * the CLI to do anything, and a welcome screen that can hang or fail is a
 * welcome screen that turns `stratus` into a support ticket. It is also the
 * reason the daemon's state is not shown here — that is what `stratus doctor`
 * is for, and it can afford to be slow and to fail.
 */
export const bannerFacts = (version: string, platform: string): BannerFact[] => [
  { label: 'cli', value: `stratus ${version}` },
  { label: 'node', value: process.versions.node },
  { label: 'platform', value: platform },
];

const width = (line: string): number => line.replace(/\[[0-9;]*m/g, '').length;

const padEnd = (line: string, to: number): string => line + ' '.repeat(Math.max(0, to - width(line)));

export interface RenderOptions {
  /** Terminal width. Falls back to 80, which is also what a 0 becomes. */
  columns?: number;
  /** Emit ANSI colour. Off makes the output diffable in a test. */
  colour?: boolean;
}

/**
 * Art on the left, facts on the right — stacking when the terminal is too
 * narrow to hold both.
 *
 * A side-by-side layout that overflows wraps into interleaved nonsense, which
 * looks far worse than two blocks, and 80 columns is not a safe assumption when
 * half the world reads this in a split pane.
 */
export const renderBanner = (
  art: readonly string[],
  facts: readonly BannerFact[],
  options: RenderOptions = {},
): string[] => {
  const columns = options.columns !== undefined && options.columns > 0 ? options.columns : 80;
  const colour = options.colour ?? true;
  const gap = 3;

  const paint = (text: string): string => (colour ? `${CYAN}${text}${RESET}` : text);
  const label = (text: string): string => (colour ? `${DIM}${text}${RESET}` : text);

  const artWidth = art.reduce((widest, line) => Math.max(widest, width(line)), 0);
  const labelWidth = facts.reduce((widest, fact) => Math.max(widest, fact.label.length), 0);
  const factWidth = facts.reduce(
    (widest, fact) => Math.max(widest, labelWidth + 2 + fact.value.length),
    0,
  );

  const renderFact = (fact: BannerFact): string =>
    `${label(padEnd(fact.label, labelWidth))}  ${fact.value}`;

  if (artWidth + gap + factWidth > columns) {
    return [...art.map((line) => paint(line)), '', ...facts.map(renderFact)];
  }

  const lines: string[] = [];
  const height = Math.max(art.length, facts.length);

  for (let index = 0; index < height; index += 1) {
    const artLine = art[index] ?? '';
    const fact = facts[index];

    if (fact === undefined) {
      // No padding with nothing to align against. Trailing whitespace is
      // invisible until the output lands in a diff, where it is a lint failure
      // with no obvious cause.
      lines.push(artLine === '' ? '' : paint(artLine));
      continue;
    }

    // Padded before painting, so the width being measured is the plain text's.
    const left = artLine === '' ? padEnd('', artWidth) : paint(padEnd(artLine, artWidth));
    lines.push(`${left}${' '.repeat(gap)}${renderFact(fact)}`);
  }

  return lines;
};
