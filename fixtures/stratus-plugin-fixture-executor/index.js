import { writeFile } from 'node:fs/promises';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';

// An executor registered through `context.executors`: the local
// child-process executor, with every result stamped so a run can prove
// which executor its tool calls went through. A real isolation executor
// would run the command somewhere else; the seam is the same. With a
// `disposeMarker` path in its config it writes that file on dispose, so a
// test can prove a host released the plugin on a path that never ran.
export const createPlugin = (config = {}) => ({
  name: 'fixture-executor',
  async dispose() {
    if (typeof config.disposeMarker === 'string') {
      await writeFile(config.disposeMarker, 'disposed\n');
    }
  },
  setup(context) {
    if (!context.executors) {
      throw new Error('This host hands plugins no executor handle, so stratus-plugin-fixture-executor cannot register one.');
    }
    const local = createLocalCommandExecutor();
    context.executors.register({
      name: 'fixture',
      executor: {
        async execute(call, tool, session, executionContext) {
          const result = await local.execute(call, tool, session, executionContext);
          return { ...result, output: { ranBy: 'fixture-executor', output: result.output } };
        },
      },
    });
  },
});
