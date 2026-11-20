import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { endsSettled, settledLines, shadowLineIndex } from '../lib/decisions.js';
import { transcriptItems } from '../lib/transcript.js';
import { onEnvelope, store } from '../app.js';
import { activityPanel, agentHeader, conversationList, sessionPicker } from './agent-panels.js';
import { createSettingsTab } from './agent-settings.js';
import { paintTranscript as paintItems } from './agent-transcript.js';

/** A conversation started from this page, distinguishable from a Slack thread. */
const newSessionId = (agentId) => `web:${agentId}:${crypto.randomUUID()}`;

export const renderAgent = (agentId, initialSessionId) => {
  const state = {
    tab: 'chat',
    sessions: [],
    sessionId: initialSessionId,
    /**
     * True while this conversation exists only in the page.
     *
     * A session id minted here has nothing stored behind it until the first
     * message lands, so asking the daemon for it would 404 — correctly, and
     * confusingly: a red line in the console for the ordinary act of opening
     * a new conversation.
     */
    unsent: initialSessionId === undefined,
    /** Canonical history, re-read from the daemon whenever a turn settles. */
    messages: [],
    /** The reply currently arriving, token by token. */
    streaming: '',
    /**
     * Tool status lines for the turn in flight: `{ text, callId, toolName,
     * decides, decision, shadow }`. `decides` marks the line a permission
     * decision belongs beside (the call starting, or its refusal).
     */
    toolLines: [],
    /**
     * The lines of this page's last finished turn, `{ sessionId, turnId,
     * lines }`, kept once the stored transcript replaces them: their
     * decisions show beside the stored results (`settledLines`), and a
     * shadow decision that lands after the turn ended still finds its call.
     * Live only, like every decision here: gone on the next message, from
     * this page or from anywhere else, on a reconnect, or on another
     * conversation, and a conversation opened later shows none.
     */
    settled: undefined,
    /**
     * Decisions (`permission.decided`) that arrived before the line they
     * belong to, by call id. A decision is copied onto its line when the
     * line is made rather than looked up at paint time, because an endpoint
     * that numbers its calls per response reuses ids within one turn.
     */
    decisions: new Map(),
    /**
     * Shadow decisions (the review posture's, worked out off the call
     * path) waiting for their line, by call id and tool (`shadowKey`),
     * oldest first. Kept apart from `decisions`: a call has its real
     * decision and may have a shadow one too, and the shadow one often
     * arrives first.
     */
    shadows: new Map(),
    turnId: undefined,
    /**
     * Envelopes that arrived before the POST said which turn is ours.
     *
     * The dispatch starts before the response is read, so its first events
     * can beat the turn id here. Dropping them would lose the opening tokens
     * of every reply; accepting them blind would mix in another client's
     * turn on the same conversation. So they wait, and are replayed once the
     * id lands.
     */
    pending: [],
    sending: false,
    /**
     * Conversations whose POST is unanswered, by session id.
     *
     * Distinct from `sending`, which stays true for the whole turn: this is
     * the window in which the store cannot answer for the turn at all — a new
     * conversation has nothing stored, and an existing one still carries the
     * *previous* turn's terminal status until the dispatch saves. Anything
     * that reconciles against the store during it would be reading about a
     * turn that has not started.
     *
     * Keyed rather than a flag, because sends overlap across conversations: a
     * message to A, then a switch to B and a message there, leaves two in
     * flight — and A's response clearing a shared flag would tell this view
     * that B has nothing pending, which is exactly when clearing B's turn
     * does damage.
     */
    awaitingSend: new Set(),
    /**
     * Conversations that owe a reconciliation once their POST settles.
     *
     * `reconcile` cannot decide anything while a send is outstanding — the
     * store still reads as the previous turn — so it returns. But nothing
     * replays what the stream missed, and no second reconnect is coming, so
     * a turn that finished during the outage would leave the composer on
     * "Working…" for good. The debt is recorded here and paid the moment the
     * response lands, which is the earliest point anything can decide.
     */
    reconcileAfterSend: new Set(),
    /**
     * The turn this page started on each conversation, by session id.
     *
     * `turnId` above is only the selected conversation's. Switching away and
     * back used to clear it, which enabled the composer on a turn that was
     * still running and made the rest of that turn's envelopes fail
     * `isOurTurn` — so its reply rendered nowhere and its completion cleared
     * nothing. An entry lives from the POST that minted it until that turn
     * ends, or until the store says it already has.
     */
    turns: new Map(),
    error: undefined,
  };

  const node = el('div', { class: 'main' });
  const transcriptBox = el('div', { class: 'transcript' });
  const composer = el('textarea', {
    placeholder: 'Message this agent…',
    rows: 2,
    onKeyDown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    },
  });

  const agent = () => store.agents.find((candidate) => candidate.id === agentId);

  // ---- transcript --------------------------------------------------------

  const paintTranscript = () => {
    const settled = state.settled !== undefined && state.settled.sessionId === state.sessionId
      ? settledLines(state.messages, state.settled.lines)
      : new Map();
    paintItems(transcriptBox, transcriptItems({
      messages: state.messages,
      toolLines: state.toolLines,
      streaming: state.streaming,
      settled,
    }));
  };

  // ---- data --------------------------------------------------------------

  const loadSessions = async () => {
    const listed = await api.sessions(agentId, 50).catch(() => ({ sessions: [] }));
    state.sessions = listed.sessions ?? [];
    if (!state.sessionId) {
      const newest = state.sessions[0]?.id;
      state.sessionId = newest ?? newSessionId(agentId);
      state.unsent = newest === undefined;
    }
    await loadTranscript();
  };

  const loadTranscript = async () => {
    if (!state.sessionId) {
      return;
    }
    if (state.unsent) {
      // Nothing to fetch: this conversation has never been sent anywhere.
      state.messages = [];
      state.streaming = '';
      state.toolLines = [];
      state.decisions = new Map();
      state.shadows = new Map();
      paintTranscript();
      update();
      return;
    }
    // Which conversation this fetch is for. Opening B while A is still in
    // flight would otherwise land A's history under B's selector, and the
    // next message typed would go to B while showing A — so a response that
    // arrives after the selection moved on is dropped.
    const requested = state.sessionId;
    let messages;
    try {
      const { session } = await api.session(requested);
      messages = session.messages ?? [];
    } catch {
      // Raced with a turn that has not saved yet, or a session removed out
      // from under the page. An empty transcript is the honest render.
      messages = [];
    }
    if (state.sessionId !== requested) {
      return;
    }
    state.messages = messages;
    state.streaming = '';
    state.toolLines = [];
    state.decisions = new Map();
    state.shadows = new Map();
    paintTranscript();
    update();
  };

  const openSession = (sessionId) => {
    state.sessionId = sessionId;
    state.unsent = false;
    state.pending = [];
    // Restored, not cleared: this page may still be waiting on a turn here.
    state.turnId = state.turns.get(sessionId);
    state.settled = undefined;
    state.sending = state.turnId !== undefined || state.awaitingSend.has(sessionId);
    state.tab = 'chat';
    void loadTranscript();
    if (state.sending) {
      // It may equally have finished while we were looking elsewhere — the
      // completion only reaches `applyEnvelope` for the selected
      // conversation. The store is what settles that, and `reconcile` already
      // knows how to ask it without disturbing a turn that is genuinely live.
      void reconcile();
    }
  };

  const startSession = () => {
    state.sessionId = newSessionId(agentId);
    state.unsent = true;
    state.pending = [];
    state.turnId = undefined;
    state.sending = false;
    state.messages = [];
    state.streaming = '';
    state.toolLines = [];
    state.decisions = new Map();
    state.shadows = new Map();
    state.settled = undefined;
    paintTranscript();
    update();
  };

  const send = async () => {
    const text = composer.value.trim();
    // No session id yet means the first `/sessions` listing has not come back,
    // so we do not know whether to resume the newest conversation or mint a
    // new one. Sending anyway posted to `/sessions/undefined/messages`, which
    // the daemon accepts — creating a durable conversation literally named
    // `undefined` — and whose response the arriving listing then discards.
    // The button is disabled for this window; Enter reaches here regardless.
    if (!text || state.sending || !state.sessionId) {
      return;
    }
    state.sending = true;
    state.error = undefined;
    composer.value = '';
    // Which conversation this message is for. Opening or starting another one
    // while the POST is in flight would otherwise stamp this turn's id onto
    // that conversation — so its own next message would drain its opening
    // events against a turn it never sent, and a brand-new conversation would
    // be marked as stored when nothing had been written for it.
    const sentTo = state.sessionId;
    state.awaitingSend.add(sentTo);
    // Shown immediately rather than waiting for the round trip: the daemon
    // will persist exactly this, and a message that vanishes for a second
    // reads as a dropped one.
    const optimistic = { id: `local:${crypto.randomUUID()}`, role: 'user', content: text };
    state.messages = [...state.messages, optimistic];
    state.streaming = '';
    state.toolLines = [];
    state.decisions = new Map();
    state.shadows = new Map();
    state.settled = undefined;
    paintTranscript();
    update();

    try {
      const { turnId } = await api.send(sentTo, { message: text, agentId });
      state.awaitingSend.delete(sentTo);
      // Recorded before the selection check, so a turn started here is
      // recoverable even when the user walked away before it was answered.
      state.turns.set(sentTo, turnId);
      if (state.sessionId !== sentTo) {
        // The view moved on, and `openSession`/`startSession` already reset
        // the in-flight state it would have reconciled.
        state.reconcileAfterSend.delete(sentTo);
        return;
      }
      // It exists in the store now, so later reads are real reads.
      state.unsent = false;
      // Kept so deltas can be attributed to *this* message: a session runs
      // its turns in sequence, and without the id there is no telling our
      // reply from the next one.
      state.turnId = turnId;
      const queued = state.pending;
      state.pending = [];
      for (const envelope of queued) {
        applyEnvelope(envelope);
      }
      if (state.reconcileAfterSend.delete(sentTo)) {
        // The stream came back while this POST was in flight. Now there is a
        // turn id and a stored session, so the store can finally say whether
        // the turn we are waiting on already ended during the outage.
        await reconcile();
      }
    } catch (error) {
      state.awaitingSend.delete(sentTo);
      // Nothing ran, so there is nothing to reconcile against.
      state.reconcileAfterSend.delete(sentTo);
      if (state.sessionId !== sentTo) {
        return;
      }
      // Nothing was stored, so nothing should look stored. Left in place, the
      // bubble reads as a sent message forever, and the next message that
      // does succeed renders after a turn that never existed. The text goes
      // back in the composer rather than being lost with it.
      state.messages = state.messages.filter((message) => message !== optimistic);
      if (!composer.value) {
        composer.value = text;
      }
      state.error = error.message;
      state.sending = false;
      paintTranscript();
      update();
    }
  };

  // ---- live --------------------------------------------------------------

  /**
   * Whether this envelope belongs to the turn this page started.
   *
   * A conversation is shared: another browser, a Slack thread, or the CLI can
   * be mid-turn on the same session. Without this check their completion
   * clears our composer and reloads the transcript while our message is still
   * queued, and their tokens land in the reply we are rendering.
   */
  const isOurTurn = (envelope) => envelope.turnId !== undefined && envelope.turnId === state.turnId;

  const shadowKey = (callId, toolName) => `${callId}\u0000${toolName}`;

  /** One tool status line, with the decision that arrived ahead of it when it is the line one belongs beside. */
  const addToolLine = (text, callId, toolName, decides) => {
    const decision = decides ? state.decisions.get(callId) : undefined;
    if (decision !== undefined) {
      state.decisions.delete(callId);
    }
    const key = shadowKey(callId, toolName);
    const waiting = decides ? state.shadows.get(key) : undefined;
    const shadow = waiting?.shift();
    if (waiting !== undefined && waiting.length === 0) {
      state.shadows.delete(key);
    }
    state.toolLines = [...state.toolLines, { text, callId, toolName, decides, ...(decision ? { decision } : {}), ...(shadow ? { shadow } : {}) }];
    paintTranscript();
  };

  /**
   * Keeps the lines of the turn that just ended (`state.settled`), so the
   * stored transcript that replaces them still shows their decisions.
   */
  const settleTurn = (envelope) => {
    state.settled = { sessionId: envelope.sessionId, turnId: envelope.turnId, lines: state.toolLines };
  };

  const decisionOf = (event) => ({
    allowed: event.allowed,
    layer: event.layer,
    reason: event.reason,
    verdict: event.verdict,
    reviewCode: event.reviewCode,
    shadow: event.shadow,
  });

  const applyEnvelope = (envelope) => {
    const event = envelope.event;

    // Anything that changes the stored conversation is worth re-reading even
    // when somebody else caused it — it is the same conversation. Only the
    // in-flight rendering below is ours alone. An overhear is always
    // somebody else's: it runs no turn, so it carries no turn id and this
    // event is the only one it emits — and a message in the transcript
    // that no completion follows is exactly the change this branch exists
    // to notice. The session list re-reads too, since its order follows
    // the row's own timestamp, which an overhear moves.
    // A shadow review can outlast its turn. The control API stamps its
    // decision with the turn its call ran in, which here is the one that
    // just ended, so it joins that turn's call.
    if (event.type === 'permission.decided' && event.shadow === true && state.settled !== undefined
      && envelope.turnId !== undefined && envelope.turnId === state.settled.turnId
      && envelope.sessionId === state.settled.sessionId) {
      const lines = state.settled.lines;
      const index = shadowLineIndex(lines, event.callId, event.toolName);
      if (index >= 0) {
        state.settled = { ...state.settled, lines: lines.map((line, at) => (at === index ? { ...line, shadow: decisionOf(event) } : line)) };
        paintTranscript();
      }
      return;
    }

    if (!isOurTurn(envelope)) {
      if (event.type === 'session.completed' || event.type === 'session.failed' || event.type === 'session.observed') {
        // Somebody else added to the conversation after this page's last
        // turn, so its lines no longer describe the end of the transcript:
        // matched from the end, they would land beside the newer turn's
        // results whenever that turn reused an id on the same tool.
        state.settled = undefined;
        void loadTranscript();
        void loadSessions();
      } else if (endsSettled(state.settled, envelope)) {
        // Another turn has started here, from another tab or channel. The
        // re-read this page's own completion started can land while it
        // runs, so its lines go now rather than at its end.
        state.settled = undefined;
        paintTranscript();
      }
      return;
    }

    switch (event.type) {
      case 'provider.delta':
        if (event.delta.type === 'text') {
          state.streaming += event.delta.text;
          paintTranscript();
        } else if (event.delta.type === 'reset') {
          // The provider abandoned this attempt — a fallback taking over, or
          // a retry. Everything streamed so far belongs to an answer that is
          // not coming, so it goes rather than being fused with the next one.
          state.streaming = '';
          paintTranscript();
        }
        break;
      case 'permission.decided': {
        const decision = decisionOf(event);
        if (event.shadow === true) {
          // Off the call path, so before or after its line (`shadowLineIndex`).
          const index = shadowLineIndex(state.toolLines, event.callId, event.toolName);
          if (index >= 0) {
            state.toolLines = state.toolLines.map((line, at) => (at === index ? { ...line, shadow: decision } : line));
            paintTranscript();
          } else {
            const key = shadowKey(event.callId, event.toolName);
            state.shadows.set(key, [...(state.shadows.get(key) ?? []), decision]);
          }
          break;
        }
        // Usually ahead of its call, so it waits for the line; one made
        // later joins the latest line for that call that has none yet.
        const index = state.toolLines.findLastIndex((line) => line.decides && line.callId === event.callId);
        if (index >= 0 && state.toolLines[index].decision === undefined) {
          state.toolLines = state.toolLines.map((line, at) => (at === index ? { ...line, decision } : line));
          paintTranscript();
        } else {
          state.decisions.set(event.callId, decision);
        }
        break;
      }
      case 'tool.called':
        addToolLine(`running ${event.call.toolName}…`, event.call.id, event.call.toolName, true);
        break;
      case 'tool.completed':
        addToolLine(`${event.result.toolName} ${event.result.ok ? 'finished' : 'failed'}`, event.result.callId, event.result.toolName, false);
        break;
      case 'tool.denied':
        addToolLine(`${event.call.toolName} was denied`, event.call.id, event.call.toolName, true);
        break;
      case 'tool.approval-requested':
        addToolLine(`${event.call.toolName} is waiting for approval`, event.call.id, event.call.toolName, false);
        break;
      case 'session.failed':
        settleTurn(envelope);
        state.error = event.error;
        state.sending = false;
        state.turnId = undefined;
        state.turns.delete(envelope.sessionId);
        void loadTranscript();
        break;
      case 'session.completed':
        settleTurn(envelope);
        state.sending = false;
        state.turnId = undefined;
        state.turns.delete(envelope.sessionId);
        // Re-read rather than keeping what was streamed: the stored
        // transcript is what every other surface will show, and a page that
        // quietly disagrees with it is worse than one that flickers.
        void loadTranscript();
        void loadSessions();
        break;
      default:
        break;
    }
  };

  const detach = onEnvelope((envelope) => {
    if (envelope.sessionId !== state.sessionId) {
      return;
    }
    if (state.sending && state.turnId === undefined) {
      // Our own dispatch is in flight and has not told us its id yet.
      state.pending.push(envelope);
      return;
    }
    applyEnvelope(envelope);
  });

  // ---- tabs --------------------------------------------------------------

  const chatTab = () => el('div', { class: 'chat' },
    transcriptBox,
    state.error ? el('div', { class: 'notice bad' }, state.error) : null,
    el('div', { class: 'composer' },
      composer,
      el('button', { class: 'primary', disabled: state.sending || !state.sessionId, onClick: () => void send() },
        state.sending ? 'Working…' : 'Send'),
    ),
  );

  const settingsTab = createSettingsTab({
    agentId,
    agent,
    update: () => update(),
    getError: () => state.error,
    setError: (message) => { state.error = message; },
  });

  const update = () => {
    const body = state.tab === 'chat' ? chatTab()
      : state.tab === 'activity' ? activityPanel({ activity: store.activity, sessions: state.sessions, sessionId: state.sessionId })
        : settingsTab();

    node.replaceChildren(
      el('div', { class: 'column' },
        el('section', { class: 'card' },
          agentHeader({ current: agent(), agentId, tab: state.tab, onTab: (tab) => { state.tab = tab; update(); } }),
          state.tab === 'chat'
            ? el('div', {}, el('label', {}, 'Conversation'), sessionPicker({ sessions: state.sessions, sessionId: state.sessionId, onOpen: openSession }))
            : null,
          body,
        ),
      ),
      el('div', { class: 'column' },
        conversationList({ sessions: state.sessions, sessionId: state.sessionId, onOpen: openSession, onNew: startSession }),
      ),
    );
    paintTranscript();
  };

  /**
   * Re-read after the event stream was down.
   *
   * Nothing replays what was missed, so a turn that finished during the
   * outage leaves this view waiting on a completion that already happened —
   * the composer disabled on "Working…" forever.
   *
   * The store decides, not the reconnect: a socket can also come back while
   * the turn is genuinely still running, and clearing then would re-enable
   * the composer mid-turn and make that turn's remaining events look like
   * somebody else's. So the in-flight state is dropped only once the stored
   * session says it has ended.
   */
  const reconcile = async () => {
    if (state.sessionId && state.awaitingSend.has(state.sessionId)) {
      // Our own POST is about to say how this turn went — including its id,
      // which lands *after* this would have cleared `sending`, re-enabling
      // the composer on a turn that had only just started. The store cannot
      // help here: a new conversation has nothing in it yet, and an existing
      // one still reads as the previous turn. So the reconciliation is owed
      // rather than skipped: the terminal event is not replayed, and this may
      // be the only reconnect there is.
      state.reconcileAfterSend.add(state.sessionId);
      void loadSessions();
      return;
    }
    // Past that, `unsent` can no longer hide a live turn: a conversation with
    // one has either an outstanding POST, caught above, or a response that
    // already marked it stored.
    if (state.sending && state.sessionId && !state.unsent) {
      const stored = await api.session(state.sessionId).then((read) => read.session).catch(() => undefined);
      // Unreadable, or still going: leave the turn alone. A session saved a
      // moment behind the turn it is running reads as `running` here, and
      // the next event or check-in settles it.
      if (!stored || stored.status === 'running' || stored.status === 'pending_approval') {
        void loadSessions();
        return;
      }
    }
    state.sending = false;
    state.turnId = undefined;
    if (state.sessionId) {
      state.turns.delete(state.sessionId);
    }
    state.pending = [];
    state.streaming = '';
    state.toolLines = [];
    state.decisions = new Map();
    state.shadows = new Map();
    // Events were missed while the socket was down, possibly another turn's
    // completion, so the last turn's lines may no longer end the transcript.
    state.settled = undefined;
    void loadSessions();
    update();
  };

  update();
  void loadSessions();

  return { node, update, openSession, reconcile, destroy: detach };
};
