import { InMemoryAgentMemoryStore } from '@stratusagent/core';

// A memory store registered through `context.memory`: the kernel's own
// in-memory implementation of the contract, which is the point — a store
// that is not the file-plus-FTS5 one, keyed per agent by the contract's own
// rule, and holding nothing on disk. One instance per process, so two runs
// in one process share it and a second agent's recall proves the keying.
export const createPlugin = () => ({
  name: 'fixture-memory',
  setup(context) {
    if (!context.memory) {
      throw new Error('This host hands plugins no memory handle, so stratus-plugin-fixture-memory cannot register one.');
    }
    context.memory.register({ name: 'fixture', store: new InMemoryAgentMemoryStore() });
  },
});
