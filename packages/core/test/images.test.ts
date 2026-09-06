import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT,
  IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES,
  imageDimensions,
  imagesWithinReplayBudget,
  omitImagesOutsideReplayBudget,
  type ImageAttachment,
  type Message,
} from '../src/index.ts';

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
  const twelve = imagesWithinReplayBudget(messages, { bytes: 12 });
  assert.deepEqual([...twelve], [newestB, newestA]);
  assert.notDeepEqual(newestA, newestB);

  // 6 bytes: only the later of the newest message's two images — the
  // budget is newest-first inside a message too, not first-listed.
  const six = imagesWithinReplayBudget(messages, { bytes: 6 });
  assert.deepEqual([...six], [newestB]);

  // 21 bytes: the middle one fits too, and the oldest would as well on its
  // own — but the cut-off is contiguous, so it is out (21 - 12 - 9 = 0).
  const twentyOne = imagesWithinReplayBudget(messages, { bytes: 21 });
  assert.equal(twentyOne.has(middle), true);
  assert.equal(twentyOne.has(oldest), false);

  // 27 bytes: everything.
  assert.equal(imagesWithinReplayBudget(messages, { bytes: 27 }).size, 4);

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
  assert.deepEqual([...imagesWithinReplayBudget([user('u1', bigThenSmall)], { bytes: 7 })], [bigThenSmall[1]]);
  assert.equal(imagesWithinReplayBudget([user('u1', smallThenBig)], { bytes: 7 }).size, 0);
});

test('base64 padding is not counted as image bytes', () => {
  // 'AAAA' is 3 bytes; 'AAA=' is 2; 'AA==' is 1.
  const three: ImageAttachment = { mediaType: 'image/png', data: 'AAAA' };
  const two: ImageAttachment = { mediaType: 'image/png', data: 'AAA=' };
  const one: ImageAttachment = { mediaType: 'image/png', data: 'AA==' };
  const messages = [user('u1', [three]), user('u2', [two]), user('u3', [one])];
  assert.equal(imagesWithinReplayBudget(messages, { bytes: 3 }).size, 2);
  assert.equal(imagesWithinReplayBudget(messages, { bytes: 6 }).size, 3);
  assert.equal(imagesWithinReplayBudget(messages, { bytes: 5 }).size, 2);
});

test('the replay budget also counts images, newest first, whatever they weigh', () => {
  const messages = [1, 2, 3].map((n) => user(`u${n}`, [sixBytes(), sixBytes()]));
  // Bytes would allow all six; a count of three keeps the newest message
  // whole and one of the middle one's — its later one.
  const three = imagesWithinReplayBudget(messages, { bytes: 1000, count: 3 });
  assert.equal(three.size, 3);
  assert.equal(three.has(messages[2]!.images![0]!), true);
  assert.equal(three.has(messages[2]!.images![1]!), true);
  assert.equal(three.has(messages[1]!.images![1]!), true);
  assert.equal(three.has(messages[1]!.images![0]!), false);
  // The default is the count past which the Messages API shrinks what each
  // image may measure below what was accepted on arrival.
  assert.equal(IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT, 20);
  const many = Array.from({ length: 21 }, (_, n) => user(`m${n}`, [sixBytes()]));
  assert.equal(imagesWithinReplayBudget(many).size, 20);
  assert.equal(imagesWithinReplayBudget(many).has(many[0]!.images![0]!), false);
});

test('storing a turn lets go of the bytes outside the replay window and keeps the record', () => {
  const oldest = { ...sixBytes(), name: 'first.png' };
  const middle = sixBytes();
  const newest = sixBytes();
  const messages = [user('u1', [oldest]), user('u2', [middle]), user('u3', [newest])];

  assert.equal(omitImagesOutsideReplayBudget(messages, { bytes: 12 }), 1);
  assert.deepEqual(messages[0]!.images, [{ mediaType: 'image/png', data: '', omitted: true, name: 'first.png' }]);
  assert.deepEqual(messages[1]!.images, [middle]);
  assert.deepEqual(messages[2]!.images, [newest]);

  // Idempotent, and an omitted image costs the next window nothing: the
  // same budget now keeps the same two.
  assert.equal(omitImagesOutsideReplayBudget(messages, { bytes: 12 }), 0);
  const kept = imagesWithinReplayBudget(messages, { bytes: 12 });
  assert.equal(kept.size, 2);
  assert.equal(kept.has(messages[0]!.images![0]!), false);

  // A message without images is left exactly as it was.
  const bare = user('u4');
  omitImagesOutsideReplayBudget([bare], { bytes: 12 });
  assert.equal('images' in bare, false);
});

/** The smallest thing that opens and closes like a PNG: signature, IHDR, IEND. */
const pngHeader = (width: number, height: number): Uint8Array => {
  const bytes = Buffer.alloc(36);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.write('IEND', 28, 'ascii');
  bytes.set([0xae, 0x42, 0x60, 0x82], 32);
  return bytes;
};

test('image dimensions are read from the header of each accepted format', () => {
  assert.deepEqual(imageDimensions(pngHeader(640, 480), 'image/png'), { width: 640, height: 480 });
  assert.deepEqual(imageDimensions(pngHeader(9000, 1), 'image/png'), { width: 9000, height: 1 });

  const gif = Buffer.alloc(11);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(200, 8);
  gif[10] = 0x3b;
  assert.deepEqual(imageDimensions(gif, 'image/gif'), { width: 320, height: 200 });

  // JPEG: SOI, an APP0 segment to step over, SOF0 with the size, then EOI.
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xf4, 0x03, 0x20, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  assert.deepEqual(imageDimensions(jpeg, 'image/jpeg'), { width: 800, height: 500 });

  const webp = (chunk: string, payload: number[]): Uint8Array => {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF', 0, 'ascii');
    bytes.writeUInt32LE(22, 4);
    bytes.write('WEBP', 8, 'ascii');
    bytes.write(chunk, 12, 'ascii');
    bytes.set(payload, 20);
    return bytes;
  };
  // VP8X: flags + reserved, then width-1 and height-1 as 24-bit LE.
  assert.deepEqual(imageDimensions(webp('VP8X', [0, 0, 0, 0, 0x1f, 0x03, 0x00, 0xff, 0x01, 0x00]), 'image/webp'), { width: 800, height: 512 });
  // VP8L: signature, then 14 bits of width-1 and 14 of height-1.
  assert.deepEqual(imageDimensions(webp('VP8L', [0x2f, 0x1f, 0xc3, 0x7f, 0x00]), 'image/webp'), { width: 800, height: 512 });
  // VP8: frame tag, start code, then 14-bit width and height.
  const vp8 = Buffer.alloc(10);
  vp8.set([0, 0, 0, 0x9d, 0x01, 0x2a], 0);
  vp8.writeUInt16LE(800, 6);
  vp8.writeUInt16LE(512, 8);
  assert.deepEqual(imageDimensions(webp('VP8 ', [...vp8]), 'image/webp'), { width: 800, height: 512 });

  // Bytes that are not what their type says have no size, and neither does
  // a header cut short or a body that never reaches its trailer — the shape
  // of a download that stopped early.
  assert.equal(imageDimensions(pngHeader(1, 1), 'image/jpeg'), undefined);
  assert.equal(imageDimensions(pngHeader(1, 1).subarray(0, 20), 'image/png'), undefined);
  assert.equal(imageDimensions(Buffer.concat([pngHeader(1, 1), Buffer.alloc(4)]), 'image/png'), undefined);
  assert.equal(imageDimensions(jpeg.subarray(0, jpeg.length - 2), 'image/jpeg'), undefined);
  assert.equal(imageDimensions(gif.subarray(0, 10), 'image/gif'), undefined);
  assert.equal(imageDimensions(Buffer.from('GIF8'), 'image/gif'), undefined);
  assert.equal(imageDimensions(webp('ALPH', []), 'image/webp'), undefined);
  assert.equal(imageDimensions(Buffer.concat([webp('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(1)]), 'image/webp'), undefined);
  assert.equal(IMAGE_ATTACHMENT_MAX_DIMENSION, 8000);
});
