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

A plugin change needs `stratus restart` before a running daemon sees it.

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
Scalars and arrays replace.

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
- **It does not create schedules.** A schedule is a decision about cadence
  and destination — ask the agent for one and approve it, see
  [Schedules](./schedules.md).
- **It does not sign you in.** A template can name the credentials its
  tools need in the soul's `credentials:` list, but you provide them:
  `stratus credential set <name>`.
