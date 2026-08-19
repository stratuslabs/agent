import { ago, el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { avatar } from '../lib/avatar.js';
import { onEnvelope, refreshCore, store } from '../app.js';

/** A conversation started from this page, distinguishable from a Slack thread. */
const newSessionId = (agentId) => `web:${agentId}:${crypto.randomUUID()}`;

/**
 * Session ids are addresses, not names — a Slack thread key or a UUID. Show
 * enough to tell two apart without letting one eat the row it sits in.
 */
const shortId = (id) => (id.length <= 28 ? id : `${id.slice(0, 12)}…${id.slice(-8)}`);

const TOOL_OUTPUT_LIMIT = 260;

/**
 * A tool result, as a person would want to read it.
 *
 * The stored message is the raw result envelope — call id, tool name, ok
 * flag, output — because that is what the model consumed. Rendering it
 * verbatim puts a wall of JSON with an internal id in the middle of a
 * conversation, so this pulls out the part a reader is actually asking about
 * and leaves the rest to the transcript in the store.
 */
const summariseTool = (content) => {
  const text = String(content ?? '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}…` : text;
  }
  if (typeof parsed !== 'object' || parsed === null || !parsed.toolName) {
    return text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}…` : text;
  }
  const outcome = parsed.ok === false
    ? `failed — ${parsed.error ?? 'no reason given'}`
    : typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output);
  const body = String(outcome ?? '');
  return `${parsed.toolName} → ${body.length > TOOL_OUTPUT_LIMIT ? `${body.slice(0, TOOL_OUTPUT_LIMIT)}…` : body}`;
};

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
    /** Tool status lines for the turn in flight. */
    toolLines: [],
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
    error: undefined,
    saved: undefined,
    /**
     * The agent's full soul, fetched for editing.
     *
     * The roster carries `persona`: the first line of the instructions,
     * trimmed to fit a table row. Seeding the editor from it and saving
     * would write that snippet back as the whole persona, so the settings
     * tab waits for the real thing.
     */
    soul: undefined,
    soulError: undefined,
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

  const bubbles = () => {
    const nodes = [];
    for (const message of state.messages) {
      if (message.role === 'system') {
        continue;
      }
      if (message.role === 'tool') {
        nodes.push(el('div', { class: 'bubble tool' }, summariseTool(message.content)));
        continue;
      }
      if (!message.content) {
        // An assistant turn that only carried tool calls has no text to show;
        // the tool bubbles beside it are the story.
        continue;
      }
      nodes.push(el('div', { class: `bubble ${message.role}` }, message.content));
    }
    for (const line of state.toolLines) {
      nodes.push(el('div', { class: 'bubble tool' }, line));
    }
    if (state.streaming) {
      nodes.push(el('div', { class: 'bubble assistant streaming' }, state.streaming));
    }
    return nodes;
  };

  const paintTranscript = () => {
    // Pinned to the bottom only when the reader already was: yanking someone
    // back down while they are reading earlier output is worse than a reply
    // they have to scroll to.
    const pinned = transcriptBox.scrollHeight - transcriptBox.scrollTop - transcriptBox.clientHeight < 60;
    transcriptBox.replaceChildren(...bubbles());
    if (pinned) {
      transcriptBox.scrollTop = transcriptBox.scrollHeight;
    }
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
    paintTranscript();
    update();
  };

  /**
   * The full soul, read once and only when the settings tab needs it.
   *
   * Guarded rather than awaited from the render, because `update()` runs on
   * every event from every agent and an unguarded fetch there would open one
   * request per event.
   */
  let soulLoading = false;
  const loadSoul = async () => {
    if (soulLoading || state.soul) {
      return;
    }
    soulLoading = true;
    try {
      state.soul = await api.agent(agentId);
    } catch (error) {
      state.soulError = `Could not read this agent's soul file: ${error.message}`;
    } finally {
      soulLoading = false;
    }
    update();
  };

  const openSession = (sessionId) => {
    state.sessionId = sessionId;
    state.unsent = false;
    state.pending = [];
    state.turnId = undefined;
    state.sending = false;
    state.tab = 'chat';
    void loadTranscript();
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
    paintTranscript();
    update();

    try {
      const { turnId } = await api.send(sentTo, { message: text, agentId });
      state.awaitingSend.delete(sentTo);
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

  const applyEnvelope = (envelope) => {
    const event = envelope.event;

    // Anything that changes the stored conversation is worth re-reading even
    // when somebody else caused it — it is the same conversation. Only the
    // in-flight rendering below is ours alone.
    if (!isOurTurn(envelope)) {
      if (event.type === 'session.completed' || event.type === 'session.failed') {
        void loadTranscript();
        void loadSessions();
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
      case 'tool.called':
        state.toolLines = [...state.toolLines, `running ${event.call.toolName}…`];
        paintTranscript();
        break;
      case 'tool.completed':
        state.toolLines = [...state.toolLines, `${event.result.toolName} ${event.result.ok ? 'finished' : 'failed'}`];
        paintTranscript();
        break;
      case 'tool.denied':
        state.toolLines = [...state.toolLines, `${event.call.toolName} was denied`];
        paintTranscript();
        break;
      case 'tool.approval-requested':
        state.toolLines = [...state.toolLines, `${event.call.toolName} is waiting for approval`];
        paintTranscript();
        break;
      case 'session.failed':
        state.error = event.error;
        state.sending = false;
        state.turnId = undefined;
        void loadTranscript();
        break;
      case 'session.completed':
        state.sending = false;
        state.turnId = undefined;
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

  const activityTab = () => {
    const ours = new Set(state.sessions.map((session) => session.id));
    ours.add(state.sessionId);
    const lines = store.activity.filter((line) => ours.has(line.sessionId)).slice(0, 80);
    return lines.length === 0
      ? el('p', { class: 'empty' }, 'Nothing yet for this agent.')
      : el('div', { class: 'activity' }, ...lines.map((line) => el('div', { class: 'line' },
          el('span', { class: 'when' }, ago(new Date(line.at).toISOString())),
          el('span', { class: 'what', title: line.sessionId },
            line.agent ? `${line.agent} ${line.text}` : line.text),
        )));
  };

  /**
   * The settings form, built once and kept.
   *
   * `update()` runs on every event from every agent, and rebuilding these
   * inputs from the last server values would erase whatever someone had
   * typed the moment anything anywhere emitted an event. Text people are
   * editing is state, not a projection — so the nodes outlive the render
   * that created them, exactly as the composer does.
   */
  let settingsForm;

  const buildSettingsForm = (current, soul) => {
    const name = el('input', { value: soul.agent?.name ?? current.name });
    // The stored instructions in full, never the roster's one-line snippet.
    const instructions = el('textarea', { rows: 8, value: soul.agent?.instructions ?? '' });
    const provider = el('input', { value: soul.provider ?? '', placeholder: 'follows your setup' });
    const model = el('input', { value: soul.model ?? '', placeholder: 'follows your setup' });

    const save = async () => {
      state.saved = undefined;
      state.error = undefined;
      try {
        await api.updateAgent(agentId, {
          name: name.value,
          instructions: instructions.value,
          // An empty string clears a pin; leaving it alone keeps it.
          provider: provider.value.trim(),
          model: model.value.trim(),
        });
        await refreshCore();
        state.saved = 'Saved. The next turn in every conversation uses it.';
      } catch (error) {
        state.error = error.message;
      }
      settingsForm?.refreshNotice();
    };

    // The one part that does change per render: whether the last save
    // succeeded. Kept as its own node so the fields above are never touched.
    const notice = el('div', {});
    const node = el('div', {},
      el('div', { class: 'form-grid' },
        el('div', {}, el('label', {}, 'Name'), name),
        el('div', {}, el('label', {}, 'Agent id'), el('input', { value: current.id, disabled: true })),
        el('div', {}, el('label', {}, 'Provider'), provider),
        el('div', {}, el('label', {}, 'Model'), model),
      ),
      el('p', { class: 'field-note' }, 'An id keys sessions, memory, and credentials, so it cannot be changed in place.'),
      el('label', {}, 'Persona'),
      instructions,
      el('p', { class: 'field-note' }, soul.soulPath ? `Soul file: ${soul.soulPath}` : ''),
      notice,
      el('div', { class: 'actions' }, el('button', { class: 'primary', onClick: () => void save() }, 'Save')),
    );

    return {
      node,
      refreshNotice() {
        notice.replaceChildren(
          ...(state.saved ? [el('div', { class: 'notice ok' }, state.saved)] : []),
          ...(state.error ? [el('div', { class: 'notice bad' }, state.error)] : []),
        );
      },
    };
  };

  const settingsTab = () => {
    const current = agent();
    if (!current) {
      return el('p', { class: 'empty' }, 'This agent is no longer on the roster.');
    }
    if (current.builtIn) {
      return el('p', { class: 'empty' }, 'The built-in agent has no soul file to edit. Create your own agent to customise one.');
    }
    if (state.soulError) {
      return el('p', { class: 'empty' }, state.soulError);
    }
    if (!state.soul) {
      void loadSoul();
      return el('p', { class: 'empty' }, 'Reading the soul file…');
    }
    settingsForm ??= buildSettingsForm(current, state.soul);
    settingsForm.refreshNotice();
    return settingsForm.node;
  };

  // ---- shell -------------------------------------------------------------

  const sessionPicker = () => {
    const picker = el('select', {
      onChange: (event) => openSession(event.target.value),
    }, ...state.sessions.map((session) => el('option', {
      value: session.id,
      selected: session.id === state.sessionId,
    }, `${session.status.replace('_', ' ')} · ${ago(session.updatedAt)} · ${shortId(session.id)}`)));

    if (!state.sessions.some((session) => session.id === state.sessionId)) {
      // A conversation this page just started is not in the store yet, so it
      // would otherwise be missing from the very picker that is selecting it.
      picker.prepend(el('option', { value: state.sessionId, selected: true }, 'new conversation'));
    }
    return picker;
  };

  const header = () => {
    const current = agent();
    return el('div', { class: 'card-head' },
      el('div', { class: 'row' },
        current ? avatar(current, 34) : null,
        el('div', { class: 'grow' },
          el('div', { class: 'title' }, current?.name ?? agentId),
          el('div', { class: 'sub' }, current
            // An absent `runsOn` means the daemon is serving a soul whose
            // file it can no longer read, so it cannot say what this runs on.
            // "demo" would be a guess, and a billing claim is not a good
            // place to guess.
            ? `${current.runsOn?.provider ?? 'unknown'}${current.runsOn?.model ? ` · ${current.runsOn.model}` : ''} · ${current.memories ?? 0} remembered`
            : agentId),
        ),
      ),
      el('div', { class: 'actions' },
        ...['chat', 'activity', 'settings'].map((tab) => el('button', {
          class: `small${state.tab === tab ? ' primary' : ''}`,
          onClick: () => { state.tab = tab; update(); },
        }, tab.charAt(0).toUpperCase() + tab.slice(1))),
      ),
    );
  };

  const update = () => {
    const body = state.tab === 'chat' ? chatTab()
      : state.tab === 'activity' ? activityTab()
        : settingsTab();

    node.replaceChildren(
      el('div', { class: 'column' },
        el('section', { class: 'card' },
          header(),
          state.tab === 'chat'
            ? el('div', {}, el('label', {}, 'Conversation'), sessionPicker())
            : null,
          body,
        ),
      ),
      el('div', { class: 'column' },
        el('section', { class: 'card' },
          el('div', { class: 'card-head' },
            el('h2', {}, 'Conversations'),
            el('button', { class: 'small', onClick: startSession }, 'New'),
          ),
          state.sessions.length === 0
            ? el('p', { class: 'empty' }, 'No stored conversations yet.')
            : el('div', { class: 'rows' }, ...state.sessions.slice(0, 12).map((session) => el('div', { class: 'row' },
                el('div', { class: 'grow' },
                  el('div', { class: 'title', title: session.id },
                    session.id === state.sessionId ? `▸ ${shortId(session.id)}` : shortId(session.id)),
                  el('div', { class: 'sub' }, ago(session.updatedAt))),
                el('span', { class: `pill ${session.status}` }, session.status.replace('_', ' ')),
                el('button', { class: 'small', onClick: () => openSession(session.id) }, 'Open'),
              ))),
        ),
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
    state.pending = [];
    state.streaming = '';
    state.toolLines = [];
    void loadSessions();
    update();
  };

  update();
  void loadSessions();

  return { node, update, openSession, reconcile, destroy: detach };
};
