import { createHash, randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import type { CredentialScope } from '@stratusagent/core';

/**
 * How long a credential link stays usable. Long enough to reach a phone,
 * find the key, and paste it; short enough that a link left in a thread
 * stops being a way in before anyone stumbles on it.
 */
export const CREDENTIAL_LINK_TTL_MS = 30 * 60_000;

/** What a link answers for: one pending request, and what to show about it. */
export interface CredentialLinkRecord {
  requestId: string;
  agentId: string;
  agentName: string;
  name: string;
  scope: CredentialScope;
  reason?: string;
  /** The variable the agent's shell will read the key from, which the page says before anything is typed. */
  env?: string;
  expiresAt: number;
}

/**
 * Why a token opens no form, so the page can say it instead of guessing:
 * `expired`, `used` (answered), `closed` (its request can no longer be
 * answered), `restarted` (issued by another run of the daemon, or by
 * another daemon altogether), or `unrecognized` (cut short, reformatted,
 * or spent so long ago it is no longer remembered).
 */
export type CredentialLinkRefusal =
  | { reason: 'expired' | 'used' | 'closed'; at: number }
  | { reason: 'restarted' | 'unrecognized' };

export interface CredentialLinkStore {
  /** A fresh token for this request. */
  mint(record: Omit<CredentialLinkRecord, 'expiresAt'>): { token: string; expiresAt: number };
  /** The live record behind a token, or undefined once it expired or was spent. */
  get(token: string): CredentialLinkRecord | undefined;
  /** Why `get` found no live record for this token. Spends nothing. */
  refusal(token: string): CredentialLinkRefusal;
  /** Spend a token: the request was answered (`used`), or can no longer be (`closed`). */
  retire(token: string, reason: 'used' | 'closed'): void;
}

/** How many spent or expired tokens are remembered for their reason. */
const KEEP_ENDED = 1_000;
/** Characters of the per-process prefix a token starts with. */
const RUN_ID_LENGTH = 8;
/** Characters of the 256 random bits after it, as base64url. */
const SECRET_LENGTH = 43;
/** Characters of the check that ends it: 3 bytes of a hash of the rest. */
const CHECK_LENGTH = 4;
const TOKEN_LENGTH = RUN_ID_LENGTH + SECRET_LENGTH + CHECK_LENGTH;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Not a secret and not a signature: it only shows the token arrived as it was minted. */
const checkOf = (body: string): string => createHash('sha256').update(body).digest().subarray(0, 3).toString('base64url');

/**
 * The tokens behind credential links, in memory only.
 *
 * In memory for the reason the gateway keeps its requests there: a restart
 * forgets the request a link answers, so a link surviving it would open a
 * form nothing can receive. The token is the link's whole credential (the
 * operator chose that over requiring a dashboard session), so it is 256
 * random bits, is spent the moment an answer is final, and dies on its own
 * after `CREDENTIAL_LINK_TTL_MS`.
 *
 * Every token starts with a random id for this store and ends with a short
 * check of everything before it, so a token this store never issued can be
 * told apart from one it issued and forgot, and from one that changed on
 * the way: a link from before a restart (or from another daemon) is a
 * different refusal from a link a chat app cut short. The id says nothing
 * but "same run or not".
 * A spent or expired token is remembered with its reason (the newest
 * `keepEnded` of them); it can never open a form again either way.
 */
export const createCredentialLinkStore = (
  options: { now?: () => number; ttlMs?: number; keepEnded?: number } = {},
): CredentialLinkStore => {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CREDENTIAL_LINK_TTL_MS;
  const keepEnded = options.keepEnded ?? KEEP_ENDED;
  const runId = randomBytes(6).toString('base64url');
  const links = new Map<string, CredentialLinkRecord>();
  const ended = new Map<string, { reason: 'expired' | 'used' | 'closed'; at: number }>();
  const end = (token: string, reason: 'expired' | 'used' | 'closed', at: number): void => {
    links.delete(token);
    ended.delete(token);
    ended.set(token, { reason, at });
    while (ended.size > keepEnded) {
      const oldest = ended.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      ended.delete(oldest);
    }
  };
  const sweep = (): void => {
    const at = now();
    for (const [token, record] of links) {
      if (record.expiresAt <= at) {
        end(token, 'expired', record.expiresAt);
      }
    }
  };
  return {
    mint(record) {
      sweep();
      const body = `${runId}${randomBytes(32).toString('base64url')}`;
      const token = `${body}${checkOf(body)}`;
      const expiresAt = now() + ttlMs;
      links.set(token, { ...record, expiresAt });
      return { token, expiresAt };
    },
    get(token) {
      sweep();
      return links.get(token);
    },
    refusal(token) {
      sweep();
      const known = ended.get(token);
      if (known !== undefined) {
        return { ...known };
      }
      // Arrived as minted (its check holds), but not this run's: issued
      // before the daemon restarted, or by another one. Anything whose
      // check fails was cut short or changed on the way, and so is a link
      // from a build before the check, which can't be told from one.
      const body = token.slice(0, -CHECK_LENGTH);
      const intact = token.length === TOKEN_LENGTH && BASE64URL.test(token) && checkOf(body) === token.slice(-CHECK_LENGTH);
      return intact && !body.startsWith(runId) ? { reason: 'restarted' } : { reason: 'unrecognized' };
    },
    retire(token, reason) {
      // Only a live token, or one that ran out while its answer was being
      // stored (that answer landed, so it was used). One already spent
      // keeps its first reason: a second submission racing the first is
      // refused as no longer pending, but the link was used, not closed.
      if (links.has(token) || ended.get(token)?.reason === 'expired') {
        end(token, reason, now());
      }
    },
  };
};

/** What the page says for a refused link: the real reason, and what to do. */
export const credentialLinkRefusal = (refusal: CredentialLinkRefusal): string => {
  const again = 'Ask the agent to request the credential again.';
  switch (refusal.reason) {
    case 'expired':
      return `This link expired at ${new Date(refusal.at).toISOString()}. ${again}`;
    case 'used':
      return `This link was already used, at ${new Date(refusal.at).toISOString()}. A link works once. `
        + 'If the key still isn\'t there, ask the agent to request it again.';
    case 'closed':
      return `This link was closed at ${new Date(refusal.at).toISOString()}, because its request could no longer be answered. ${again}`;
    case 'restarted':
      return 'This link is from before the daemon last restarted, or from another daemon. A link works only on the daemon '
        + `that issued it, and not after that daemon restarts. ${again} Then open the new link at the address it gives.`;
    case 'unrecognized':
      return 'This daemon doesn\'t recognize this link. Check that it was copied whole (a chat app can cut a long link short '
        + `or change its characters). ${again}`;
  }
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

const whose = (record: CredentialLinkRecord): string =>
  record.scope === 'agent'
    ? `for ${escapeHtml(record.agentName)} only`
    : `stored for the whole fleet, granted to ${escapeHtml(record.agentName)} (other agents need it in their own soul)`;

/**
 * The credential page, or the message that replaces it.
 *
 * No script, no external anything: the token is in this page's address, so
 * nothing may load from elsewhere (a referrer would carry it), and the page
 * may not be framed (a frame could watch the field). A plain form POST to
 * itself is the whole interaction.
 */
export const sendCredentialPage = (
  response: ServerResponse,
  status: number,
  content: { record?: CredentialLinkRecord; error?: string; done?: string },
): void => {
  const { record, error, done } = content;
  const body = done !== undefined || record === undefined
    ? `<h1>${done !== undefined ? 'Done' : 'Link not usable'}</h1><p>${escapeHtml(done ?? error ?? '')}</p>`
    : `<h1>Add a credential</h1>`
      + `<p><strong>${escapeHtml(record.agentName)}</strong> is asking for <code>${escapeHtml(record.name)}</code>, ${whose(record)}.</p>`
      + (record.reason !== undefined ? `<p class="reason"><em>${escapeHtml(record.agentName)} says:</em> ${escapeHtml(record.reason)}</p>` : '')
      + (record.env !== undefined
        ? `<p><strong>${escapeHtml(record.agentName)}'s shell commands will be able to read this as <code>${escapeHtml(record.env)}</code>, `
          + `so ${escapeHtml(record.agentName)} can see the value.</strong></p>`
        : '')
      + (error !== undefined ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '')
      + '<form method="post">'
      + `<label for="value">Value for ${escapeHtml(record.name)}</label>`
      + '<p class="hint" id="value-hint">Paste the whole value. A key file, such as a PEM private key, keeps its line breaks.</p>'
      // A text area, not a password input: a password input strips the
      // line breaks out of anything pasted into it, which breaks a key
      // file. Masked with -webkit-text-security, which every current
      // browser engine supports.
      + '<textarea id="value" name="value" rows="4" aria-describedby="value-hint" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus></textarea>'
      + '<button type="submit">Add credential</button>'
      + '</form>'
      + `<p class="small">This link works once and expires at ${escapeHtml(new Date(record.expiresAt).toISOString())}. `
      + 'The value goes straight to the credential store on the machine, never into the conversation, '
      + 'and a key already stored is never replaced from here.</p>';
  response.statusCode = status;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  response.end(
    '<!doctype html><html lang="en"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex">'
    + '<title>Add a credential · Stratus Agent</title>'
    + '<style>body{font-family:system-ui,sans-serif;background:#05070f;color:#f3f7ff;margin:0;padding:2rem 1rem;line-height:1.5}'
    + 'main{max-width:32rem;margin:0 auto}code{font-size:.95em}label{display:block;margin:1.5rem 0 .4rem}'
    + 'textarea{box-sizing:border-box;width:100%;padding:.7rem;font-size:1rem;border-radius:.4rem;border:1px solid #3a4560;background:#0d1222;color:inherit;'
    + 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;-webkit-text-security:disc}'
    + 'button{margin-top:1rem;padding:.7rem 1.2rem;font-size:1rem;border:0;border-radius:.4rem;background:#3d7dd9;color:#fff}'
    + '.error{color:#ff9a8a}.reason,.small,.hint{color:#b7c0d8}.small{font-size:.875rem;margin-top:2rem}.hint{font-size:.875rem;margin:0 0 .4rem}</style>'
    + `<body><main>${body}</main></body></html>`,
  );
};
