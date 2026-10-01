import { randomBytes } from 'node:crypto';
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
  expiresAt: number;
}

export interface CredentialLinkStore {
  /** A fresh token for this request. */
  mint(record: Omit<CredentialLinkRecord, 'expiresAt'>): { token: string; expiresAt: number };
  /** The live record behind a token, or undefined once it expired or was spent. */
  get(token: string): CredentialLinkRecord | undefined;
  /** Spend a token: the request was answered, or can no longer be. */
  retire(token: string): void;
}

/**
 * The tokens behind credential links, in memory only.
 *
 * In memory for the reason the gateway keeps its requests there: a restart
 * forgets the request a link answers, so a link surviving it would open a
 * form nothing can receive. The token is the link's whole credential (the
 * operator chose that over requiring a dashboard session), so it is 256
 * random bits, is spent the moment an answer is final, and dies on its own
 * after `CREDENTIAL_LINK_TTL_MS`.
 */
export const createCredentialLinkStore = (options: { now?: () => number; ttlMs?: number } = {}): CredentialLinkStore => {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CREDENTIAL_LINK_TTL_MS;
  const links = new Map<string, CredentialLinkRecord>();
  const sweep = (): void => {
    const at = now();
    for (const [token, record] of links) {
      if (record.expiresAt <= at) {
        links.delete(token);
      }
    }
  };
  return {
    mint(record) {
      sweep();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = now() + ttlMs;
      links.set(token, { ...record, expiresAt });
      return { token, expiresAt };
    },
    get(token) {
      sweep();
      return links.get(token);
    },
    retire(token) {
      links.delete(token);
    },
  };
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
      + (error !== undefined ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '')
      + '<form method="post">'
      + `<label for="value">Value for ${escapeHtml(record.name)}</label>`
      + '<input id="value" name="value" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required autofocus>'
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
    + '<title>Stratus: add a credential</title>'
    + '<style>body{font-family:system-ui,sans-serif;background:#05070f;color:#f3f7ff;margin:0;padding:2rem 1rem;line-height:1.5}'
    + 'main{max-width:32rem;margin:0 auto}code{font-size:.95em}label{display:block;margin:1.5rem 0 .4rem}'
    + 'input{box-sizing:border-box;width:100%;padding:.7rem;font-size:1rem;border-radius:.4rem;border:1px solid #3a4560;background:#0d1222;color:inherit}'
    + 'button{margin-top:1rem;padding:.7rem 1.2rem;font-size:1rem;border:0;border-radius:.4rem;background:#3d7dd9;color:#fff}'
    + '.error{color:#ff9a8a}.reason,.small{color:#b7c0d8}.small{font-size:.875rem;margin-top:2rem}</style>'
    + `<body><main>${body}</main></body></html>`,
  );
};
