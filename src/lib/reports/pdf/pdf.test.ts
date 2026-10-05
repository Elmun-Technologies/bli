/**
 * PDF input validation tests: the images a report may embed.
 *
 * The rendered PDF itself is verified end-to-end by `npm run smoke:reports`,
 * which downloads the bytes of a real report from the shipped route and reads
 * its text content. That is deliberate: `@react-pdf/renderer` is an ESM-only
 * package whose CJS path cannot be loaded by the `tsx` test runner (the library
 * requires `@react-pdf/hyphenate/en-us`, which its `exports` map exposes for
 * `import` only), while the production Next.js server loads it natively. Keeping
 * the renderer out of the unit-test graph keeps `npm test` dependency-free and
 * the smoke authoritative.
 *
 * What *is* unit-tested here is everything the renderer consumes: the bytes must
 * really be a PNG or a JPEG, the size limit is enforced, and SVG (or any other
 * scriptable/vector format) can never reach the document.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeMapFixturePng } from '../map/fixture-png';
import { isAcceptableLogo, REPORT_LOGO_MAX_BYTES, sniffImage, toDocumentImage } from './image';

const PNG = fakeMapFixturePng();
const JPEG_PREFIX = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const HTML = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');

test('the real fixture PNG is recognised, with its dimensions', () => {
  const sniffed = sniffImage(PNG);
  assert.ok(sniffed);
  assert.equal(sniffed.format, 'image/png');
  assert.equal(sniffed.width, 640);
  assert.equal(sniffed.height, 360);
});

test('a JPEG is recognised by its bytes, not by a name or a declared type', () => {
  const sniffed = sniffImage(JPEG_PREFIX);
  assert.ok(sniffed);
  assert.equal(sniffed.format, 'image/jpeg');
  assert.equal(sniffed.width, null);
});

test('SVG, HTML and text are never accepted as images', () => {
  for (const bytes of [SVG, HTML, new TextEncoder().encode('plain text'), new Uint8Array([0x00])]) {
    assert.equal(sniffImage(bytes), null);
    assert.equal(isAcceptableLogo(bytes), false);
    assert.equal(toDocumentImage(bytes), null);
  }
});

test('the logo limit is enforced on the bytes and nothing else', () => {
  assert.equal(isAcceptableLogo(PNG), true);
  assert.equal(isAcceptableLogo(new Uint8Array()), false);
  assert.equal(isAcceptableLogo(new Uint8Array(REPORT_LOGO_MAX_BYTES + 1)), false);

  const oversized = new Uint8Array(REPORT_LOGO_MAX_BYTES + 1);
  oversized.set(PNG.subarray(0, 8));
  assert.equal(isAcceptableLogo(oversized), false, 'a PNG header cannot smuggle an oversized file');

  const atLimit = new Uint8Array(REPORT_LOGO_MAX_BYTES);
  atLimit.set(PNG.subarray(0, 8));
  // A PNG header at exactly the limit passes the sniff, and is a pixel-less PNG:
  // the renderer, not this module, decides whether it can be drawn.
  assert.equal(isAcceptableLogo(atLimit), true);
});

test('document images carry a Node Buffer and the documented format token', () => {
  const image = toDocumentImage(PNG);
  assert.ok(image);
  assert.equal(image.format, 'png');
  assert.ok(Buffer.isBuffer(image.data));
  assert.equal(image.data.byteLength, PNG.byteLength);

  const jpeg = toDocumentImage(JPEG_PREFIX);
  assert.ok(jpeg);
  assert.equal(jpeg.format, 'jpg');

  assert.equal(toDocumentImage(null), null);
  assert.equal(toDocumentImage(new Uint8Array()), null);
});
