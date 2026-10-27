/**
 * Deprecated: the channel contract now ships in `@stratusagent/core`.
 * Import these names from there; this package re-exports them for one more
 * release so an adapter built against it keeps working while it moves.
 */
export {
  admitsSender,
  channelSessionKey,
  isPrincipal,
  senderTrustFor,
  type AdmitPolicy,
  type ChannelAdapter,
  type ChannelCredentialRequest,
  type ChannelSessionKeyParts,
  type ConversationMessage,
  type ConversationReadRequest,
  type ConversationReadResult,
  type GatewayLike,
  type InboundMessage,
  type OutboundAddress,
  type OutboundConnection,
  type OutboundMessageRef,
  type SenderPolicy,
  type SessionRouting,
} from '@stratusagent/core';
