/*
 * One agent as the gateway holds it: its definition, the soul file behind
 * it and the parsed soul. Moved out of index.ts as is so the modules split
 * out of `createGateway` can name it; index.ts does not re-export it.
 */

import type { ParsedSoul } from '@stratusagent/agents';
import type { AgentDefinition } from '@stratusagent/core';

export interface AgentSource {
  definition: AgentDefinition;
  /** Soul file backing this agent; undefined for the built-in default. */
  soulPath?: string;
  /** The parsed soul, carried for its provider/model pins. */
  soul?: ParsedSoul;
}
