import { createHash } from 'node:crypto';

// Codex's documented Stop payload is our interface, not its private transcript
// format. Ignore other lifecycle events, missing text and unidentified turns.
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
