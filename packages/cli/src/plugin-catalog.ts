/**
 * Where plugins other people publish are listed. Printed by `stratus
 * plugins` and by setup's plugin menu, so the two cannot drift.
 */
export const PLUGIN_MARKETPLACE_URL = 'github.com/stratuslabs/plugins';

// ---- stratus plugins -------------------------------------------------------

/**
 * The first-party capability packages, for the one question a manifest
 * cannot answer: what exists that this machine has not installed.
 *
 * A discovery aid and nothing else. What a package *contributes* is always
 * read from its own manifest, so this list falling behind can cost a
 * suggestion and never a wrong answer about a plugin that is here.
 */
export const FIRST_PARTY_CAPABILITY_PACKAGES = [
  '@stratusagent/tool-fs',
  '@stratusagent/tool-shell',
  '@stratusagent/tool-web',
  '@stratusagent/tool-browser',
  '@stratusagent/plugin-mcp',
];

/**
 * The tool names the gateway registers before it loads any plugin. A plugin
 * that registers one of these is refused whole, so a manifest declaring one
 * is worth naming — advisory only, since whether it *registers* the name is
 * a question no manifest answers. A name going stale here costs a warning,
 * never a wrong answer about a plugin that loads.
 */
export const KERNEL_TOOL_NAMES = [
  'demo.echo',
  'memory.remember',
  'memory.recall',
  'memory.forget',
  'skill.read',
  'schedule.every',
  'schedule.at',
  'schedule.list',
  'schedule.cancel',
  'message.send',
  'agent.delegate',
];
