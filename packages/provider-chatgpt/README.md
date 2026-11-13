# @stratusagent/provider-chatgpt

Sign in with ChatGPT for Stratus Agent, so agents can run on a ChatGPT plan
through the OpenAI Responses API. **Not published yet:** this package holds
the sign-in protocol, the refresh logic and the model provider. Stratus runs it
for `provider: chatgpt`, on the sign-in saved in
`~/.stratus/chatgpt-sign-in.json` under a lock every process shares
(`@stratusagent/state`'s `createChatGPTSignInFile`). `stratus setup` signs in
and out under Providers > ChatGPT, through state's `runChatGPTSignIn` and
`runChatGPTSignOut` (the CLI never imports a provider package). The model
picker and the account in `stratus doctor` come next.

It follows OpenAI's documentation for open-source hosts
([ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source)),
with no dependencies beyond Node's own `crypto` and `http` and Stratus's
`core` and `providers` packages:

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
- `createChatGPTTokenSource` hands out the access token during a run. Five
  minutes before it expires, it refreshes under the caller's session lock
  (which every write of the record takes, sign-in and sign-out included),
  rereads the saved record inside it (another process may have refreshed
  already), and saves the replacement before returning it. An outage keeps the tokens; a
  dead refresh token clears them and keeps the account for signing in again.
  A cancelled caller returns at once and sends no refresh, but a refresh
  already sent finishes and is saved, because the old refresh token may
  already be spent. It hands out no token for a sign-in that doesn't allow
  using the ChatGPT plan (`chatgpt.tokens.use.direct` not granted), as OpenAI
  asks.
  `sessionFromSignIn` makes the record to save from a completed sign-in.
- `createChatGPTProvider` is the model provider: the Responses adapter from
  `@stratusagent/providers` on the token source's access token, at
  `https://api.openai.com/v1` with `store: false` and streaming, and the tools
  inside one `stratus` namespace, as the plan requires. OpenAI's sign-in
  endpoints are looked up the first time a refresh needs them, inside the
  session lock, so the lookup gives up after 15 seconds and when the turn is
  cancelled. The plan's own
  errors (a usage limit, an account that isn't eligible, a refused admission)
  fail the turn in words that say what to do, with OpenAI's text, the HTTP
  status and the request ID kept; none is retried or sent another way.
- `signInWithChatGPT` joins these for setup: it makes and saves the host ID,
  opens the callback listener, hands the browser URL to the caller's
  `openUrl` (which opens or prints it; the URL can carry the saved ID token, so
  it is never logged), validates the sign-in and saves it under the session
  lock. It signs the saved account in again with its issued client ID, or
  registers a first one. One account per install for now: `account: 'new'`
  replaces the saved account only once it is signed out, and a sign-in that
  finds the saved account changed when it saves (another setup finished first)
  is refused rather than overwriting it. Opening the page runs alongside the
  wait, so an `openUrl` that never settles holds up neither the callback nor a
  timeout or cancel.
  It returns the account, whether plan usage was allowed and the expiry, never
  a token. `signOutOfChatGPT` revokes the refresh token under the lock, then
  clears the access, refresh and ID tokens even when OpenAI doesn't confirm,
  and keeps the account and host ID for signing in again.
- `listChatGPTModels` reads the signed-in account's own model list
  (`GET /v1/models` on its access token) for setup's picker: the models
  OpenAI marks to be shown, in its order, each with the slug to run and the
  name to show. A refusal fails in the same words a turn would use, and the
  list gives up after 15 seconds. `listSignedInChatGPTModels` asks it on a
  saved sign-in through the token source a turn uses, refreshing a token
  about to run out under the session lock first.

Every failure is a `ChatGPTAuthError` with a stable `code`: `temporary` keeps
the tokens, `signin_required` means the refresh token is dead and the user
signs in again, `plan_usage_not_granted` means the sign-in is valid but the
user didn't allow plan usage, `signed_in` means another account is signed in
here, `account_changed` means another sign-in changed the saved account
first, and `storage_failed` means the saved sign-in or its lock
failed on this machine. No message quotes a token.
