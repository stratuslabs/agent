/*
 * Turns nobody in this process was rendering: a turn the startup sweep
 * failed because the last daemon died inside it, or one parked on an
 * approval that a restarted daemon completed. Their outcome (the failure,
 * or the reply) and any files they produced are posted into the thread
 * from the durable session's routing, ahead of a renderer queued behind
 * them. Moved out of `createSlackChannelAdapter` in index.ts as is: the
 * statements are unchanged, inside a factory that takes what they closed
 * over there, and the adapter calls it exactly where they were. Nothing
 * here is public.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CONVERSATION_METADATA_KEY,
  type GatewayLike,
  type JsonObject,
  type Session,
  type StratusEvent,
} from '@stratusagent/core';
import {
  type HandoverClaim,
  messageChunks,
  NO_REPLY_TEXT,
  NOTHING_REPORTED,
  postPart,
  type ReportedOutcome,
} from './reply.ts';
import type { AgentConnection } from './connection.ts';

/** What createUnrenderedOutcomes closes over: values createSlackChannelAdapter owns. */
export interface UnrenderedOutcomesDeps {
  log: (line: string) => void;
  warn: (line: string) => void;
  unrenderedFiles: Map<string, string[]>;
  getGateway: () => GatewayLike | undefined;
  tagsAnAgent: (connection: AgentConnection, text: string) => Promise<boolean>;
  connectionFor: (agentId: string) => AgentConnection | undefined;
  overhearReply: (
    speaker: AgentConnection,
    channel: string,
    thread: string,
    reply: string | (() => string),
    spoken: Pick<Session, 'metadata'> | (() => Promise<Pick<Session, 'metadata'>>),
    published: Promise<boolean>,
  ) => Promise<void>;
  slackStopper: (error: string | undefined) => string | undefined;
}

export const createUnrenderedOutcomes = ({
  log,
  warn,
  unrenderedFiles,
  getGateway,
  tagsAnAgent,
  connectionFor,
  overhearReply,
  slackStopper,
}: UnrenderedOutcomesDeps) => {
  /**
   * Says so in the thread when a turn fails with nobody rendering it.
   *
   * The intake path reports a failure through the renderer it opened, so a
   * turn this process started is always answered. A turn it did NOT start
   * has no renderer: one the startup sweep failed because the last daemon
   * died mid-turn, or one whose recovery could not be finished. Those are
   * exactly the cases where the person is still looking at the thread,
   * and silence there reads as an agent that simply never replied.
   *
   * The routing has to come from the durable session, because the only
   * in-memory copy died with the process that had it.
   */
  /**
   * Post a turn's outcome into its thread ahead of a renderer queued behind
   * it, when there is one — through that renderer's placeholder, so the
   * thread reads in order — and as fresh messages otherwise. Each chunk on
   * its own, the way `finalize` posts overflow: one refused chunk must not
   * cost the rest of the answer.
   */
  const postAheadOf = async (
    behind: HandoverClaim | undefined,
    connection: AgentConnection,
    channel: string,
    thread: string | undefined,
    chunks: readonly string[],
    between?: () => Promise<void>,
    whole?: string,
  ): Promise<boolean> => {
    const taken = behind ? await behind.take(chunks, between, chunks.length > 1 ? whole : undefined) : 'untaken';
    if (taken !== 'untaken') {
      return taken === 'complete';
    }
    // Whether ALL of it landed, as `finalize` answers: a reply the thread
    // saw part of is not one anybody else may be told the whole of.
    let published = true;
    for (const chunk of chunks) {
      try {
        // A part that tags another agent carries the whole reply (card 1033).
        const full = whole !== undefined && chunks.length > 1 && await tagsAnAgent(connection, chunk) ? whole : undefined;
        await postPart(connection.web, { channel, thread, text: chunk, whole: full }, warn);
      } catch (error) {
        published = false;
        warn(`slack: could not post part of a turn's outcome: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (between) {
      await between();
    }
    return published;
  };

  /**
   * The files an unrendered turn produced, taken off the session the moment
   * its outcome arrives — before anything is awaited, so a next turn's files
   * arriving while this outcome waits on Slack are never mistaken for its.
   */
  const takeUnrenderedFiles = (sessionId: string): string[] => {
    const paths = unrenderedFiles.get(sessionId) ?? [];
    unrenderedFiles.delete(sessionId);
    return paths;
  };

  /** Post the files an unrendered turn produced into its thread, in order. */
  const uploadUnrenderedFiles = async (
    connection: AgentConnection,
    channel: string,
    thread: string | undefined,
    paths: readonly string[],
  ): Promise<string[]> => {
    // Which files landed: a redelivery waiting behind this report posts
    // the rest (`outcomeReportedAhead`), since a file that did not land is
    // one only it can still post — and only the rest, or it would post
    // twice the ones that did.
    const landed: string[] = [];
    for (const filePath of paths) {
      try {
        const data = await readFile(filePath);
        await connection.web.files.uploadV2({
          channel_id: channel,
          file: data,
          filename: path.basename(filePath),
          ...(thread ? { thread_ts: thread } : {}),
        });
        landed.push(filePath);
      } catch (error) {
        warn(`files.uploadV2 failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return landed;
  };

  const reportUnrenderedFailure = async (
    event: Extract<StratusEvent, { type: 'session.failed' }>,
    behind: HandoverClaim | undefined,
    files: readonly string[],
  ): Promise<ReportedOutcome> => {
    // A turn no renderer here was showing (card 501) that a Slack stop
    // aborted fails with the stop's own reason, so who stopped it is read
    // from the failure itself rather than from a note an outcome may never
    // come to clear.
    const stoppedBy = slackStopper(event.error);
    const gateway = getGateway();
    if (!gateway?.sessionRouting) {
      return NOTHING_REPORTED;
    }
    let routing;
    try {
      routing = await gateway.sessionRouting(event.sessionId);
    } catch (error) {
      // A store that cannot answer is not a reason to lose the daemon, and
      // the turn is already failed — there is nothing here to salvage
      // beyond saying why the thread stayed quiet.
      warn(`slack: could not read the routing for a failed turn: ${error instanceof Error ? error.message : String(error)}`);
      return NOTHING_REPORTED;
    }
    const metadata = routing?.metadata;
    // Another surface's session, or one with no conversation to speak
    // into. Not this adapter's to answer either way.
    if (!routing || metadata?.channel !== 'slack' || typeof metadata.slackChannel !== 'string') {
      return NOTHING_REPORTED;
    }
    const connection = connectionFor(routing.agentId);
    if (!connection) {
      return NOTHING_REPORTED;
    }
    const channel = metadata.slackChannel;
    const thread = typeof metadata.slackThread === 'string' ? metadata.slackThread : undefined;
    if (stoppedBy === undefined && routing.unaddressed === true && routing.reply === undefined) {
      // A stop is someone asking, so a stopped turn always says who
      // stopped it, judged or not.
      //
      // A turn nobody asked for that said nothing before it broke — the
      // daemon died inside it, and the next start failed it with no
      // renderer here to keep quiet for it. The same rule as the lazy
      // renderer's: the failure is in the log, and the files it produced
      // still land, since a file is not nothing to say.
      //
      // "Said nothing" as the session can tell it: no reply saved for the
      // turn. A line the old process had streamed into a placeholder and
      // never saved is invisible here — the session records what was
      // said, not what Slack took (the open delivery-record item at the
      // gateway's lastSpokeAt) — so such a
      // turn is failed without a note under that line. Taken over the
      // alternative on purpose: a note for every judged turn a restart
      // caught turns a silent turn, the common case, into the
      // interruption it existed to avoid; a line left standing happens
      // only to a turn that had already chosen to speak.
      warn(`slack: a turn nobody asked for failed before saying anything: ${event.error}`);
      return { said: true, landed: await uploadUnrenderedFiles(connection, channel, thread, files) };
    }
    let landed: string[] = [];
    const said = await postAheadOf(
      behind,
      connection,
      channel,
      thread,
      messageChunks(
        stoppedBy !== undefined
          ? `Stopped by <@${stoppedBy}>.`
          : event.refused ? event.error : `Something went wrong: ${event.error}`,
      ),
      async () => {
        landed = await uploadUnrenderedFiles(connection, channel, thread, files);
      },
    );
    return { said, landed };
  };

  /**
   * The other half of `reportUnrenderedFailure`: a turn nobody here was
   * rendering that *finished*. A turn parked on a human when the daemon
   * died is re-asked after the restart, approved, and completed by a
   * process that never opened a placeholder for it — so the approval
   * survived the restart and the reply went nowhere. Posted as a fresh
   * message in the thread, since the placeholder it would have edited
   * belonged to the old process.
   */
  const reportUnrenderedReply = async (
    event: Extract<StratusEvent, { type: 'session.completed' }>,
    behind: HandoverClaim | undefined,
    files: readonly string[],
  ): Promise<ReportedOutcome> => {
    const gateway = getGateway();
    if (!gateway?.sessionRouting) {
      return NOTHING_REPORTED;
    }
    let routing;
    try {
      routing = await gateway.sessionRouting(event.sessionId);
    } catch (error) {
      warn(`slack: could not read the routing for a finished turn: ${error instanceof Error ? error.message : String(error)}`);
      return NOTHING_REPORTED;
    }
    const metadata = routing?.metadata;
    if (!routing || metadata?.channel !== 'slack' || typeof metadata.slackChannel !== 'string') {
      return NOTHING_REPORTED;
    }
    const connection = connectionFor(routing.agentId);
    if (!connection) {
      return NOTHING_REPORTED;
    }
    const channel = metadata.slackChannel;
    const thread = typeof metadata.slackThread === 'string' ? metadata.slackThread : undefined;
    // A turn that produced files and no text still has the files to post —
    // and still has to take the placeholder when one is queued behind it.
    // An upload is a new message, so an attachment posted while the newer
    // turn's placeholder sits above it reads as the older turn answering
    // last. `NO_REPLY_TEXT` is what a rendered turn with nothing to say
    // puts in its own message too. With nothing queued behind, there is no
    // order to keep and nothing to say, so the files go on their own.
    const replies = connection.config.replies === 'texts' && routing.reply && await tagsAnAgent(connection, routing.reply)
      ? 'final'
      : connection.config.replies;
    const chunks = routing.reply ? messageChunks(routing.reply, replies) : [];
    const posting = chunks.length > 0 ? chunks : (behind && files.length > 0 ? [NO_REPLY_TEXT] : []);
    let landed: string[] = [];
    const uploads = async (): Promise<void> => {
      landed = await uploadUnrenderedFiles(connection, channel, thread, files);
    };
    if (posting.length === 0) {
      await uploads();
      // Nothing was said. A turn nobody asked for chose that; an addressed
      // one is owed `(no reply)`, which a rendered turn would have posted,
      // so a redelivery waiting behind this report is left to post it.
      return { said: routing.unaddressed === true, landed };
    }
    // A reply the thread's other agents hear like any other, taking their
    // place for it before the post, as `handleInbound` does. A DM thread
    // has nobody else in it to hear, as on the live path.
    const published = postAheadOf(behind, connection, channel, thread, posting, uploads, routing.reply);
    const conversation = metadata[CONVERSATION_METADATA_KEY];
    const isDm = typeof conversation === 'object' && conversation !== null && !Array.isArray(conversation)
      && (conversation as JsonObject).kind === 'direct';
    const heard = routing.reply !== undefined && thread !== undefined && !isDm
      ? overhearReply(connection, channel, thread, routing.reply, routing, published)
      : undefined;
    const delivered = await published;
    await heard;
    log(`slack: posted the reply of a turn finished after a restart to ${channel}`);
    return { said: delivered, landed };
  };

  return { takeUnrenderedFiles, reportUnrenderedFailure, reportUnrenderedReply };
};

export type UnrenderedOutcomes = ReturnType<typeof createUnrenderedOutcomes>;
