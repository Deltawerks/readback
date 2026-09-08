export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const REQUEST_TIMEOUT_MS = 20000;
// A server can ask for a longer pause than we are willing to hold a reply for.
export const MAX_RETRY_WAIT_MS = 5000;
const RETRY_BASE_MS = 500;
const RETRY_ATTEMPTS = 3;

// Raised for our own deadline, and for any abort the runtime reports. The flag
// is what the retry policy keys off: an aborted request has to stay abandoned.
export class HttpTimeoutError extends Error {
  constructor(ms) {
    super(`request timed out after ${ms} ms`);
    this.name = 'HttpTimeoutError';
    this.timeout = true;
  }
}

// Fetch a WHOLE response under one deadline: headers and body.
//
// The old helper cleared its timer as soon as the headers arrived, which meant a
// provider that answered 200 and then stopped sending held the worker open for
// as long as it liked. The timer stays armed here until the body is in hand.
export async function fetchBody(url, options, ms = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    const body = Buffer.from(await resp.arrayBuffer());
    return { ok: resp.ok, status: resp.status, headers: resp.headers, body };
  } catch (err) {
    if (ctrl.signal.aborted || (err && err.name === 'AbortError')) throw new HttpTimeoutError(ms);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function bodyText(res) {
  return res && res.body ? res.body.toString('utf8') : '';
}

// Convenience for the JSON endpoints. Returns null rather than throwing, so the
// caller can raise its own error about what was missing from the payload.
export function bodyJson(res) {
  try {
    return JSON.parse(bodyText(res));
  } catch {
    return null;
  }
}

// A 4xx that is not 429 will fail identically next time, so repeating it only
// delays the error the user needs to read.
export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

// A network-level rejection (DNS, reset, TLS) is worth one more try. Our own
// timeout is not: ElevenLabs bills on generation, so re-sending text we already
// walked away from can be charged twice.
export function isRetryableError(err) {
  return !(err && err.timeout);
}

// Honor Retry-After (delta-seconds or an HTTP date) when the server sends one,
// capped so a rate limit cannot hold a reply hostage for minutes.
export function retryAfterMs(headers, fallback = RETRY_BASE_MS) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback;
  const cap = (ms) => Math.min(MAX_RETRY_WAIT_MS, Math.max(0, ms));
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return cap(seconds * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return cap(when - Date.now());
  return fallback;
}

// One request with the only repeats worth making. `errorFor` builds the
// provider's own error from a failed response, so both providers share this
// policy while keeping their own wording.
export async function requestWithRetry(url, init, { timeoutMs = REQUEST_TIMEOUT_MS, attempts = RETRY_ATTEMPTS, errorFor } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchBody(url, init, timeoutMs);
    } catch (err) {
      if (attempt >= attempts || !isRetryableError(err)) throw err;
      await sleep(RETRY_BASE_MS);
      continue;
    }
    if (res.ok) return res;
    const err = errorFor(res);
    if (attempt >= attempts || !isRetryableStatus(res.status)) throw err;
    await sleep(retryAfterMs(res.headers, RETRY_BASE_MS));
  }
}

// Wrap raw little-endian PCM (16-bit) in a minimal WAV/RIFF container so Windows
// SoundPlayer (WAV-only) can play it. Used for providers that return raw PCM.
export function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
