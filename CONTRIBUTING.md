# Contributing

Thanks for helping. This page covers getting a checkout running, what a
pull request needs, and where new features belong.

Security problems don't go in issues or pull requests. See
[SECURITY.md](SECURITY.md).

## Before you start

- **Bugs:** open an issue with the bug template, or send a PR with a test
  that fails without the fix.
- **Anything larger:** open an issue with the feature template first, so we
  can agree on the shape before you write it.
- **New capability usually belongs in a plugin.** The core is kept small on
  purpose. Providers, channels, tools, memory stores and executors are all
  plugins, and a new one can live in its own package. Change the core only
  when a plugin can't be written without it, and say why in the issue.
  [Extending](docs/guides/extending.md) shows how to write one, and
  [the plugin contract](docs/architecture/plugins.md) is what it builds
  against.

## Set up a checkout

You need Node 22.16+ on the 22.x line, or Node 24+ (not 23.x), and pnpm
through Corepack.

```bash
corepack enable && corepack prepare pnpm@10.18.3 --activate
git clone https://github.com/stratuslabs/agent.git && cd agent
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm test    # what CI runs
node packages/cli/dist/bin.js setup          # the CLI from the checkout
```

To run one package's tests while you work:

```bash
pnpm --filter @stratusagent/core test
```

## What a pull request needs

[`CLAUDE.md`](CLAUDE.md) holds the house conventions and the reasons for
them. Read it before your first PR. In short:

- **CI green.** `pnpm build && pnpm typecheck && pnpm test` is the whole
  automated gate. There's no linter or formatter, so match the code around
  your change.
- **A test that fails without the change.** Tests use plain `node:test`
  and live in `packages/<pkg>/test/`. Check that yours fails before your
  change and passes after it.
- **Docs in the same PR.** Anything a user could notice gets documented in
  the file `CLAUDE.md` names for it: a command, a flag, a default, a config
  key, a file Stratus writes.
- **One change per PR,** based on `main`. Once you've pushed, add commits
  or merge `main` in. Don't rebase or force-push, because that loses the
  review history.
- **The PR template filled in.** Say where the change is documented and
  what you checked. A change to something people see (the dashboard, setup,
  Slack messages) needs screenshots in the PR description.

A maintainer reviews every PR, and an automated reviewer may comment too.

## License

By contributing, you agree that your contribution is licensed under this
repository's [license](LICENSE).
