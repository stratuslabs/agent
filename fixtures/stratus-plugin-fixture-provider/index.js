// A provider registered through `context.providers`, built once per
// selection. Two modes, chosen by config: `echo` answers with a line naming
// the model it was built for, which is what a run-through-the-seam test
// reads; `memory` remembers a fact, recalls it, and answers with what came
// back, which is what a memory-store test needs from a provider — the
// built-in demo provider calls only demo.echo.
export const createPlugin = (config) => ({
  name: 'fixture-provider',
  setup(context) {
    if (!context.providers) {
      throw new Error('This host hands plugins no provider handle, so stratus-plugin-fixture-provider cannot register one.');
    }
    context.providers.register({
      name: 'fixture',
      streams: false,
      create(selection) {
        const model = selection.model ?? 'its default model';
        const reply = config.reply ?? 'served by the fixture provider';
        return {
          name: 'fixture',
          async generate({ session }) {
            if (config.mode !== 'memory') {
              return { parts: [{ type: 'text', text: `${reply} (model: ${model})` }] };
            }
            const last = session.messages.at(-1);
            if (last?.role !== 'tool') {
              const fact = `${session.agent.id} likes ${model}`;
              return { parts: [{ type: 'tool-call', call: { id: `${session.id}:remember`, toolName: 'memory.remember', input: { fact } } }] };
            }
            if (last.toolResult?.toolName === 'memory.remember') {
              return { parts: [{ type: 'tool-call', call: { id: `${session.id}:recall`, toolName: 'memory.recall', input: { query: 'likes' } } }] };
            }
            return { parts: [{ type: 'text', text: `${reply}; recalled ${JSON.stringify(last.toolResult?.output ?? null)}` }] };
          },
        };
      },
    });
  },
});
