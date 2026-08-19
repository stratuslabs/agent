// Every call the page makes. Authentication is the session cookie the
// one-time-token exchange set, so nothing here attaches a credential — the
// browser does, and a 401 means the daemon restarted (sessions live in its
// memory) rather than that something went wrong here.

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const request = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) {
    return undefined;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'unknown',
      payload?.error?.message ?? `HTTP ${response.status}`,
    );
  }
  return payload;
};

export const api = {
  health: () => request('GET', '/health'),
  agents: () => request('GET', '/agents'),
  agent: (id) => request('GET', `/agents/${encodeURIComponent(id)}`),
  createAgent: (body) => request('POST', '/agents', body),
  updateAgent: (id, body) => request('PUT', `/agents/${encodeURIComponent(id)}`, body),
  reloadRoster: () => request('POST', '/roster/reload'),
  sessions: (agent, limit) => {
    const query = new URLSearchParams();
    if (agent) query.set('agent', agent);
    if (limit) query.set('limit', String(limit));
    const suffix = query.toString();
    return request('GET', `/sessions${suffix ? `?${suffix}` : ''}`);
  },
  session: (id) => request('GET', `/sessions/${encodeURIComponent(id)}`),
  send: (id, body) => request('POST', `/sessions/${encodeURIComponent(id)}/messages`, body),
  approvals: () => request('GET', '/approvals'),
  resolveApproval: (body) => request('POST', '/approvals', body),
  models: () => request('GET', '/catalog/models'),
  credentials: () => request('GET', '/credentials'),
  verifyKey: (body) => request('POST', '/credentials/verify', body),
  storeKey: (provider, body) => request('PUT', `/credentials/${encodeURIComponent(provider)}`, body),
  storeChannel: (channel, body) => request('PUT', `/credentials/channels/${encodeURIComponent(channel)}`, body),
  config: () => request('GET', '/config'),
  saveConfig: (config) => request('PUT', '/config', { config }),
};

/**
 * The live event stream, reconnecting on its own.
 *
 * Frames are `{ sessionId, turnId?, event }` envelopes. The turn id is what
 * lets a chat view attribute deltas to the message it just sent rather than
 * to whatever else that session is doing.
 */
export const connectEvents = ({ onEnvelope, onStatus }) => {
  let socket;
  let closed = false;
  let backoffMs = 500;

  const open = () => {
    if (closed) {
      return;
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}${BASE}/events`);

    socket.addEventListener('open', () => {
      backoffMs = 500;
      onStatus?.('live');
    });
    socket.addEventListener('message', (message) => {
      let frame;
      try {
        frame = JSON.parse(message.data);
      } catch {
        return;
      }
      if (frame.event) {
        onEnvelope(frame);
      }
    });
    socket.addEventListener('close', () => {
      onStatus?.('offline');
      if (closed) {
        return;
      }
      // Backing off rather than hammering: the usual reason this closes is
      // that stratusd stopped, and a reconnect loop at full speed against a
      // dead port is just noise in someone's console.
      setTimeout(open, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 15_000);
    });
    socket.addEventListener('error', () => socket.close());
  };

  open();
  return {
    close() {
      closed = true;
      socket?.close();
    },
  };
};
