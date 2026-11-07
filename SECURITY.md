# Security policy

## Reporting a vulnerability

Please don't open a public issue, discussion or pull request for a security
problem. Report it privately through GitHub instead:

1. Open the [Security tab](https://github.com/stratuslabs/agent/security) of
   this repository.
2. Choose **Report a vulnerability** and fill in the form, or go straight to
   [the form](https://github.com/stratuslabs/agent/security/advisories/new).

Only you and the maintainers can see the report. Include what you can of:

- the version (`stratus --version`) and how you installed it (npm, Docker,
  a system unit, or a source checkout)
- your OS and Node version
- the steps that reproduce it, or a proof of concept
- what an attacker gains, and what they need first: a message in a channel
  the agent listens to, a web page the agent reads, a repository it clones,
  local access to the machine

Leave real secrets out. If a log or transcript shows the problem, cut it
down to the lines that matter and replace any tokens or keys in it.

## What to expect

We reply in the private advisory, keep you posted there while we
investigate, and tell you when a fix is ready. Once a fixed release is out,
we publish the advisory, credit you if you want to be credited, and request
a CVE when one fits.

## Supported versions

Stratus Agent is pre-1.0. Security fixes land on `main` and ship in the next
release. They are not backported to older versions, so the supported version
is the latest release of `@stratusagent/cli` on npm, along with the
`@stratusagent/*` packages released with it.

This policy covers the code in this repository and the packages published
from it. If you aren't sure where a problem belongs, report it here anyway.

## What counts

Anything that gets past a boundary Stratus says it keeps. For example:

- a shell command escaping its sandbox, or reading what the sandbox hides
- a tool call that should be asked about or refused running without asking
- an agent reading another agent's memory, workspace or credentials
- a secret reaching a log, an API response, a model request or another agent
- someone outside `principals` getting a turn, or a cloned repository's
  config changing what only the trusted config may decide

[Security](docs/concepts/security.md) describes those boundaries, and also
the limits it already documents, such as the shell sandbox leaving the
network on. A documented limit isn't a vulnerability, but a way around one
of the protections listed above is.
