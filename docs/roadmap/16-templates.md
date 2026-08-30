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
- **The review step is the product, and it shows the *effective* result.**
  `stratus agent new --template X` prints what the bundle grants — every tool,
  its risk level, every credential it will ask for, every plugin it enables —
  and requires confirmation. What it prints is the **diff against the config
  that exists**, not the template's requested values: on a host that already
  enables a plugin with different settings, those two differ, and the one the
  operator must approve is the one that will be true afterwards.

  **A glob is disclosed as a glob, not expanded and forgotten.** A template
  granting `web.*` authorizes every tool in that namespace *including ones
  registered later*, by an unpinned plugin update the operator never reviewed.
  Listing only what resolves today shows a narrower grant than the soul
  actually carries. Either the summary names the wildcard and says what it
  will keep admitting, or templates carry literal tool names — the second is
  safer and the first is probably what people want; decide before the first
  template ships one.

  **The summary is computed once, in `@stratusagent/state`, not by the CLI.**
  [17](./17-fleet-console.md) renders this same flow through the API, and two
  implementations of "what will this grant" is two answers to the only question
  the review step asks. `--yes` exists for scripting and is not the documented
  path.
- **Merge and conflict, decided rather than discovered.** A template's
  `plugins` entries meet configuration that already exists, so: an entry that
  is absent is added; an entry already present with compatible settings is
  **reused, not rewritten**; an entry present with a value the template
  contradicts is a **conflict that stops the operation and names both values**,
  because silently keeping either one makes the reviewed summary a lie.
- **Soul and configuration commit together or not at all.** A template that
  wrote a soul and then failed on the config leaves an agent whose allowlist
  references tools nothing enables — the exact half-configured state this step
  exists to prevent. Write to temporaries, then commit; on any failure, remove
  what was written.
- **Concurrent creation is serialized.** The CLI and the dashboard can both
  create an agent, and both read-modify-write the same config file. Take the
  same lock; last-writer-wins on a config file is how an operator loses a
  plugin entry they never touched.
- **Templates name credentials; they never carry them.** A template that needs
  a key names it and the flow tells the operator how to provide it. A template
  is a file that gets copied around and read out of a repository.
- **Missing prerequisites are reported, not silently skipped.** A template
  naming a plugin that is not installed says so, with the install command,
  and creates nothing until it is resolved.
- **A template cannot create a schedule, and says what it needs instead.** A
  schedule is a durable record created through `schedule.every`, which is
  `gated` because its cadence, prompt, and destination are a decision — not
  something a bundle writes. A template whose agent is only useful on a
  schedule (see [26](./26-fleet-introspection.md)) therefore ends its flow by
  *proposing* one for the operator to approve, as a separate reviewed step.
  The alternative — a template that quietly inserts schedule rows — would put
  unattended recurring work behind a bundle nobody read as such.

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
- A template whose plugin settings conflict with existing config stops, names
  both values, and changes nothing.
- A template whose plugin settings match existing config reuses the entry and
  does not rewrite it.
- An induced failure between the soul write and the config write leaves neither
  — asserted by a test that forces it, not by inspection.
- Two creations racing on the same config file both succeed, and the file
  contains both agents' plugin entries.
- The summary the CLI prints and the summary the API returns for the same
  template on the same host are identical, because they are the same code.
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
