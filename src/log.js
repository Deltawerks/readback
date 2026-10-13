import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { CACHE_DIR, LOG_FILE } from './config.js';

// Append-only log. Never writes to stdout; stdout is reserved for the MCP
// protocol on the server, and any stray output there breaks the transport.
export function log(...args) {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const stamp = new Date().toISOString();
    const body = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    appendFileSync(LOG_FILE, `[${stamp}] ${body}\n`);
  } catch {
    // logging must never throw
  }
}

// What an error can say in the log without saying what it was about. A JSON
// parse error quotes its input (a reply, a hook payload), so it is named only;
// a provider's message keeps its status line ("Inworld TTS 401") and drops the
// response body after it.
export function errorText(err) {
  if (!err || typeof err !== 'object') return String(err);
  if (err instanceof SyntaxError) return 'SyntaxError (input not logged)';
  if (err.fromProvider) return String(err.message).replace(/^(.*?\b\d{3}): [\s\S]*$/, '$1').slice(0, 160);
  return String(err.message || err.code || err.name || 'Error').slice(0, 200);
}
