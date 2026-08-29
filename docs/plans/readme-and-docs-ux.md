# Plan: friendly entry points, docs that carry the depth

> **Status: decided and executed.** North star: Paperclip's structure with
> Hermes Agent's install-speed. Tagline: *"Always-on agents that get
> smarter over time."* Hero: the Stratus Labs banner, committed at
> `docs/assets/stratus-banner.png` (the npm page needs an absolute
> `raw.githubusercontent.com` URL, which is why it lives in the repo).
> Docs: plain `docs/` for now; Mintlify is the intended next step when
> ready — the tree is laid out so adopting it is a scaffold change, not a
> reorganization. No community badges yet.

The root `README.md` and `packages/cli/README.md` are the two places a new
person lands — the GitHub repo and the npm package page — and both currently
read as the full product manual. This plan restructures them into short,
action-first entry points and moves the depth into a `docs/` tree organized by
what the reader is trying to do, laid out so it can become a docs site without
rewriting anything.

## Diagnosis

**Root README (462 lines).** The install command appears around line 204.
Before reaching it, a visitor reads a twelve-package inventory, the plugin
trust-model essay, and a twenty-bullet "Current status" list. It is written
inside-out: architecture first, action last. An evaluator deciding in ninety
seconds whether this is interesting never gets to `npm install -g`.

**CLI README (1,034 lines).** This is the operator's manual — setup, approvals,
tools, skills, schedules, the service, updating, logs, doctor, souls, options —
rendered as one scroll on the npm page. The prose is genuinely good (the
reasoning behind each decision is written down, which almost no project does),
but there is no way to skim to "how do I put my agent on Slack" and a
first-time npm visitor wants three things: what is it, how do I install it,
where is the rest.

**Duplication.** Install steps, the Node-version explanation, the setup
walkthrough, the soul-file explainer, and the options list each appear in both
files with different wording. `CLAUDE.md` already documents doc drift as this
repo's recurring failure mode; two copies of everything is how it happens.

**Mixed audiences in one scroll.** Five readers arrive at these files —
evaluator ("what is this?"), new user ("get me running"), operator
("approvals, logs, update"), contributor ("from source"), ecosystem developer
("the plugin contract") — and the current structure serves them all
simultaneously, which serves none of them.

## What good looks like (inspiration)

Surveyed as references — worth opening side by side when reviewing this plan:

- **[Vite](https://github.com/vitejs/vite)** — the minimal pole: ~40 lines,
  tagline, six feature bullets, "Read the Docs to Learn More". Works because
  vite.dev carries everything. Our Phase 1 target is *not* this minimal (we
  have no site yet), but it calibrates how little a README can be.
- **[Bun](https://github.com/oven-sh/bun)** — the README as a navigation hub:
  install within the first 100 lines, then a categorized index of links into
  the docs. Good model for the "docs table" section.
- **[OpenClaw](https://github.com/openclaw/openclaw)** — the closest product
  analog (always-on personal assistant that meets you in your existing chat
  apps). One-line value prop, install by the third section, a three-command
  quickstart, a "How it fits together" overview, a security section, and a
  goal-based documentation table ("connect messaging" → page). Docs site on
  Mintlify. This is the structural template to beat.
- **[Charm's `vhs`](https://github.com/charmbracelet/vhs)** — terminal GIFs
  from a checked-in tape file, reproducible in CI. The hero asset both
  READMEs are missing is a 20-second loop of `stratus setup` → agent answers
  in Slack.

## Target information architecture — three tiers

**Tier 1 — root README (~120–150 lines).** The pitch and the fastest path in.

```
logo / wordmark + one-line tagline + badges (npm, CI, node, license)
what it is — 3 sentences, then 5–6 one-line feature bullets
hero image (terminal GIF or the existing dashboard screenshot)
Quickstart — install, setup, chat: three commands
"What your agents can do" — one line per capability, each linking into docs
Documentation table — goal → page (the OpenClaw pattern)
From source (5 lines) → CONTRIBUTING/docs link
Status & roadmap — 2 sentences + links
License
```

**Tier 2 — package READMEs.** `packages/cli/README.md` (~150 lines): tagline,
screenshot, install, the command table with one line per command, the options
table, and a link into docs for every deep topic. Other package READMEs keep
their contract summary and link into docs for anything shared.
`packages/control-api/README.md` stays the full API contract — two other
surfaces are written against it (per `CLAUDE.md`), so it does not move.

**Tier 3 — `docs/`.** All the depth, one home per fact, organized by reader
intent. The current prose *moves* — lightly edited, not rewritten. Its
reasoning-rich style is a liability in a README and an asset in a guide.

```
docs/
  README.md                # docs index: the goal table, mirrored from root
  start/
    installation.md        # install + the one canonical Node-range explanation
    setup.md               # the setup menu, Save & finish, what gets stored where
    quickstart.md          # demo provider, first real run, what you'll see
  guides/
    slack.md               # connecting agents to Slack (fronts channel-slack README)
    tools.md               # installing/enabling tool plugins, per-agent roots, the two gates
    shell.md               # which commands run unattended, scopes, Always allow
    skills.md              # installing, enabling, writing skills
    approvals.md           # headless vs remote, the Slack approval flow
    schedules.md           # proactive agents: schedule.*, message.send
    always-on.md           # the service, launchd/systemd, the login caveats
    logs.md                # stratus logs, the trace-not-transcript rule, the empty-log case
    updating.md            # stratus update, migrations, downgrade refusal
    troubleshooting.md     # stratus doctor + the common surprises
    mcp.md                 # mounting MCP servers
    remote-access.md       # dashboard sign-in links, --gateway, the tunnel posture
  reference/
    cli.md                 # every command + the full options table (canonical)
    config.md              # config keys, the precedence chain, trusted-config rule
  concepts/
    agents.md              # "Agents are people": souls, ids, identity
    memory.md              # remember/recall/forget, the JSONL, the index
    plugins.md             # user-facing trust model: installing ≠ running
    security.md            # the posture in one place: secrets files, egress, log contents
  architecture/            # unchanged (v1, v2, plugins contract)
  roadmap/                 # unchanged
```

Every section of the current two READMEs has exactly one destination in this
tree; the migration is a mapping, not a rewrite. Roughly: CLI README's
"Setup" → `start/setup.md`, "Tools"/"Which commands run unattended" →
`guides/tools.md`/`guides/shell.md`, "Skills" → `guides/skills.md`,
"Proactive" → `guides/schedules.md`, "Always on" → `guides/always-on.md`,
"Updating" → `guides/updating.md`, "Logs" → `guides/logs.md`, "When something
looks off" → `guides/troubleshooting.md`, "Agents are people" →
`concepts/agents.md` + `concepts/memory.md`, "Options" → `reference/cli.md`;
root README's plugin essay → `concepts/plugins.md`, quickstart →
`start/quickstart.md`.

## The docs site (Phase 2)

The tree above renders fine on GitHub on day one — that is deliberate, so the
restructure is not blocked on any site decision. When we want a real site,
three credible options:

| Option | What it is | Fit |
| --- | --- | --- |
| **Astro Starlight** (recommended) | OSS docs framework, lives in the repo, deploys to GitHub Pages via one Action. Sidebar, full-text search, dark mode, i18n out of the box. Used by Cloudflare's and Biome's docs. | Best default: no vendor, no account, markdown stays plain (only a `title` frontmatter per page). |
| **Mintlify** | Hosted docs platform, the prettiest output for the least work; what OpenClaw uses. Free for open source. | Best if we want maximum polish fast and don't mind a hosted dependency + `docs.json`. |
| **VitePress** | Lighter OSS option from the Vite ecosystem. | Fine, but Starlight gives more for the same effort. |

Recommendation: **plain markdown now, Starlight when a domain exists.** The
tree is already shaped for either — adopting Starlight later is a scaffold
commit plus frontmatter, not a reorganization. Needs a decision on hosting:
GitHub Pages at `stratuslabs.github.io/agent` works with zero assets; a real
domain (`docs.stratusagent.dev` or similar) is nicer and needs DNS from you.

## Guardrails

- **`CLAUDE.md`'s doc map changes in the same PR.** It currently names
  `packages/cli/README.md` as "the detailed one"; after this, the detailed
  surface is `docs/`, and the docs-land-with-the-change rule needs to name the
  new homes so future PRs know where a new flag gets documented.
- **One home per fact.** Entry points link; docs own depth. The README never
  restates a rule a docs page owns — that is the drift this repo already
  fought once.
- **Move, don't paraphrase, the security-sensitive prose.** The two
  asymmetries `CLAUDE.md` calls out (`--no-login` on macOS, the
  before-serving errors the JSONL never sees) and the log-sharing caveat are
  exactly the paragraphs a friendly rewrite would flatten into being wrong.
  They move verbatim, qualifications intact.
- **Vocabulary holds.** Plugin / tool / toolset / skill / soul, one word per
  thing, per `docs/architecture/plugins.md`.
- **`HELP_TEXT` is untouched** and `reference/cli.md` is written from it.
- **Anchor breakage is accepted** for the root README (external links to
  deep anchors will 404 to the top of the file); the npm page updates on the
  next publish, so the CLI README rewrite should land just before a release.

## Phasing

1. **PR A — the docs tree.** Create `docs/` structure, move CLI README depth
   into it, slim the CLI README, update `CLAUDE.md`'s doc map. The biggest
   diff, but almost entirely moved text.
2. **PR B — the root README.** Rewrite as the Tier-1 pitch, add the docs
   table, slim the tool/channel package READMEs to summary-plus-link. (A and
   B can be one PR if review appetite allows; A alone is already coherent.)
3. **PR C — the site.** Starlight scaffold + GitHub Pages deploy, once the
   hosting decision is made. Independent of A/B.
4. **PR D — polish.** `vhs` tape + terminal GIF, badges, GitHub social
   preview image, `llms.txt` for AI-assistant discoverability.

## Success criteria

- The install command is visible without scrolling on both entry points.
- Any "how do I …" is reachable in at most two clicks from either README.
- No normative statement (a rule, a default, a path, a risk level) exists in
  two places.
- The word count of the two entry points drops by ~75%; the total word count
  of the documentation does not (nothing of substance is deleted).

## Decisions and assets needed

1. **Docs hosting** — plain `docs/` only for now, Starlight on GitHub Pages,
   or Mintlify? (Plan assumes: plain now, Starlight later.)
2. **A logo/wordmark** and whether the existing CLI screenshot stays the hero,
   or we produce a `vhs` terminal GIF (can be generated in-repo).
3. **One tagline everywhere.** The root says "a tiny JavaScript agent runtime
   and CLI"; the CLI README says "always-on agents that get smarter over
   time." The second sells the product, the first describes the implementation
   — recommend the second, with the first as a subtitle for the contributor
   audience.
4. **Community links** — is there a Discord/discussion venue to badge, and
   should npm download/version badges appear?
