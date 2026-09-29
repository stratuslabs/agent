# Single-tenant VM profile

The default configuration for a server of your own, as a
[template](../../../docs/guides/templates.md): every tool plugin loaded,
gated calls asked of a designated approver in Slack, only named people given
a turn, and the control API on loopback. The recipe around it — Docker or a
system unit, credentials, logs, backups, upgrades — is
[Deployment](../../../docs/guides/deployment.md).

It is a template rather than a `config.json` to copy because a template's
`config.json` is merged into `~/.stratus/config.json` — the trusted config —
so it may carry the `approvals`, `principals`, `api`, and `plugins` blocks a
project-local config is refused. The installer prints every value it would
set, and the one it replaces, before it writes anything; a key you already
have is only changed if the template names it.

```bash
# Docker: the template is not in the image, so pipe it in through /tmp
# (the image's root filesystem is read-only; /tmp is a tmpfs)
tar -C examples/profiles -cf - vm | docker exec -i stratusd tar -C /tmp -xf -
docker exec -it stratusd stratus template add /tmp/vm
docker exec stratusd stratus restart

# A system unit
sudo -u stratus -H stratus template add ./examples/profiles/vm
sudo systemctl restart stratusd
```

## Before you install it: replace the placeholders

| In `config.json` | Placeholder | Put there |
| --- | --- | --- |
| `approvals.slackApprovers` | `U01APPROVER` | The Slack user id of whoever may allow a gated call. In Slack: their profile → ⋯ → *Copy member ID*. |
| `approvals.slackChannel` | `C01APPROVALS` | A channel to ask in when the turn did not start in Slack — a scheduled firing, a control API dispatch. Invite the agent's app to it. |
| `principals.slackUsers` | `U01APPROVER`, `U01OPERATOR`, `U01TEAMMATE` | Everyone who counts as the operator. With `"admit": "principals"`, nobody else gets a turn at all — see [Slack](../../../packages/channel-slack/README.md#who-counts-as-the-operator). |

An approver id that is still `U01APPROVER` is nobody, so every gated call is
denied: wrong, but in the safe direction.

## What it sets, and why

| Setting | Value | Why |
| --- | --- | --- |
| `approvals.mode` | `remote` | Nobody is at the server's terminal. A gated call parks and is asked in Slack instead of being refused ([Approvals](../../../docs/guides/approvals.md)). |
| `approvals.timeoutMs` | 15 minutes | Unanswered is denied, not left parked overnight. |
| `principals.admit` | `principals` | A wide-access agent on a shared workspace should not take instructions from anyone who can mention it. |
| `api` | `127.0.0.1:4123` | Loopback. The Docker image passes `--api-host 0.0.0.0` so the published port reaches it, and the compose file publishes that port on the host's loopback only. |
| `plugins` | `tool-fs`, `tool-shell`, `tool-web`, `tool-browser` | All four [tool plugins](../../../docs/guides/tools.md). Enabling one grants no agent anything by itself — a soul's `tools:` list does that. |
| `tool-fs` roots | `ops` only: its own workspace | No roots means no filesystem. This lets `ops` read back what its tools produced; add directories you want it to read. |

Slack is not in `plugins`: `@stratusagent/channel-slack` is wired by the
daemon itself and connects every agent whose tokens are stored. Store them
with `stratus setup` or the control API, never in an env file — see
[Deployment](../../../docs/guides/deployment.md#credentials).

## The agent

`agents/ops.md` names exactly the tools it may call. A soul with no
`tools:` list may call **every** tool these plugins load — the daemon warns
about each soul file like that at startup — and so may the built-in
`stratus` agent. Under `remote` approvals their gated calls are still asked
in Slack, but give each agent you create its own `tools:` list, and read
[Agents](../../../docs/concepts/agents.md) before handing one a shell.

## Browser

`tool-browser` needs a browser. The Docker `browser` target ships Playwright's
Chromium. On a system unit, install one the way the
[`tool-browser` README](../../../packages/tool-browser/README.md#install)
says, as the `stratus` account (`sudo -u stratus -H …`) so it lands in that
account's cache, or point the plugin at an installed Chrome with
`"channel": "chrome"`. Without one the daemon still runs, and a `browser.*`
call fails with a message naming the fix.
