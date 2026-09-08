// One atomic claim per reply id, so a reply is spoken exactly once however
// many Stop-hook workers race for it. Creating a file with the wx flag either
// succeeds for exactly one process or fails with EEXIST for every other; there
// is no read-then-write window to lose. The previous claim was a shared slot in
// runtime.json plus a 60 ms settle, which dropped a reply whenever two projects
// finished within 60 ms of each other, and spoke a reply twice when duplicate
// hook fires were further apart than that.
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './config.js';

export const CLAIMS_DIR = path.join(CACHE_DIR, 'claims');
const MAX_CLAIM_AGE_MS = 24 * 60 * 60 * 1000;

function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || '_';
}

export function isClaimed(id) {
  return existsSync(path.join(CLAIMS_DIR, safeName(id)));
}

// True if this process won the claim for this reply.
export function claim(id) {
  if (!existsSync(CLAIMS_DIR)) mkdirSync(CLAIMS_DIR, { recursive: true });
  try {
    writeFileSync(path.join(CLAIMS_DIR, safeName(id)), String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    // Any other failure fails open: a bookkeeping error must never silence a
    // reply. At worst a duplicate fire speaks it twice.
    return true;
  }
}

// Claims only need to outlive the window in which a duplicate fire could
// arrive; a day is generous. Called opportunistically by the worker.
export function cleanOldClaims(now = Date.now()) {
  let names;
  try {
    names = readdirSync(CLAIMS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(CLAIMS_DIR, name);
    try {
      if (now - statSync(file).mtimeMs > MAX_CLAIM_AGE_MS) unlinkSync(file);
    } catch {
      // someone else cleaned it
    }
  }
}
