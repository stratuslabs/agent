/*
 * One agent's live Slack app, as the adapter holds it once connected: its
 * config, Web API and Socket Mode clients, and who the bot is. In a module
 * of its own so the adapter's parts outside `index.ts` can name it. Nothing
 * here is public: `index.ts` imports it, and the package's one public entry
 * is unchanged.
 */
import type { SlackAgentConfig, SlackSocketLike, SlackWebLike } from './index.ts';

export interface AgentConnection {
  config: SlackAgentConfig;
  web: SlackWebLike;
  socket: SlackSocketLike;
  botUserId: string;
  teamId: string;
  /** Whether a refused loading status has been said for this app yet; see `ReplyRenderer.setStatus`. */
  statusWarned: { value: boolean };
}
