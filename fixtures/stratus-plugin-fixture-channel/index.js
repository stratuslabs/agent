// A channel registered through `context.channels`. It learns which agents
// it carries the only way a channel plugin can — from the transport secrets
// the host stores under `channels.fixture.<agentId>` — and on start it
// delivers one inbound message per agent through the gateway it was
// started with, then reports the outcome through the host's log, which is
// where a test watching `stratus serve` can read it.
export const createPlugin = () => ({
  name: 'fixture-channel',
  async setup(context) {
    if (!context.channels) {
      throw new Error('This host hands plugins no channel handle, so stratus-plugin-fixture-channel cannot register one.');
    }
    const secrets = await context.channels.transportSecrets('fixture');
    const agents = Object.keys(secrets);
    const log = context.log ?? (() => {});
    context.channels.register({
      agents,
      adapter: {
        name: 'fixture',
        async start(gateway) {
          for (const agentId of agents) {
            const session = await gateway.dispatch({
              sessionId: `fixture:${agentId}:1`,
              agentId,
              userMessage: `hello from the fixture channel (token ${secrets[agentId].token})`,
            });
            log(`fixture channel delivered a ${session.status} turn for ${agentId}`);
          }
        },
        async stop() {
          log('fixture channel stopped');
        },
      },
    });
  },
});
