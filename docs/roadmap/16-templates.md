# 16 — Agent templates: a working teammate in one command

## Goal

`stratus agent new --template triage` produces an agent that already does
something: a soul with a persona, a tool allowlist, the skills it needs, and
the plugin configuration those tools require — as **one bundle a human reviews
before it is enabled**, not as two configuration gates answered separately by
someone reading three guides.

## Why now

Every capability in steps 06 and 09–14 is reachable only by an operator willing
to hand-write frontmatter and then find the second gate. The two gates are
correct and this step does not touch them: installing a plugin runs nothing, a
config the operator chose must enable it, and the soul must allowlist its
tools. What is wrong is that both gates are answered by hand, one at a time,
from separate documents, before anything works at all.

A template is the only fix that keeps both gates and removes the cost of
answering them: it is a *proposal* for both, presented together, that the
operator accepts once. The gates still exist — the difference is that they are
answered by reviewing a bundle rather than by authoring one.

The order matters too. `stratus agent new` today produces an agent with a name,
an avatar, and no capability, which means the first thing anyone sees is the
least of what the product does.

## Scope

**In:**

- **A template format**, versioned and first-party, that carries: soul
  frontmatter (persona prose, `tools`, `skills`, `credentials`), the `plugins`
  entries its tools need, and a human-readable summary of exactly what the
  bundle will let the agent do.
- **Three or four templates that earn their place**, each exercising a
  different part of the stack rather than demonstrating the same one: a
  research agent (`web.*`, skills), an on-call/triage agent (`fs.read`,
  `web.fetch`, schedules), a shell-capable operator agent (`shell.run` under
  command scopes), and a memory-heavy assistant.
- **The review step is the product.** `stratus agent new --template X` prints
  what the bundle grants — every tool, its risk level, every credential it will
  ask for, every plugin it enables — and requires confirmation. `--yes` exists
  for scripting and is not the documented path.
- **Templates name credentials; they never carry them.** A template that needs
  a key names it and the flow tells the operator how to provide it. A template
  is a file that gets copied around and read out of a repository.
- **Missing prerequisites are reported, not silently skipped.** A template
  naming a plugin that is not installed says so, with the install command,
  and creates nothing until it is resolved.

**Out:**

- Weakening either gate. A template that enabled itself would be the
  auto-loading `plugins.md` forbids, wearing a friendlier name.
- Third-party or registry-distributed templates. That is 12, and it is exactly
  where a template stops being a reviewed bundle and starts being untrusted
  code selection. First-party only, shipped in the CLI.
- A template DSL. Conditionals, interpolation, and composition are how a
  format stops being reviewable, which is the only property that matters here.
- Editing an existing agent. Templates create; changing an agent afterwards is
  the soul file and 17.

## Design sketch

- A template is a static bundle plus a rendering step for the two things that
  are genuinely per-agent — the id and the display name. Everything else is
  literal, so what the operator reviewed is what lands on disk.
- The bundle resolves through the same paths a hand-written agent does. There
  is no template-only code path into the roster, because a second path is a
  second set of validation rules that will disagree with the first.
- The risk summary is derived from the **resolved** tool descriptors, not from
  anything the template asserts about itself. A template claiming `shell.run`
  is `safe` must not be able to say so — the floor rules from 06 and 11 decide,
  and the summary reports what they decided.
- Templates live beside the CLI and ship with it, so a template can never be
  newer than the code that has to understand it.

## Acceptance criteria

- From a fresh install with a provider signed in, one command produces an agent
  that successfully uses a real tool — verified end to end, not by inspecting
  the files it wrote.
- The confirmation step lists every tool with its resolved risk, and a template
  whose manifest lies about risk shows the floored value.
- A template naming an uninstalled plugin fails with the install command and
  creates no partial agent — no soul file, no config entry.
- A template naming a credential the operator has not provided creates the
  agent and reports the missing credential; the agent's other tools work.
- `--yes` produces byte-identical output to the interactive path.
- Two agents created from the same template have distinct ids, distinct avatar
  palettes, and no shared state.

## Open questions

- **Does a template pin plugin versions?** Pinning makes a bundle reproducible
  and makes it go stale; not pinning makes "what the operator reviewed" a
  moving target. Leaning unpinned with the installed version shown in the
  summary, on the grounds that the summary is the thing being reviewed.
- **Is there a `--template` for `stratus setup`?** The setup menu already
  offers packages the operator's answers imply, and templates are a better
  version of that conversation. Probably yes, and probably after this step
  proves the format.
