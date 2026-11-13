// One error type for every way a ChatGPT sign-in, refresh or sign-out can
// fail. Setup and the runtime decide what to do from `code` (keep the tokens
// and retry, or ask for a new sign-in) and show `message` as is. A message
// never quotes a token: the only remote text in one is the server's own
// error code and description.
export type ChatGPTAuthErrorCode =
  /** The callback belongs to another sign-in attempt. */
  | 'state_mismatch'
  /** The user declined in the browser. */
  | 'access_denied'
  /** Any other OAuth error on the callback. */
  | 'authorization_failed'
  /** A first sign-in came back without an issued client ID. */
  | 'registration_incomplete'
  /** A returning sign-in came back with a different client ID. */
  | 'client_mismatch'
  /** The authorization code was refused; start a fresh sign-in. */
  | 'invalid_grant'
  | 'id_token_invalid'
  /** A returning sign-in validated as a different ChatGPT account. */
  | 'account_mismatch'
  /** Another ChatGPT account is signed in here; sign it out before adding a new one. */
  | 'signed_in'
  /** The refresh token can't be used again; the user signs in again. */
  | 'signin_required'
  /**
   * The sign-in is valid but doesn't allow using the ChatGPT plan
   * (`chatgpt.tokens.use.direct` wasn't granted), so no inference may be sent
   * on it. The user signs in again and allows it, or uses an API key.
   */
  | 'plan_usage_not_granted'
  | 'invalid_client'
  /** A network failure, 429 or 5xx: keep the tokens and try later. */
  | 'temporary'
  /** Any other refused or malformed response. */
  | 'request_failed'
  /** Reading or saving the stored sign-in, or taking its lock, failed on this machine. */
  | 'storage_failed'
  | 'timeout'
  | 'cancelled';

export class ChatGPTAuthError extends Error {
  readonly code: ChatGPTAuthErrorCode;

  constructor(code: ChatGPTAuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChatGPTAuthError';
    this.code = code;
  }
}
