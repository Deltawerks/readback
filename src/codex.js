import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

// Validate the documented Stop envelope before checking its turn provenance.
export function codexReply(payload) {
  if (!payload || payload.hook_event_name !== 'Stop') return null;
  if (payload.agent_id || payload.agent_transcript_path) return null;
  const { session_id: session, turn_id: turn, last_assistant_message: text } = payload;
  if (typeof session !== 'string' || !session.trim() || session.length > 1024) return null;
  if (typeof turn !== 'string' || !turn.trim() || turn.length > 1024) return null;
  if (typeof text !== 'string' || !text.trim()) return null;
  // Hash the complete identity so filesystem sanitizing/truncation cannot make
  // distinct sessions collide. Repeated hook delivery claims the same reply.
  const id = 'codex-' + createHash('sha256').update(JSON.stringify([session, turn])).digest('hex');
  return { id, text: text.slice(0, 200000) };
}

const TRANSCRIPT_BLOCK = 256 * 1024;
const MAX_TURN_RECORD = 1024 * 1024;
const MAX_SESSION_RECORD = 8 * 1024 * 1024;

async function sessionRecord(file, size) {
  const parts = [];
  let offset = 0;
  while (offset < size && offset < MAX_SESSION_RECORD) {
    const block = Buffer.alloc(Math.min(TRANSCRIPT_BLOCK, size - offset, MAX_SESSION_RECORD - offset));
    const { bytesRead } = await file.read(block, 0, block.length, offset);
    if (!bytesRead) break;
    const bytes = block.subarray(0, bytesRead);
    const newline = bytes.indexOf(10);
    parts.push(newline < 0 ? bytes : bytes.subarray(0, newline));
    offset += bytesRead;
    if (newline >= 0 || offset === size) return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  throw new Error('session metadata unavailable');
}

// Read newest lines first without loading the transcript or its giant tool /
// compaction records into memory. Carry bytes across blocks (not decoded text)
// so UTF-8 characters and JSON records crossing a block boundary remain intact.
// Oversized individual lines are skipped; there is no total-file-size cutoff.
async function* newestTranscriptLines(file, size) {
  let offset = size;
  let carry = Buffer.alloc(0);
  let oversized = false;
  while (offset > 0) {
    const length = Math.min(TRANSCRIPT_BLOCK, offset);
    offset -= length;
    const block = Buffer.alloc(length);
    const { bytesRead } = await file.read(block, 0, length, offset);
    if (bytesRead !== length) throw new Error('transcript changed while reading');
    let end = bytesRead;
    for (let newline = block.lastIndexOf(10, end - 1); newline >= 0;
         newline = end > 0 ? block.lastIndexOf(10, end - 1) : -1) {
      const piece = block.subarray(newline + 1, end);
      if (!oversized && piece.length + carry.length <= MAX_TURN_RECORD) {
        yield Buffer.concat([piece, carry]).toString('utf8');
      }
      carry = Buffer.alloc(0);
      oversized = false;
      end = newline;
    }
    if (!oversized && end + carry.length <= MAX_TURN_RECORD) {
      carry = Buffer.concat([block.subarray(0, end), carry]);
    } else {
      carry = Buffer.alloc(0);
      oversized = true;
    }
  }
  if (!oversized && carry.length) yield carry.toString('utf8');
}

// Desktop composer predictions also fire Stop, but run in ephemeral forks.
// Check the session identity at the beginning, then seek the matching turn from
// the end. Long-lived chats can be gigabytes; their newest turn must not be
// rejected just because older history exceeds a forward scan's byte budget.
export async function codexTurnEligibility(payload) {
  if (typeof payload?.transcript_path !== 'string' || !payload.transcript_path) {
    return { allowed: false, reason: 'no persisted chat transcript' };
  }
  let file;
  try {
    file = await open(payload.transcript_path, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) return { allowed: false, reason: 'chat transcript unavailable' };
    const record = await sessionRecord(file, stat.size);
    const meta = record.payload;
    if (record.type !== 'session_meta' || !meta ||
        (meta.id ?? meta.session_id) !== payload.session_id ||
        (meta.thread_source && meta.thread_source !== 'user') ||
        (typeof meta.source === 'object' && meta.source !== null)) {
      return { allowed: false, reason: 'not a main chat session' };
    }
    for await (const line of newestTranscriptLines(file, stat.size)) {
      if (!/"type"\s*:\s*"event_msg"/.test(line) || !line.includes(payload.turn_id)) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const turn = event.payload;
      if (event.type !== 'event_msg' || turn?.type !== 'task_started' || turn.turn_id !== payload.turn_id) continue;
      const attribution = turn.turn_attribution;
      const trigger = attribution?.turn_trigger;
      if (attribution?.initiating_agent_path ||
          (trigger != null && !['composer', 'cli', 'exec'].includes(trigger))) {
        return { allowed: false, reason: 'background or unverified turn' };
      }
      return { allowed: true };
    }
    return { allowed: false, reason: 'turn missing from chat transcript' };
  } catch {
    return { allowed: false, reason: 'chat transcript unavailable' };
  } finally {
    await file?.close();
  }
}

// Applied only to Codex messages; Claude's established speech cleanup stays as
// it is. App directives and citation bookkeeping are visual UI, not narration.
export function stripCodexMetadata(text) {
  return text
    .replace(/<oai-mem-citation\b[^>]*>[\s\S]*?(?:<\/oai-mem-citation>|$)/gi, ' ')
    .replace(/\uE200[^\uE201]*\uE201/g, ' ')
    .replace(/^\s*::[a-z][a-z0-9-]*\{[^\n]*\}\s*$/gim, ' ')
    .replace(/:codex-followup\[([^\]]*)\]\{[^\n]*?\}/g, '$1');
}

export async function readHookInput(stream, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > maxBytes) throw new Error('hook payload exceeds size limit');
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
