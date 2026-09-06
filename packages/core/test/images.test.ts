import test from 'node:test';
import assert from 'node:assert/strict';

import { IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES, imagesWithinReplayBudget, type ImageAttachment, type Message } from '../src/index.ts';

// base64 of N bytes is 4 * ceil(N / 3) characters; these are 6 and 9 bytes.
// Each fixture is given a distinct payload so an assertion on which ones
// were kept cannot be satisfied by a structurally identical neighbour.
let serial = 0;
const distinct = (length: number): string => `${String(serial += 1).padStart(2, '0')}${'A'.repeat(length - 2)}`;
const sixBytes = (): ImageAttachment => ({ mediaType: 'image/png', data: distinct(8) });
const nineBytes = (): ImageAttachment => ({ mediaType: 'image/png', data: distinct(12) });

const user = (id: string, images?: ImageAttachment[]): Message => ({
  id,
  role: 'user',
  content: id,
  createdAt: new Date().toISOString(),
  ...(images ? { images } : {}),
});

test('the replay budget is spent newest first and cuts off contiguously', () => {
  const oldest = sixBytes();
  const middle = nineBytes();
  const newestA = sixBytes();
  const newestB = sixBytes();
  const messages = [
    user('u1', [oldest]),
    { id: 'a1', role: 'assistant', content: 'ok', createdAt: new Date().toISOString() } satisfies Message,
    user('u2', [middle]),
    user('u3', [newestA, newestB]),
  ];

  // 12 bytes: the newest message's two images exactly, nothing older.
  const twelve = imagesWithinReplayBudget(messages, 12);
  assert.deepEqual([...twelve], [newestB, newestA]);
  assert.notDeepEqual(newestA, newestB);

  // 6 bytes: only the later of the newest message's two images — the
  // budget is newest-first inside a message too, not first-listed.
  const six = imagesWithinReplayBudget(messages, 6);
  assert.deepEqual([...six], [newestB]);

  // 21 bytes: the middle one fits too, and the oldest would as well on its
  // own — but the cut-off is contiguous, so it is out (21 - 12 - 9 = 0).
  const twentyOne = imagesWithinReplayBudget(messages, 21);
  assert.equal(twentyOne.has(middle), true);
  assert.equal(twentyOne.has(oldest), false);

  // 27 bytes: everything.
  assert.equal(imagesWithinReplayBudget(messages, 27).size, 4);

  // Membership is by identity, and the default budget is the shared cap.
  const copy = { ...oldest };
  assert.equal(imagesWithinReplayBudget(messages).has(copy), false);
  assert.equal(imagesWithinReplayBudget(messages).size, 4);
  assert.equal(IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES, 20 * 1024 * 1024);
});

test('a partial fit inside a message keeps its later images, never its earlier ones', () => {
  // With room for 7 bytes, a [6, 9] message keeps neither (the 9 is newer
  // and does not fit, and the cut-off is contiguous); a [9, 6] message
  // keeps only the 6.
  const bigThenSmall = [nineBytes(), sixBytes()];
  const smallThenBig = [sixBytes(), nineBytes()];
  assert.deepEqual([...imagesWithinReplayBudget([user('u1', bigThenSmall)], 7)], [bigThenSmall[1]]);
  assert.equal(imagesWithinReplayBudget([user('u1', smallThenBig)], 7).size, 0);
});

test('base64 padding is not counted as image bytes', () => {
  // 'AAAA' is 3 bytes; 'AAA=' is 2; 'AA==' is 1.
  const three: ImageAttachment = { mediaType: 'image/png', data: 'AAAA' };
  const two: ImageAttachment = { mediaType: 'image/png', data: 'AAA=' };
  const one: ImageAttachment = { mediaType: 'image/png', data: 'AA==' };
  const messages = [user('u1', [three]), user('u2', [two]), user('u3', [one])];
  assert.equal(imagesWithinReplayBudget(messages, 3).size, 2);
  assert.equal(imagesWithinReplayBudget(messages, 6).size, 3);
  assert.equal(imagesWithinReplayBudget(messages, 5).size, 2);
});
