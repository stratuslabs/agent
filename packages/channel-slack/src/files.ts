/*
 * Fetching the files a message carries: the slice of Slack's file object
 * the adapter reads, what a download returns, the fetcher contract (a
 * deadline and a byte cap it must honor), the default fetcher over `fetch`,
 * and the guard that sends the bot token only to Slack's own file host.
 * What the files then become for the model is `attachments.ts`. `index.ts`
 * re-exports the public names, so the package's one public entry is
 * unchanged.
 */

/** The slice of Slack's file object the adapter reads. */
export interface SlackInboundFile {
  id?: string;
  name?: string;
  title?: string;
  /** Slack's own `image/png`-style type, decided by the uploader's client. */
  mimetype?: string;
  /** Bytes, as Slack reports them; checked before anything is downloaded. */
  size?: number;
  url_private?: string;
  url_private_download?: string;
  /**
   * Slack's scaled copies of an image, each behind its own private URL
   * that the same `files:read` token opens, named for the longest side
   * they fit. One of these is what an image too big for the model is sent
   * as (see `readImageAttachments`).
   */
  thumb_360?: string;
  thumb_480?: string;
  thumb_720?: string;
  thumb_800?: string;
  thumb_960?: string;
  thumb_1024?: string;
}

/**
 * What came back from fetching a file's private URL. Slack answers a
 * request the app is not allowed to make — a token without `files:read` —
 * with a **200 and a sign-in page**, never an error status, which is why
 * the content type travels: it is the only thing that tells an image from
 * an HTML apology for one.
 */
export interface SlackFileDownload {
  status: number;
  contentType?: string;
  body: Buffer;
  /**
   * Set when the body was cut off at `maxBytes`: what is in `body` is not
   * the file, only proof that the file was bigger than the caller would
   * take.
   */
  truncated?: boolean;
}

/**
 * Fetches a file's private URL with the bot token. `signal` is the
 * download's deadline, and a fetcher MUST stop on it — headers and body
 * both: the download runs inside the session's intake chain, so one that
 * stalls holds every later message in the thread, and `stop()` waits on
 * the handler too. `maxBytes` is the most body a fetcher may buffer; one
 * that reads past it MUST stop there and report `truncated`, because
 * Slack's reported size is advisory and a response is not.
 */
export type SlackFileFetcher = (url: string, botToken: string, signal: AbortSignal, maxBytes: number) => Promise<SlackFileDownload>;

/**
 * The default fetcher over a `fetch`. Exported as a factory so the bounded
 * read can be tested against a fake `fetch` with a body that never ends;
 * the adapter uses it over the global one.
 *
 * The body is read a chunk at a time and abandoned the moment it passes
 * `maxBytes`: `arrayBuffer()` would buffer the whole response first, and
 * the size the adapter checked before asking came from Slack's metadata,
 * which an oversized response is under no obligation to match. A
 * `content-length` that already says too much is refused before a byte is
 * read.
 */
export const createSlackFileFetcher = (fetchImpl: typeof fetch): SlackFileFetcher => async (url, botToken, signal, maxBytes) => {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${botToken}` }, signal });
  const contentType = response.headers.get('content-type');
  const typed = contentType !== null ? { contentType } : {};
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return { status: response.status, ...typed, body: Buffer.alloc(0), truncated: true };
  }
  if (response.body === null) {
    return { status: response.status, ...typed, body: Buffer.alloc(0) };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { status: response.status, ...typed, body: Buffer.alloc(0), truncated: true };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { status: response.status, ...typed, body: Buffer.concat(chunks) };
};

export const defaultFetchFile: SlackFileFetcher = (url, botToken, signal, maxBytes) =>
  createSlackFileFetcher(fetch)(url, botToken, signal, maxBytes);

/**
 * The one origin a file URL may name for the bot token to go with it.
 * `url_private` does not by itself mean Slack hosts the file: for a remote
 * file (an app's pointer to a file it hosts), Slack returns the app's own
 * URL there, on whatever host the app chose, so any app with
 * `remote_files:write` could collect the token of every agent that opened
 * its file. Slack's rule is never to send Slack credentials to such a URL,
 * and to compare the parsed host exactly rather than a prefix
 * (docs.slack.dev, Working with files: Downloading files). Previews and
 * downloads both live here. A redirect elsewhere is not a leak either:
 * fetch drops `authorization` on a cross-origin redirect.
 */
const SLACK_FILE_ORIGIN = 'https://files.slack.com';

/**
 * A fetcher that is only ever handed URLs on Slack's file host. Anything
 * else is refused before a request is made, with a reason that names the
 * origin, and the callers' own handling turns that into a name-only file
 * and an operator warning, as for any download that failed.
 */
export const onlySlackFileHost = (fetchFile: SlackFileFetcher): SlackFileFetcher => (url, botToken, signal, maxBytes) => {
  let origin: string | undefined;
  try {
    const parsed = new URL(url);
    // Credentials in the URL would be sent with the token: not Slack's.
    origin = parsed.username === '' && parsed.password === '' ? parsed.origin : `${parsed.protocol}//(credentials)@${parsed.host}`;
  } catch {
    origin = undefined;
  }
  if (origin !== SLACK_FILE_ORIGIN) {
    return Promise.reject(new Error(`${origin ?? 'its link'} is not Slack's file host (${SLACK_FILE_ORIGIN}), so the bot token is not sent there`));
  }
  return fetchFile(url, botToken, signal, maxBytes);
};
