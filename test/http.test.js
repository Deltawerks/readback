import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point every Readback path at a throwaway dir BEFORE anything from src/ is
// loaded: config.js resolves its locations at import time, so a late override
// would arrive after the real profile had already been picked.
const SANDBOX = mkdtempSync(path.join(tmpdir(), 'readback-http-test-'));
process.env.READBACK_STATE_DIR = SANDBOX;
process.env.READBACK_CACHE_DIR = SANDBOX;

const http = await import('../src/providers/_http.js');
const { fetchBody, bodyText, bodyJson, retryAfterMs, isRetryableStatus, isRetryableError } = http;

const realFetch = globalThis.fetch;
function restoreFetch() {
  globalThis.fetch = realFetch;
}

// A response whose headers arrive at once and whose body never does. This is
// the failure the old fetchWithTimeout could not see: it cleared its timer as
// soon as the headers landed, so a provider that accepted the request and then
// stopped sending hung the worker forever.
function stallingFetch(record) {
  return async (url, init) => {
    record.signal = init.signal;
    record.calls = (record.calls || 0) + 1;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: () =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    };
  };
}

test('the timeout covers the body, not just the headers', async (t) => {
  const record = {};
  globalThis.fetch = stallingFetch(record);
  t.after(restoreFetch);

  const started = Date.now();
  await assert.rejects(
    () => fetchBody('https://example.invalid/tts', { method: 'POST' }, 300),
    (err) => err.timeout === true,
    'a stalled body must abort on the deadline'
  );
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 250, `gave up too early: ${elapsed} ms`);
  assert.ok(elapsed < 3000, `did not give up on the deadline: ${elapsed} ms`);
  assert.equal(record.signal.aborted, true, 'the request must actually be aborted');
});

test('a whole response comes back as status, headers and a body buffer', async (t) => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    arrayBuffer: async () => Buffer.from(JSON.stringify({ hello: 'there' })),
  });
  t.after(restoreFetch);

  const res = await fetchBody('https://example.invalid/x', {}, 1000);
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.ok(Buffer.isBuffer(res.body));
  assert.equal(bodyJson(res).hello, 'there');
  assert.equal(bodyText(res), '{"hello":"there"}');
  assert.equal(bodyJson({ body: Buffer.from('not json') }), null);
});

test('only transient failures are worth repeating', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(422), false);

  assert.equal(isRetryableError(new Error('socket hang up')), true);
  assert.equal(isRetryableError(Object.assign(new Error('t'), { timeout: true })), false);
});

test('Retry-After is honored and capped', () => {
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '2' }), 500), 2000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '0' }), 500), 0);
  // A server asking for ten minutes must not wedge the worker for ten minutes.
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '600' }), 500), 5000);
  assert.equal(retryAfterMs(new Headers(), 500), 500);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'soon' }), 500), 500);

  const httpDate = new Date(Date.now() + 60000).toUTCString();
  assert.equal(retryAfterMs(new Headers({ 'retry-after': httpDate }), 500), 5000);
});
