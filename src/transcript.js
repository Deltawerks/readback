import { readFileSync } from 'node:fs';

// Given the raw JSONL contents of a Claude Code transcript, return the text of
// the most recent assistant message (concatenating its text blocks). Tool calls
// and tool results are ignored. Returns '' if none is found.
export function extractLastAssistantText(rawJsonl) {
  if (!rawJsonl) return '';
  const lines = rawJsonl.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    // Skip subagent / Task-tool turns; they carry isSidechain:true but still
    // have role "assistant". We only want the MAIN agent's reply spoken.
    if (obj.isSidechain === true) continue;

    const msg = obj.message || obj;
    const role = msg.role || obj.type;
    if (role !== 'assistant') continue;

    const content = msg.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }
    if (text) return text;
  }
  return '';
}

export function lastAssistantText(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  return extractLastAssistantText(raw);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

// Return { text, id } for the CURRENT turn's assistant reply, but only once it
// has actually been flushed to the transcript, i.e. the newest assistant text
// entry comes AFTER the newest user-role entry (the prompt or the last
// tool_result). Returns null if the reply isn't written yet, which happens
// because the Stop hook can fire before Claude Code persists the final message.
// Scans backward and stops at the first user entry, so it's cheap on big files.
export function currentReply(rawJsonl) {
  if (!rawJsonl) return null;
  const lines = rawJsonl.split(/\r?\n/).filter(Boolean);
  let lastAsst = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o.isSidechain === true) continue; // skip subagent turns
    const msg = o.message || o;
    const role = msg.role || o.type;
    if (role === 'user') {
      // Reached the last user entry: ready iff we already found assistant text
      // after it (i.e. while scanning backward from the end).
      return lastAsst;
    }
    if (role === 'assistant' && !lastAsst) {
      const text = extractText(msg.content);
      if (text) lastAsst = { text, id: o.uuid || o.id || text.slice(0, 80) };
    }
  }
  return lastAsst;
}
