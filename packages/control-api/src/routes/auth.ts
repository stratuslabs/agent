import { requestScheme } from '../auth.ts';
import { sendCredentialPage } from '../credential-links.ts';
import { API_PREFIX, ApiError, readBody } from '../http.ts';
import type { Route } from '../routes.ts';

export const authRoutes: Route[] = [
  // ---- auth ----------------------------------------------------------------
  {
    method: 'POST',
    pattern: `${API_PREFIX}/auth/ott`,
    bearerOnly: true,
    async handler(context) {
      const ott = context.mintOneTimeToken();
      const path = `${API_PREFIX}/auth/session?ott=${encodeURIComponent(ott)}`;
      // Built from the address this caller reached the daemon on, not the one
      // it bound to. Every request URL is parsed against the bound origin, so
      // `context.url.origin` is `http://127.0.0.1:4123` even for a caller that
      // arrived over a LAN address or a TLS-terminating proxy — a link that
      // points somewhere their browser cannot go, on exactly the deployments
      // origin binding now allows. `Host` is what they connected to, and a
      // browser cannot forge it; `x-forwarded-proto` is the proxy's own word
      // for the scheme it terminated, and it is read for nothing else.
      const host = context.request.headers.host;
      const scheme = requestScheme(context.request.headers['x-forwarded-proto']);
      const origin = host ? `${scheme}://${host}` : context.url.origin;
      return {
        ott,
        // Absolute, so the caller opens exactly the origin this token is
        // bound to rather than reassembling one and missing the port.
        url: `${origin}${path}`,
        // The same link without an origin, for a client that would rather
        // join it to a base it already holds than trust this one.
        path,
      };
    },
  },
  {
    method: 'GET',
    pattern: `${API_PREFIX}/auth/session`,
    selfAuthenticating: true,
    async handler(context) {
      const sessionId = context.redeemOneTimeToken(context.url.searchParams.get('ott') ?? undefined);
      if (!sessionId) {
        throw new ApiError(
          401,
          'invalid_one_time_token',
          'That link has already been used or has expired. Run `stratus dashboard` again for a fresh one.',
        );
      }
      context.response.statusCode = 302;
      context.response.setHeader(
        'set-cookie',
        // Flagged when this exchange came through TLS, so a session minted on
        // a public hostname is never sent back over plain HTTP to it.
        context.sessionCookie(sessionId, requestScheme(context.request.headers['x-forwarded-proto']) === 'https'),
      );
      context.response.setHeader('location', '/');
      context.response.setHeader('cache-control', 'no-store');
      context.response.end();
      return null;
    },
  },

  // ---- credential links ----------------------------------------------------
  // The form behind a link an agent was handed by `credential.request`. The
  // token in the path is the link's whole credential, by the operator's
  // choice: whoever holds the link answers the request once, through the
  // gateway's add-only `provideCredential`, and the value goes to the store
  // and nowhere else. A GET only shows the form, so a chat app unfurling the
  // link spends nothing.
  {
    method: 'GET',
    pattern: `${API_PREFIX}/credential-links/:token`,
    selfAuthenticating: true,
    async handler(context) {
      const record = context.credentialLinks.get(context.params.token ?? '');
      sendCredentialPage(context.response, record ? 200 : 404, record
        ? { record }
        : { error: 'This link has expired or was already used. Ask the agent to request the credential again.' });
      return null;
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/credential-links/:token`,
    selfAuthenticating: true,
    async handler(context) {
      const token = context.params.token ?? '';
      const record = context.credentialLinks.get(token);
      if (!record) {
        sendCredentialPage(context.response, 404, {
          error: 'This link has expired or was already used. Ask the agent to request the credential again.',
        });
        return null;
      }
      // A browser submits a text area's line breaks as CRLF whatever was
      // pasted (HTML's form encoding normalizes them), so a key file's LF
      // is restored here rather than stored as CRLF.
      const value = (new URLSearchParams(await readBody(context.request)).get('value') ?? '').replace(/\r\n/g, '\n');
      const result = await context.gateway.provideCredential({ requestId: record.requestId, value, actor: 'link' });
      if (result.ok) {
        context.credentialLinks.retire(token);
        sendCredentialPage(context.response, 200, {
          done: `Added ${record.name} for ${record.agentName}${record.scope === 'shared' ? ' as a shared credential' : ''}. `
            + `${record.agentName} can use it from its next reply`
            + `${record.env !== undefined ? `, and its shell commands read it as ${record.env}` : ''}. You can close this page.`,
        });
        return null;
      }
      if (result.retired === true) {
        // Final: no value typed here could land, so the link is spent too.
        context.credentialLinks.retire(token);
        sendCredentialPage(context.response, 409, { error: result.message });
        return null;
      }
      sendCredentialPage(context.response, 400, { record, error: result.message });
      return null;
    },
  },
];
