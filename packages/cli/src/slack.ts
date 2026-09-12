// Slack verification talks to the Web API over plain fetch rather than
// through @stratusagent/channel-slack. Setup must stay usable before that
// optional package is installed, and the CLI deliberately does not depend
// on it (or on the ~9 MB of Slack SDKs underneath).
const SLACK_API_ROOT = 'https://slack.com/api';

interface SlackIdentity {
  botUserId?: string;
  teamName?: string;
  teamId?: string;
}

type SlackVerdict =
  | { status: 'ok'; identity: SlackIdentity }
  | { status: 'rejected'; detail: string }
  | { status: 'unreachable'; detail: string };

const callSlack = async (
  method: string,
  token: string,
  fetchImpl: typeof fetch | undefined,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; verdict: SlackVerdict }> => {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, verdict: { status: 'unreachable', detail: 'fetch is unavailable' } };
  }
  try {
    const response = await fetchImpl(`${SLACK_API_ROOT}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    if (!response.ok) {
      return { ok: false, verdict: { status: 'unreachable', detail: `HTTP ${response.status}` } };
    }
    const body = await response.json() as Record<string, unknown>;
    if (body.ok === true) {
      return { ok: true, body };
    }
    // Slack answers 200 with { ok: false, error } for bad credentials, so
    // the error string — not the status — is what condemns a token.
    return { ok: false, verdict: { status: 'rejected', detail: String(body.error ?? 'unknown error') } };
  } catch (error) {
    return { ok: false, verdict: { status: 'unreachable', detail: error instanceof Error ? error.message : String(error) } };
  }
};

/** Verifies a bot token and reports the identity it belongs to. */
export const verifySlackBotToken = async (token: string, fetchImpl: typeof fetch | undefined): Promise<SlackVerdict> => {
  const result = await callSlack('auth.test', token, fetchImpl);
  if (!result.ok) {
    return result.verdict;
  }
  return {
    status: 'ok',
    identity: {
      ...(typeof result.body.user_id === 'string' ? { botUserId: result.body.user_id } : {}),
      ...(typeof result.body.team === 'string' ? { teamName: result.body.team } : {}),
      ...(typeof result.body.team_id === 'string' ? { teamId: result.body.team_id } : {}),
    },
  };
};

/**
 * Verifies an app-level token by opening a Socket Mode URL. The URL is
 * discarded — this only proves the token carries connections:write, which
 * is the failure the daemon would otherwise hit at start time.
 */
export const verifySlackAppToken = async (token: string, fetchImpl: typeof fetch | undefined): Promise<SlackVerdict> => {
  const result = await callSlack('apps.connections.open', token, fetchImpl);
  return result.ok ? { status: 'ok', identity: {} } : result.verdict;
};

// Scopes and events the adapter needs. Kept in step with the manifest
// shipped by @stratusagent/channel-slack (a test pins them together) so
// setup can hand over a ready-to-paste manifest without depending on that
// package being installed.
const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  // The history family is what lets an agent stay in a conversation it was
  // brought into: without it Slack delivers only mentions, and a reply in
  // the agent's own thread never reaches it. It is the workspace's switch
  // for that — an app installed without these scopes answers mentions and
  // nothing else, exactly as it always did.
  'channels:history',
  // The conversations read family backs outbound destination validation
  // (conversations.info): whether a channel a schedule wants to report to
  // exists, and whether this app is a member of it.
  'channels:read',
  'chat:write',
  // What lets an agent be shown a screenshot: file bytes sit behind an
  // authenticated URL that answers a token without this scope with a
  // sign-in page. An app installed without it still hears about the
  // attachment, by name, and is told it cannot open it.
  'files:read',
  'files:write',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'users:read',
];

const SLACK_BOT_EVENTS = ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim'];

export const slackAppManifest = (agentName: string): string => JSON.stringify({
  display_information: {
    name: agentName,
    description: 'A Stratus agent',
    background_color: '#1a1d21',
  },
  features: {
    bot_user: { display_name: agentName, always_online: true },
  },
  oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
  settings: {
    event_subscriptions: { bot_events: SLACK_BOT_EVENTS },
    // Required for remote approval: Allow / Always allow / Deny arrive as
    // block_actions, and Slack delivers none of them to an app that has
    // interactivity switched off. Enabled unconditionally rather than per
    // mode — an app is created once, and discovering months later that the
    // buttons do nothing means editing the manifest and reinstalling.
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
}, null, 2);
