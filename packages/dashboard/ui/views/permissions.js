import { el, when } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { avatar } from '../lib/avatar.js';
import { icon } from '../lib/icons.js';
import { createLatest } from '../lib/latest.js';
import { ownersUnknown } from '../lib/grants.js';
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
/** Grants grouped by what revoking takes: the API revokes by destination or origin, every tool's grant at once. */
const groupBy = (grants, key) => {
  const grouped = new Map();
  for (const grant of grants) {
    grouped.set(grant[key], [...(grouped.get(grant[key]) ?? []), grant]);
  }
  return grouped;
};

const rowsFor = (agentId, listing) => [
  ...(listing.tools ?? []).map((grant) => ({
    kind: 'Whole tool', chip: grant.tool, detail: grant.package ? `from ${grant.package}` : 'built in',
    at: grant.grantedAt, stale: grant.stale, revoke: { tool: grant.tool },
  })),
  // A command scope and a command-name grant with the same text are one
  // revocation target (`forgetScope` takes both), so they are one row.
  ...[...groupBy([
    ...(listing.scopes ?? []).map((grant) => ({ text: grant.description, byName: false })),
    ...(listing.commands ?? []).map((grant) => ({ text: grant.command, byName: true, grantedAt: grant.grantedAt })),
  ], 'text').values()].map((grants) => ({
    kind: 'Shell command',
    chip: grants[0].text,
    detail: grants.every((grant) => grant.byName) ? 'that command by name'
      : grants.some((grant) => grant.byName) ? 'that command, by name and with its arguments'
        : 'that command and its arguments',
    at: grants.map((grant) => grant.grantedAt).filter(Boolean).sort().at(-1),
    revoke: { scope: grants[0].text },
  })),
  // One row per origin for the same reason as destinations below.
  ...[...groupBy(listing.origins ?? [], 'origin').values()].map((grants) => ({
    kind: 'Site',
    chip: grants[0].origin,
    detail: grants.some((grant) => grant.tool === undefined)
      ? grants[0].description
      : `with ${grants.map((grant) => grant.tool).join(', ')}`,
    revoke: { origin: grants[0].origin },
  })),
  // One row per destination, not per tool: revoking is by destination and
  // takes every tool's grant for it, so a row per tool would promise to take
  // back one and silently take its siblings too.
  ...[...groupBy(listing.destinations ?? [], 'destination').values()].map((grants) => ({
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
  const state = { rows: undefined, errors: [], confirming: undefined, busy: undefined, loadedAt: 0, trailing: undefined, ownersListed: true };
  const reads = createLatest();
  const node = el('div', { class: 'page-scroll' });

  const load = async () => {
    // Latest-wins, so a reload after a revoke is never undone by the first read landing late.
    state.loadedAt = Date.now();
    const ticket = reads.begin();
    // Everyone with a grant file, so grants that outlived their agent are
    // found too. A daemon that can't say (a store without owners: 501; an
    // older daemon without the route: 404) leaves the roster as the list,
    // and the page says what that misses.
    const owners = await api.grantOwners().then(
      (listed) => ({ ids: listed.agents ?? [] }),
      (error) => ({ error }),
    );
    const ids = [...new Set([...store.agents.map((agent) => agent.id), ...(owners.ids ?? [])])];
    const nameOf = (agentId) => store.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    const results = await Promise.all(ids.map((agentId) => api.grants(agentId).then(
      (listing) => ({ rows: rowsFor(agentId, listing) }),
      (error) => ({ error: `${nameOf(agentId)}: ${error.message}` }),
    )));
    if (!reads.isCurrent(ticket)) {
      return;
    }
    state.ownersListed = owners.error === undefined;
    const ownersError = owners.error !== undefined && !ownersUnknown(owners.error) ? owners.error : undefined;
    state.rows = results.flatMap((result) => result.rows ?? []);
    // A confirmation whose grant is gone (revoked elsewhere) is dropped,
    // rather than left waiting to act on whatever now looks like it.
    if (state.confirming !== undefined && !state.rows.some((row) => !row.config && `${row.agentId}\u0000${JSON.stringify(row.revoke)}` === state.confirming)) {
      state.confirming = undefined;
    }
    state.errors = [
      ...(ownersError ? [`Couldn't list agents no longer on the roster: ${ownersError.message}`] : []),
      ...results.flatMap((result) => (result.error ? [result.error] : [])),
    ];
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

  const rowNode = (row) => {
    const agent = store.agents.find((candidate) => candidate.id === row.agentId);
    // The grant's own identity, never its position: a reload can add or
    // remove rows, and a confirmation keyed by index would move to a
    // different grant and revoke that one instead.
    const key = row.config ? undefined : `${row.agentId}\u0000${JSON.stringify(row.revoke)}`;
    return el('div', { class: 'list-row', style: `padding: 14px 0;${row.stale ? ' opacity: 0.8;' : ''}` },
      agent ? avatar(agent, 24) : el('span', { class: 'avatar-gap', 'aria-hidden': 'true' }),
      el('div', { style: 'width: 110px; flex: none; font-weight: 500; overflow-wrap: anywhere;' },
        agent?.name ?? row.agentId,
        // Its soul is gone and its grants stayed: still revocable, and the
        // reason to look at this page at all.
        agent ? null : el('div', { class: 'field-note', style: 'margin: 2px 0 0; font-weight: 400;' }, 'Not on the roster')),
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
            : el('button', { class: 'btn small danger-text', onClick: () => { clearTimeout(state.trailing); state.trailing = undefined; state.confirming = key; paint(); } }, 'Revoke')));
  };

  const paint = () => {
    const rows = state.rows ?? [];
    // Only when the daemon couldn't list grant owners: then an agent removed
    // from the roster isn't asked about, so neither the list nor "none" is
    // the whole story.
    const ownersNote = state.ownersListed
      ? null
      : el('p', { class: 'field-note' }, 'This daemon can’t list grants kept for agents no longer on the roster, so those aren’t shown.');
    node.replaceChildren(el('div', { class: 'page-body', style: 'max-width: 1040px;' },
      el('div', { class: 'page-head' }, el('div', {},
        el('h1', {}, 'Permissions'),
        el('div', { class: 'sub' }, 'What you’ve allowed with “Always allow.” Revoke a grant and the agent asks again next time.'))),
      ...state.errors.map((error) => el('div', { class: 'notice bad', role: 'alert' }, error)),
      state.rows === undefined
        ? el('p', { class: 'field-note' }, 'Loading…')
        : rows.length === 0 && state.errors.length > 0
          // Some agent's grants couldn't be read, so "none" isn't known.
          ? null
        : rows.length === 0
          ? el('div', { class: 'empty-state' },
              el('span', { class: 'icon-box' }, icon('shield-check', 18)),
              el('h3', {}, 'No permissions yet'),
              el('p', {}, 'When you choose “Always allow” on an approval, the grant shows up here so you can revoke it.'),
              ownersNote)
          : el('div', {},
              el('div', { class: 'list' }, ...rows.map(rowNode)),
              el('div', { class: 'notice', style: 'margin-top: 20px; background: var(--bg); color: var(--text-2); display: flex; gap: 8px; align-items: center;' },
                icon('shield-check', 14),
                'Grants never widen on their own. Each row covers only what it says.'),
              ownersNote),
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
          // Checked again at fire time: a confirmation may have opened since.
          if (state.confirming === undefined && state.busy === undefined) {
            void load();
          }
        }, wait);
      }
    },
    destroy: () => clearTimeout(state.trailing),
  };
};
