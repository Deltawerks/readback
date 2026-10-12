import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

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

// Desktop composer predictions also fire Stop, but run in ephemeral forks.
// Stop currently has no turn-trigger field, so require a matching persisted
// main-session turn. Fail silent when provenance is absent/unknown; never infer
// whether a message is a suggestion from its prose. Read metadata only, not
// assistant text (the documented last_assistant_message remains the speech).
export async function codexTurnEligibility(payload) {
  if (typeof payload?.transcript_path !== 'string' || !payload.transcript_path) {
    return { allowed: false, reason: 'no persisted chat transcript' };
  }
  const input = createReadStream(payload.transcript_path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const timer = setTimeout(() => input.destroy(new Error('metadata read timeout')), 5000);
  let sessionMatches = false;
  try {
    for await (const line of lines) {
      if (input.bytesRead > 128 * 1024 * 1024) break;
      if (!/"type"\s*:\s*"(?:session_meta|event_msg)"/.test(line)) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const meta = record.payload;
      if (record.type === 'session_meta') {
        sessionMatches = (meta?.id ?? meta?.session_id) === payload.session_id;
        if (!sessionMatches || (meta.thread_source && meta.thread_source !== 'user') ||
            (typeof meta.source === 'object' && meta.source !== null)) {
          return { allowed: false, reason: 'not a main chat session' };
        }
      }
      if (record.type !== 'event_msg' || meta?.type !== 'task_started' ||
          meta.turn_id !== payload.turn_id) continue;
      const attribution = meta.turn_attribution;
      const trigger = attribution?.turn_trigger;
      if (!sessionMatches || attribution?.initiating_agent_path ||
          (trigger != null && !['composer', 'cli', 'exec'].includes(trigger))) {
        return { allowed: false, reason: 'background or unverified turn' };
      }
      return { allowed: true };
    }
    return { allowed: false, reason: 'turn missing from chat transcript' };
  } catch {
    return { allowed: false, reason: 'chat transcript unavailable' };
  } finally {
    clearTimeout(timer);
    lines.close();
    input.destroy();
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
