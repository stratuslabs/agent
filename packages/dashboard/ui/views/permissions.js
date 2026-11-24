import { el, when } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { avatar } from '../lib/avatar.js';
import { icon } from '../lib/icons.js';
import { createLatest } from '../lib/latest.js';
import { store } from '../app.js';

/**
 * One row per standing grant, by kind, as the daemon stores them.
 *
 * Each says exactly what it covers, because the kinds differ a lot: a whole
 * tool covers every call to it, a shell command scope covers one base
 * command and its arguments (never a flag that writes or runs something
 * else), a browser site one origin, a message destination one conversation.
 * Commands declared in the config file are shown but can only be changed
 * there. Revoking is immediate: the next call asks again.
 */
const byDestination = (grants) => {
  const grouped = new Map();
  for (const grant of grants) {
    grouped.set(grant.destination, [...(grouped.get(grant.destination) ?? []), grant]);
  }
  return grouped;
};

const rowsFor = (agentId, listing) => [
  ...(listing.tools ?? []).map((grant) => ({
    kind: 'Whole tool', chip: grant.tool, detail: grant.package ? `from ${grant.package}` : 'built in',
    at: grant.grantedAt, stale: grant.stale, revoke: { tool: grant.tool },
  })),
  ...(listing.scopes ?? []).map((grant) => ({
    kind: 'Shell command', chip: grant.description, detail: 'that command and its arguments', revoke: { scope: grant.description },
  })),
  ...(listing.commands ?? []).map((grant) => ({
    kind: 'Shell command', chip: grant.command, detail: 'that command by name', at: grant.grantedAt, revoke: { scope: grant.command },
  })),
  ...(listing.origins ?? []).map((grant) => ({
    kind: 'Browser site', chip: grant.origin, detail: grant.tool ? `with ${grant.tool}` : grant.description, revoke: { origin: grant.origin },
  })),
  // One row per destination, not per tool: revoking is by destination and
  // takes every tool's grant for it, so a row per tool would promise to take
  // back one and silently take its siblings too.
  ...[...byDestination(listing.destinations ?? []).values()].map((grants) => ({
    kind: 'Message destination',
    chip: grants.map((grant) => grant.tool).join(', '),
    detail: grants[0].description,
    at: grants.map((grant) => grant.grantedAt).filter(Boolean).sort().at(-1),
    stale: grants.find((grant) => grant.stale)?.stale,
    revoke: { destination: grants[0].destination },
  })),
  ...(listing.configCommands ?? []).map((command) => ({
    kind: 'Shell command', chip: command, detail: 'set in config.json', config: true,
  })),
].map((row) => ({ ...row, agentId }));

const REFRESH_MS = 3000;

export const renderPermissions = () => {
  const state = { rows: undefined, errors: [], confirming: undefined, busy: undefined, loadedAt: 0, trailing: undefined };
  const reads = createLatest();
  const node = el('div', { class: 'page-scroll' });

  const load = async () => {
    // Latest-wins, so a reload after a revoke is never undone by the first read landing late.
    state.loadedAt = Date.now();
    const ticket = reads.begin();
    const results = await Promise.all(store.agents.map((agent) => api.grants(agent.id).then(
      (listing) => ({ rows: rowsFor(agent.id, listing) }),
      (error) => ({ error: `${agent.name}: ${error.message}` }),
    )));
    if (!reads.isCurrent(ticket)) {
      return;
    }
    state.rows = results.flatMap((result) => result.rows ?? []);
    state.errors = results.flatMap((result) => (result.error ? [result.error] : []));
    paint();
  };

  const revoke = async (row, key) => {
    state.busy = key;
    paint();
    let failed;
    try {
      await api.revokeGrant(row.agentId, row.revoke);
    } catch (error) {
      failed = `Could not revoke it: ${error.message}`;
    }
    state.busy = undefined;
    state.confirming = undefined;
    await load();
    // After the reload, which replaces the read errors: a failed revoke must
    // still say why the grant is still there.
    if (failed) {
      state.errors = [failed, ...state.errors];
      paint();
    }
  };

  const rowNode = (row, index) => {
    const agent = store.agents.find((candidate) => candidate.id === row.agentId);
    const key = `${row.agentId}:${index}`;
    return el('div', { class: 'list-row', style: `padding: 14px 0;${row.stale ? ' opacity: 0.8;' : ''}` },
      agent ? avatar(agent, 24) : null,
      el('div', { style: 'width: 110px; flex: none; font-weight: 500;' }, agent?.name ?? row.agentId),
      el('div', { class: 'text' },
        el('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' },
          el('span', { style: 'color: var(--text-2); font-size: 13px;' }, row.kind),
          el('span', { class: 'badge mono' }, row.chip),
          row.detail ? el('span', { style: 'color: var(--text-2); font-size: 13px;' }, row.detail) : null),
        row.stale ? el('div', { class: 'meta', style: 'color: var(--warn);' }, icon('triangle-alert', 13), el('span', {}, `No longer applies: ${row.stale}`)) : null),
      el('div', { style: 'width: 150px; flex: none; color: var(--text-2); font-size: 13px;' },
        row.config ? 'From config' : row.at ? `Granted ${when(row.at)}` : ''),
      el('div', { style: 'width: 150px; flex: none; display: flex; justify-content: flex-end; gap: 6px;' },
        row.config
          ? null
          : state.confirming === key
            ? [
                el('button', { class: 'btn small', onClick: () => { state.confirming = undefined; paint(); } }, 'Keep'),
                el('button', { class: 'btn small danger', disabled: state.busy === key, onClick: () => void revoke(row, key) }, state.busy === key ? 'Revoking…' : 'Revoke'),
              ]
            : el('button', { class: 'btn small danger-text', onClick: () => { state.confirming = key; paint(); } }, 'Revoke')));
  };

  const paint = () => {
    const rows = state.rows ?? [];
    node.replaceChildren(el('div', { class: 'page-body', style: 'max-width: 1040px;' },
      el('div', { class: 'page-head' }, el('div', {},
        el('h1', {}, 'Permissions'),
        el('div', { class: 'sub' }, 'What you’ve allowed with “Always allow.” Revoke a grant and the agent asks again next time.'))),
      ...state.errors.map((error) => el('div', { class: 'notice bad', role: 'alert' }, error)),
      state.rows === undefined
        ? el('p', { class: 'field-note' }, 'Loading…')
        : rows.length === 0
          ? el('div', { class: 'empty-state' },
              el('span', { class: 'icon-box' }, icon('shield-check', 18)),
              el('h3', {}, 'No permissions yet'),
              el('p', {}, 'When you choose “Always allow” on an approval, the grant shows up here so you can revoke it.'))
          : el('div', {},
              el('div', { class: 'list' }, ...rows.map(rowNode)),
              el('div', { class: 'notice', style: 'margin-top: 20px; background: var(--bg); color: var(--text-2); display: flex; gap: 8px; align-items: center;' },
                icon('shield-check', 14),
                'Grants never widen on their own. Each row covers only what it says.'),
              // The API lists grants per agent id and has no list of grant
              // owners, so an agent removed from the roster is not asked about.
              el('p', { class: 'field-note' }, 'Grants kept for agents no longer on the roster aren’t listed here.')),
    ));
  };

  paint();
  void load();

  return {
    node,
    // A grant made or revoked anywhere else (Slack, another tab, the CLI)
    // arrives as an event the shell repaints on; re-read then, at most
    // every few seconds, and once more at the end of the window so the
    // last event of a burst is never the one dropped.
    update: () => {
      if (state.confirming !== undefined || state.busy !== undefined) {
        return;
      }
      const wait = REFRESH_MS - (Date.now() - state.loadedAt);
      if (wait <= 0) {
        void load();
      } else if (state.trailing === undefined) {
        state.trailing = setTimeout(() => {
          state.trailing = undefined;
          void load();
        }, wait);
      }
    },
    destroy: () => clearTimeout(state.trailing),
  };
};
