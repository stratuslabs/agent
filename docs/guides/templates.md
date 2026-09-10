# Templates

A template is a folder of files. Installing one copies them into
`~/.stratus`, so a template can hand you an agent, the skills it uses, and
the plugin configuration behind its tools — in one command instead of four
documents.

## Installing one

```bash
stratus template add ./some-template          # a local folder
stratus template add stratuslabs/template-x   # a GitHub repo
stratus template add https://example.com/t.git
```

It prints everything it would add and asks before touching anything:

```
Example — The layout a template uses. Copy this directory to start your own.

  agent    Scribe (scribe) — fs.read, fs.list, memory.remember, memory.recall
  skill    meeting-notes
  plugin   @stratusagent/tool-fs (npm install -g)
  config   plugins → /home/you/.stratus/config.json

Install this? [y/N]
```

Read that list before saying yes — a template you did not write can name
any npm package, and installing one runs that package's install scripts on
your machine. The same caution you would apply to `npm install -g` applies
here, for the same reason.

- `--yes` installs without asking. For scripts, and for the desktop and web
  UIs, which show the same list in their own window.
- `--force` replaces an agent or skill already installed under that name.
  Without it those are skipped and everything else still installs.

A running daemon holds its roster and its plugins in memory, so anything a
template adds needs `stratus restart` before it is served — a new agent as
much as a new plugin.

## What a template holds

| Path | What it is |
| --- | --- |
| `template.json` | `name` and `description`, shown in the review. The only required file. |
| `config.json` | Merged into `~/.stratus/config.json`. Keys under `plugins` name the packages to install and enable. |
| `agents/*.md` | [Soul files](../concepts/agents.md#soul-files), copied to `~/.stratus/agents/`. The filename is the id. |
| `skills/<id>/SKILL.md` | [Skills](./skills.md), installed exactly as `stratus skill add` installs them. |
| `README.md` | For whoever reads the template. The installer ignores it. |

Every directory is optional. A template that only adds an agent is a folder
with `template.json` and `agents/` in it.

The config merge is additive where it can be: objects merge key by key, so a
template naming one plugin never takes away the plugins you already had.
Scalars and arrays replace. The merged document is checked the way
`stratus run` would read it, so a template whose `config.json` would leave
your config unreadable is refused before anything is copied.

**Read the tool list.** A soul with no `tools:` line may call *every*
registered tool, and the review says so in those words. An empty list and a
missing one are opposites.

## Writing one

Copy [`examples/templates/example`](../../examples/templates/example) and
change the files. Two things that example gets right:

- **The soul's `tools:` and the config's `plugins` agree.** `fs.read` comes
  from `@stratusagent/tool-fs`, which `config.json` enables. A tool no
  enabled plugin contributes is an allowlist entry that grants nothing.
- **Installing a skill does not enable it.** The soul's `skills:` list is
  what does, so a template shipping a skill should name it there too.

Nothing is generated or interpolated — what is in the folder is what lands
on disk, which is what makes reading the folder a real review.

## What it does not do

- **No rollback.** Files are copied one at a time. If something fails
  partway, what already landed stays; the output says what was installed.
  The two things that refuse *before* anything is copied are a config
  fragment your config would not survive, and a package name that is not an
  npm package name.
- **It will not install two agents with one id.** Ids key sessions, memory,
  and credentials, and a duplicate makes the whole roster refuse to load —
  so a soul claiming an id anything already holds is skipped and named.
  That set is your roster, the `soul:` your config points at even when it
  lives outside `~/.stratus/agents`, and the built-in `stratus`. `--force`
  does not override it: `--force` replaces the file of the same name, which
  is a different thing.
- **What you reviewed is what installs.** The soul files are read while the
  review is printed and written from that, so a template directory edited
  while you are deciding cannot slip in a wider tool list. An agent that
  appears at the destination in the meantime is skipped rather than
  overwritten, `--force` aside.
- **It does not create schedules.** A schedule is a decision about cadence
  and destination — ask the agent for one and approve it, see
  [Schedules](./schedules.md).
- **It does not sign you in.** A template can name the credentials its
  tools need in the soul's `credentials:` list, but you provide them:
  `stratus credential set <name>`.
