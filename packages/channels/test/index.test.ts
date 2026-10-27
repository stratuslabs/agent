import test from 'node:test';
import assert from 'node:assert/strict';

import * as core from '@stratusagent/core';
import * as shim from '../src/index.ts';
import type {
  AdmitPolicy,
  ChannelAdapter,
  ChannelCredentialRequest,
  ChannelSessionKeyParts,
  ConversationMessage,
  ConversationReadRequest,
  ConversationReadResult,
  GatewayLike,
  InboundMessage,
  OutboundAddress,
  OutboundConnection,
  OutboundMessageRef,
  SenderPolicy,
  SessionRouting,
} from '../src/index.ts';

// Every type the package exported before the contract moved into core.
// `pnpm typecheck` fails here if the shim drops one.
export type FormerTypes = [
  AdmitPolicy,
  ChannelAdapter,
  ChannelCredentialRequest,
  ChannelSessionKeyParts,
  ConversationMessage,
  ConversationReadRequest,
  ConversationReadResult,
  GatewayLike,
  InboundMessage,
  OutboundAddress,
  OutboundConnection,
  OutboundMessageRef,
  SenderPolicy,
  SessionRouting,
];

test('the deprecated package still exports every value it did, and each is core\'s own', () => {
  assert.deepEqual(Object.keys(shim).sort(), ['admitsSender', 'channelSessionKey', 'isPrincipal', 'senderTrustFor']);
  for (const [name, value] of Object.entries(shim)) {
    assert.equal(value, (core as Record<string, unknown>)[name], name);
  }
});
