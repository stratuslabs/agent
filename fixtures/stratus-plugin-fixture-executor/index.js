import { createLocalCommandExecutor } from '@stratusagent/executor-local';

// An executor registered through `context.executors`: the local
// child-process executor, with every result stamped so a run can prove
// which executor its tool calls went through. A real isolation executor
// would run the command somewhere else; the seam is the same.
export const createPlugin = () => ({
  name: 'fixture-executor',
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
