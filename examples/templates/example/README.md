# Example template

The layout `stratus template add` expects. Copy this directory, change the
files, and point the command at it:

```bash
stratus template add ./examples/templates/example
```

| Path | What it is |
| --- | --- |
| `template.json` | The name and one-line description shown in the review. The only required file. |
| `config.json` | Merged into `~/.stratus/config.json`. The keys under `plugins` name the packages to install and enable. |
| `agents/*.md` | Soul files, copied to `~/.stratus/agents/`. The filename is the id. |
| `skills/<id>/SKILL.md` | Skills, installed into `~/.stratus/skills/` exactly as `stratus skill add` installs them. |
| `README.md` | For whoever is reading the template. The installer ignores it. |

Every directory is optional except `template.json` — a template that only
adds a soul is a directory with `template.json` and `agents/` in it.

Two things worth copying from this example:

- **The soul's `tools:` and the config's `plugins` agree.** `fs.read` and
  `fs.list` come from `@stratusagent/tool-fs`, which `config.json` enables.
  A tool no enabled plugin contributes is an allowlist entry that grants
  nothing.
- **The soul's `skills:` names a skill the template ships.** Installing a
  skill does not enable it; the soul opting in is what does.
