// OpenID Connect ID-token validation with node:crypto, so the package needs
// no JWT dependency. OpenAI signs with RS256 only (its discovery document's
// id_token_signing_alg_values_supported), so anything else is refused rather
// than verified: accepting the header's own `alg` is how `none` and HMAC
// confusion attacks get in.
import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { ChatGPTAuthError } from './errors.ts';

export interface JsonWebKeySet {
  readonly keys: readonly JsonWebKey[];
}

export interface IdTokenClaims {
  readonly sub: string;
  readonly email?: string;
}

export interface VerifyIdTokenOptions {
  readonly token: string;
  readonly keys: JsonWebKeySet;
  readonly issuer: string;
  /** The issued client ID the token must be addressed to. */
  readonly audience: string;
  /** The nonce sent with this attempt's authorization request. */
  readonly nonce: string;
  /** Milliseconds since the epoch. */
  readonly now: number;
  /** Clock skew allowed on `exp` and `nbf`, in seconds. */
  readonly leewaySeconds?: number;
}

const DEFAULT_LEEWAY_SECONDS = 60;

const invalid = (problem: string): ChatGPTAuthError =>
  new ChatGPTAuthError('id_token_invalid', `OpenAI's ID token ${problem}, so the sign-in was not accepted. Sign in with ChatGPT again.`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const decodeSegment = (segment: string, what: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw invalid(`has an unreadable ${what}`);
  }
  if (!isRecord(value)) {
    throw invalid(`has an unreadable ${what}`);
  }
  return value;
};

const signingKeyFor = (keys: JsonWebKeySet, kid: unknown): JsonWebKey => {
  const candidates = keys.keys.filter(
    (key) => key.kty === 'RSA' && (key.use === undefined || key.use === 'sig') && (kid === undefined || key.kid === kid),
  );
  const [key] = candidates;
  if (key === undefined) {
    throw invalid(typeof kid === 'string' ? `is signed with key ${kid}, which OpenAI's published keys don't include` : 'names no signing key');
  }
  if (kid === undefined && candidates.length > 1) {
    throw invalid('names no signing key and OpenAI publishes several');
  }
  return key;
};

export const verifyIdToken = (options: VerifyIdTokenOptions): IdTokenClaims => {
  const parts = options.token.split('.');
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (parts.length !== 3 || headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined) {
    throw invalid('is not a signed JWT');
  }
  const header = decodeSegment(headerSegment, 'header');
  if (header.alg !== 'RS256') {
    throw invalid(`is signed with ${typeof header.alg === 'string' ? header.alg : 'no algorithm'}, not RS256`);
  }
  const jwk = signingKeyFor(options.keys, header.kid);
  let signed: boolean;
  try {
    signed = verify(
      'RSA-SHA256',
      Buffer.from(`${headerSegment}.${payloadSegment}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(signatureSegment, 'base64url'),
    );
  } catch {
    throw invalid("couldn't be checked against OpenAI's published key");
  }
  if (!signed) {
    throw invalid("has a signature that doesn't match OpenAI's published key");
  }

  const claims = decodeSegment(payloadSegment, 'payload');
  const leewayMs = (options.leewaySeconds ?? DEFAULT_LEEWAY_SECONDS) * 1000;
  if (claims.iss !== options.issuer) {
    throw invalid(`was issued by ${typeof claims.iss === 'string' ? claims.iss : 'nobody'}, not ${options.issuer}`);
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) {
    throw invalid('is addressed to another client');
  }
  if (claims.azp !== undefined && claims.azp !== options.audience) {
    throw invalid('was issued to another client');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 + leewayMs <= options.now) {
    throw invalid('has expired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 - leewayMs > options.now) {
    throw invalid('is not valid yet');
  }
  if (claims.nonce !== options.nonce) {
    throw invalid("doesn't carry this sign-in's nonce");
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw invalid('names no account');
  }
  return {
    sub: claims.sub,
    ...(typeof claims.email === 'string' && claims.email !== '' ? { email: claims.email } : {}),
  };
};
