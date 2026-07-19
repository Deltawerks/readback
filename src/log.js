import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { CACHE_DIR, LOG_FILE } from './config.js';

// Append-only log. Never writes to stdout — stdout is reserved for the MCP
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
