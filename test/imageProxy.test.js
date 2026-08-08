import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedImage, proxyUrl, serveImage, sniffImageType } from '../server/lib/imageProxy.js';

const OK = 'https://media.printables.com/media/prints/1/a.webp';

/** Real file signatures, padded past the sniff window. */
const SIGNATURES = {
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]),
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(20),
  ]),
  gif: Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(20)]),
  webp: Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'latin1'),
    Buffer.alloc(20),
  ]),
  avif: Buffer.concat([
    Buffer.alloc(4),
    Buffer.from('ftypavif', 'latin1'),
    Buffer.alloc(20),
  ]),
  html: Buffer.from('<!doctype html><script>alert(1)</script>          ', 'latin1'),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'latin1'),
};

/** Just enough ServerResponse to record what a handler decided. */
function fakeResponse() {
  const chunks = [];
  return {
    status: null,
    headers: {},
    body: () => Buffer.concat(chunks).toString('utf8'),
    bytes: () => Buffer.concat(chunks).length,
    headersSent: false,
    ended: false,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
      );
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    once() {},
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.ended = true;
    },
  };
}

/**
 * Replace fetch with a scripted sequence and record every URL it was asked for.
 * The call log is half the point: proving a blocked redirect was never followed
 * needs evidence that no request went out, not just a non-200 at the end.
 */
function withFetch(script, run) {
  const original = globalThis.fetch;
  const calls = [];
  let index = 0;

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const step = typeof script === 'function' ? script(String(url)) : script[index++];
    if (!step) throw new Error(`unscripted fetch: ${url}`);
    return new Response(step.body ?? null, {
      status: step.status ?? 200,
      headers: step.headers ?? {},
    });
  };

  return (async () => {
    try {
      return { value: await run(), calls };
    } finally {
      globalThis.fetch = original;
    }
  })();
}

const image = (kind = 'webp', declared = 'image/webp') => ({
  status: 200,
  body: SIGNATURES[kind],
  headers: { 'content-type': declared },
});

const redirect = (to, status = 302) => ({ status, headers: { location: to } });

/* --- Allowlist ----------------------------------------------------------- */

test('isAllowedImage matches the host exactly, not by substring', () => {
  assert.equal(isAllowedImage(OK), true);
  assert.equal(isAllowedImage('https://MEDIA.PRINTABLES.COM/a.webp'), true);

  for (const hostile of [
    'https://evil.com/media.printables.com/a.webp',
    'https://media.printables.com.evil.com/a.webp',
    'https://media.printables.com@evil.com/a.webp',
    'https://media.printables.com./a.webp',
    'http://media.printables.com/a.webp',
    'file:///etc/passwd',
    'not a url',
    '',
  ]) {
    assert.equal(isAllowedImage(hostile), false, `${hostile} should be refused`);
  }
});

test('proxyUrl encodes the target so it cannot break out of the query', () => {
  assert.equal(proxyUrl('https://media.printables.com/a b.webp?x=1&y=2'),
    '/img?u=https%3A%2F%2Fmedia.printables.com%2Fa%20b.webp%3Fx%3D1%26y%3D2');
});

/* --- Redirects ----------------------------------------------------------- */

test('a redirect off the allowlist is refused and never fetched', async () => {
  const response = fakeResponse();
  const { calls } = await withFetch([redirect('https://evil.com/x.webp')], () =>
    serveImage(OK, response),
  );

  assert.equal(response.status, 400);
  assert.equal(calls.length, 1, 'the hop off the allowlist must not be requested');
  // By hostname, not by substring: `includes` would also have passed for a URL
  // that merely mentions the host, such as https://media.printables.com/evil.com,
  // which is the one shape this assertion most needs to tell apart.
  assert.ok(!calls.some((url) => new URL(url).hostname === 'evil.com'));
});

test('a redirect that stays on the allowlist is followed', async () => {
  const response = fakeResponse();
  const target = 'https://cdn.thingiverse.com/other.png';
  const { calls } = await withFetch([redirect(target), image('png', 'image/png')], () =>
    serveImage(OK, response),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [OK, target]);
});

test('a relative redirect is resolved against the current URL and re-checked', async () => {
  const response = fakeResponse();
  const { calls } = await withFetch([redirect('/resized/a.webp'), image()], () =>
    serveImage(OK, response),
  );

  assert.equal(response.status, 200);
  assert.equal(calls[1], 'https://media.printables.com/resized/a.webp');
});

test('a redirect downgrading to http is refused', async () => {
  const response = fakeResponse();
  const { calls } = await withFetch([redirect('http://media.printables.com/a.webp')], () =>
    serveImage(OK, response),
  );

  assert.equal(response.status, 400);
  assert.equal(calls.length, 1);
});

test('a redirect loop stops at the hop limit instead of running forever', async () => {
  const response = fakeResponse();
  const { calls } = await withFetch(() => redirect(OK), () => serveImage(OK, response));

  assert.equal(response.status, 502);
  assert.ok(calls.length <= 4, `expected at most 4 requests, made ${calls.length}`);
});

test('a redirect without a location header fails instead of hanging', async () => {
  const response = fakeResponse();
  await withFetch([{ status: 302 }], () => serveImage(OK, response));
  assert.equal(response.status, 502);
});

/* --- Content type -------------------------------------------------------- */

test('sniffImageType recognises the five formats and nothing else', () => {
  assert.equal(sniffImageType(SIGNATURES.jpeg), 'image/jpeg');
  assert.equal(sniffImageType(SIGNATURES.png), 'image/png');
  assert.equal(sniffImageType(SIGNATURES.gif), 'image/gif');
  assert.equal(sniffImageType(SIGNATURES.webp), 'image/webp');
  assert.equal(sniffImageType(SIGNATURES.avif), 'image/avif');

  // The two that would execute on this origin, and some near-misses.
  assert.equal(sniffImageType(SIGNATURES.html), null);
  assert.equal(sniffImageType(SIGNATURES.svg), null);
  assert.equal(sniffImageType(Buffer.from('RIFF____NOPE________', 'latin1')), null);
  assert.equal(sniffImageType(Buffer.alloc(20)), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  assert.equal(sniffImageType(undefined), null);
});

/**
 * MakerWorld's CDN labels a good half of its thumbnails `application/octet-stream`,
 * so trusting the declared type is not an option in either direction: it is both
 * attacker-influenced and, on a real source, simply wrong.
 */
test('the served type comes from the bytes, not from what the upstream claimed', async () => {
  for (const [kind, declared, expected] of [
    ['webp', 'image/webp', 200],
    ['png', 'application/octet-stream', 200],
    ['jpeg', '', 200],
    ['gif', 'text/html', 200],
    // A declared image type does not rescue content that is not one.
    ['html', 'image/png', 415],
    ['svg', 'image/svg+xml', 415],
    ['html', 'text/html', 415],
  ]) {
    const response = fakeResponse();
    await withFetch([image(kind, declared)], () => serveImage(OK, response));
    assert.equal(response.status, expected, `${kind} declared as "${declared}"`);

    if (expected === 200) {
      assert.equal(response.headers['content-type'], `image/${kind}`);
    }
  }
});

test('a served image carries the headers that stop it being treated as markup', async () => {
  const response = fakeResponse();
  await withFetch([image()], () => serveImage(OK, response));

  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(response.headers['content-security-policy'], "default-src 'none'");
});

test('an oversized image is refused on its declared length', async () => {
  const response = fakeResponse();
  await withFetch(
    [{ status: 200, body: SIGNATURES.webp, headers: { 'content-type': 'image/webp', 'content-length': String(64 * 1024 * 1024) } }],
    () => serveImage(OK, response),
  );

  assert.equal(response.status, 413);
});

/* --- Failure modes ------------------------------------------------------- */

/**
 * A `.pipe()` here would leave the readable's `error` event unhandled, which in
 * Node is an uncaught exception and a dead process — triggerable by any remote
 * party that resets a connection. Both cases below have to resolve, not reject.
 */
async function serveErroringStream(response, prefix) {
  let delivered = false;
  const body = new ReadableStream({
    // Delivered through pull, not enqueued in start: calling error() resets the
    // queue, so a chunk enqueued alongside it never reaches the reader at all.
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(prefix);
        return;
      }
      controller.error(new Error('connection reset'));
    },
  });

  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'image/webp' } });

  try {
    await serveImage(OK, response);
  } finally {
    globalThis.fetch = original;
  }
}

test('an upstream that dies mid-transfer is answered, not crashed into', async () => {
  // Once with too few bytes to have judged the type, once with a whole
  // signature already buffered.
  for (const prefix of [new TextEncoder().encode('part'), SIGNATURES.webp]) {
    const response = fakeResponse();

    // Resolving rather than rejecting *is* the assertion: the failure mode this
    // guards against is an unhandled 'error' event, which ends the process
    // rather than the request.
    await serveErroringStream(response, prefix);

    assert.equal(response.ended, true, 'the response must be closed');
    // Either 502 (nothing sent yet) or a truncated 200 (headers already out).
    // Which one depends on how much the reader had buffered when the reset
    // landed, and that is Node's readahead to decide, not this code.
    assert.ok([200, 502].includes(response.status), `unexpected status ${response.status}`);
  }
});

test('a refused image says so in plain text and is not cached', async () => {
  const response = fakeResponse();
  await serveImage('https://evil.com/a.webp', response);

  assert.equal(response.status, 400);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.body(), /not allowed/i);
});
