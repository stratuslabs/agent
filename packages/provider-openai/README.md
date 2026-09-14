# @stratusagent/provider-openai

The OpenAI-compatible chat-completions provider, as a **plugin**. It
registers a provider named `openai-compatible` through the plugin seam
([19](../../docs/roadmap/19-registration-seams.md)), and a soul selects it
the way it selects a built-in:

```markdown
---
id: ava
provider: openai-compatible
model: llama3
credentials: [openai.apiKey]
---
```

## Install and enable

```bash
npm install @stratusagent/provider-openai
```

```jsonc
// ~/.stratus/config.json — a trusted config only
{
  "plugins": {
    "@stratusagent/provider-openai": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:11434/v1",   // any chat-completions endpoint; omit for api.openai.com
      "model": "llama3"                          // the default when a soul names none
    }
  }
}
```

Then store the key it uses, as a **named credential** — the agent's own
entry, or one the fleet shares — and list it in each soul's `credentials:`:

```bash
stratus credential set openai.apiKey                # shared by every agent that lists it
stratus credential set openai.apiKey --agent ava    # ava's own account
```

## Settings

| Key | What it sets |
| --- | --- |
| `baseUrl` | The endpoint. Default: the OpenAI API |
| `model` | The model when a soul or config names none. A run with neither is refused, naming both places |
| `headers` | Extra request headers, name to value |
| `vision` | Whether the model takes images. Default `true`; `false` for a text-only model |
| `requestTimeoutMs` | Upper bound on one request. Default five minutes; `0` disables |

## How this differs from `provider: openai`

Same adapter — `createOpenAICompatibleProvider` from
`@stratusagent/providers`, unchanged — arriving the way a third party's
provider would, which is why it exists:

- **The key is a per-agent credential, resolved on every request.**
  `openai.apiKey` goes through the manifest-bound resolver for the agent
  the request is for: its own entry first, then the shared one. Two agents
  on one installed plugin can bill to two accounts, a rotated key takes
  effect on the next turn, and an agent whose soul does not list the name
  cannot use it. Nothing here reads `process.env`.
- **The endpoint is the plugin's setting**, not a stored sign-in's binding.
  The built-in `openai` selection keeps its stored sign-in, its
  endpoint-bound key, and `STRATUS_API_KEY`; none of that reaches this
  plugin, and none of it is needed here.
- **It works as a fallback target**: `fallbackProvider: openai-compatible`
  with a `fallbackModel` fails over to it under the same rules as a
  built-in.

Diagnostics show it as `plugin:openai-compatible`.
