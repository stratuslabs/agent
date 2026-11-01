# @stratusagent/executor-local

Concrete local-process executor for Stratus Agent.

This package sits on top of the core executor contract and runs compatible tools through real local child processes instead of only direct in-memory function calls.

## Included

- `defineLocalCommandTool(...)` for tools that resolve to a local command invocation
- `createLocalCommandExecutor(...)` for running those tools through `child_process.spawn`
- structured stdout, stderr, exit code, timeout, and duration capture
- a per-stream output cap — 10 MB unless the executor (`maxOutputBytes` option) or the invocation (`maxOutputBytes`) says otherwise — enforced as the output is read, with `stdoutTruncated` / `stderrTruncated` on the execution when the command wrote more
- `redact` on the invocation: values (a secret the tool put in `env`) replaced by `[redacted]` in stdout and stderr before any result is built, failed, timed-out and aborted ones included. A stream cut at its cap that ends inside one of them loses that piece too. Exact copies only: output that encodes or splits a value shows what it printed
- `annotateFailure(execution, context)`, asked when a command exits non-zero, for fields the tool adds to the failed result beside the execution record (a key the record already has keeps the record's value; a hook that throws, returns anything but an object, or takes more than 2 s adds nothing)
- fallback to direct execution for normal in-memory tools

## Example

```ts
import { createLocalCommandExecutor, defineLocalCommandTool } from '@stratusagent/executor-local';

const echoTool = defineLocalCommandTool({
  name: 'demo.echo',
  createCommand(input) {
    return {
      command: process.execPath,
      args: ['-e', `console.log(JSON.stringify(${JSON.stringify({ text: 'hello' })}))`],
    };
  },
  parseResult(result) {
    return JSON.parse(result.stdout);
  },
});

const executor = createLocalCommandExecutor();
```
