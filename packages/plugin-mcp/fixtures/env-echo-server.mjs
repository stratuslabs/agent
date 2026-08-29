// A real stdio MCP server for the environment-scrubbing test: it is spawned
// as a subprocess and reports what its environment actually contains. Kept
// to one tool so the test reads as the claim it checks — a bridged stdio
// server cannot see the daemon's secrets.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'env-echo', version: '1.0.0' });

server.registerTool('read_env', { description: 'Report selected environment variables.' }, async () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
        daemonSecret: process.env.STRATUS_TEST_DAEMON_SECRET ?? null,
        granted: process.env.STRATUS_TEST_GRANTED ?? null,
        path: process.env.PATH ?? null,
      }),
    },
  ],
}));

await server.connect(new StdioServerTransport());
