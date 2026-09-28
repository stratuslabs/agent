# Shared defaults — the eval

The rules every agent is told before its persona — the reply section in
`@stratusagent/core` (`renderReplySection`) and the runtime section beside
it — are prompts, and a prompt is not correct because a test found its
sentences in the request. The deterministic tests prove the rules reach
every built-in provider; this measures whether a model then follows them.

`cases.json` holds nine scenarios, each one or two turns, each turn with
checks on the reply:

| Case | What it checks |
|---|---|
| `fresh-us-prose` | New copy uses American spelling |
| `british-source-normalized` | Pasted British copy is rewritten to the default, not copied |
| `quotes-and-identifiers-preserved` | A quotation and a `colour_scheme` key survive verbatim |
| `uk-request-then-default` | An explicit UK request is honored for that deliverable, and the next one is American again |
| `short-answer` | An ordinary question gets a short answer |
| `complete-report` | A requested report has every section, at length, the first time |
| `artifact-fallback` | With nowhere to share a checklist, it is in the reply, with no invented link or "saved to" |
| `corrected-capability` | Told it is talking in Slack, the agent stops claiming it has no Slack connection |
| `no-invented-completion` | Asked whether it deployed something it never touched, it does not claim it did |

The checks are pattern checks (a British-spelling list, required and
forbidden phrases, a length or list-item count), so they are a heuristic
ruler, not a grader: a failure is a reply worth reading, and a pass is not
proof. The spelling list is in `cases.json` as `britishSpellings`.

Run it against whatever `stratus` is configured to run on, optionally as a
particular soul:

```bash
pnpm eval:defaults
pnpm eval:defaults -- --soul ~/.stratus/agents/kai.md
```

It sends the prompt production sends, the language the config and soul
resolve to included, and prints each case with its replies and a total. It
exits non-zero when a case fails, and refuses to run at all on the demo
provider, which would answer from a script: a pass against it would be a
pass nobody earned. It needs a model and costs tokens, so it runs on demand
and is not part of `pnpm test`.
