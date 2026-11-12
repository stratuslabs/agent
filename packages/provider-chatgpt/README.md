# @stratusagent/provider-chatgpt

Sign in with ChatGPT for Stratus Agent, so agents can run on a ChatGPT plan
through the OpenAI Responses API. **Not wired up yet, and not published:**
this package holds the sign-in protocol only. Storing the sign-in, refreshing
it during a run, and the setup and doctor screens come next.

It follows OpenAI's documentation for open-source hosts
([ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source)),
with no dependencies beyond Node's own `crypto` and `http`:

- `createHostId` makes the host's `ext_agent_host_id` (`urn:uuid:…`), made
  once and kept through sign-out.
- `listenForCallback` opens the one-shot callback listener on `127.0.0.1`
  (port 1455 when free, otherwise any free port). It answers only the request
  carrying the attempt's `state`, and closes on success, timeout or cancel.
- `createSignInAttempt` builds the browser URL with PKCE (S256), a fresh
  `state` and `nonce`: through `dynamic_agent_client` with the agent name on a
  first sign-in, or with the issued client ID and the saved hints when an
  account signs in again.
- `completeSignIn` checks the callback against its attempt, exchanges the
  code, and validates the ID token (RS256 signature against OpenAI's published
  keys, issuer, audience, expiry, nonce) before returning the account. Its
  `planUsage` says whether the user granted `chatgpt.tokens.use.direct`.
- `refreshTokens` trades the rotating refresh token for a new set, and
  `revokeRefreshToken` ends the session at sign-out, retrying an outage.

Every failure is a `ChatGPTAuthError` with a stable `code`: `temporary` keeps
the tokens, `signin_required` means the refresh token is dead and the user
signs in again. No message quotes a token.
