import { getApiKey } from './config.js';
import { getProvider } from './providers/index.js';
import { activeConfig } from './state.js';

// Past this, the input is a paste rather than a reply. Every rule below scans
// the whole string, so the cap has to come before that work, not after: callers
// apply their own maxChars to the RESULT, which is too late to matter.
const MAX_STRIP_CHARS = 200000;

// Marks a sentence boundary the Markdown implied and the plain text will not:
// the start of a list item or a table row, and both ends of a heading, which is
// a block of its own. It replaces the marker that said so, survives the rules
// that follow, and is stripped when the lines are joined back together.
const BREAK = '\u0000';

// Turn a Markdown reply into something that sounds natural read aloud:
// drop code, flatten links, strip formatting markers and emoji.
export function stripForSpeech(md) {
  if (!md) return '';
  let t = String(md).slice(0, MAX_STRIP_CHARS);

  t = t.replace(/```[\s\S]*?```/g, ' ');          // fenced code blocks
  t = t.replace(/~~~[\s\S]*?~~~/g, ' ');           // alt fenced code blocks
  t = t.replace(/`([^`]+)`/g, '$1');               // inline code -> content
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');     // images -> drop
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');   // links -> link text
  t = t.replace(/\bhttps?:\/\/\S+/gi, 'link');     // bare URLs -> "link"
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, `${BREAK}$1${BREAK}`); // ATX headers
  t = t.replace(/^\s*>\s?/gm, '');                 // blockquotes
  t = t.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, ' '); // horizontal rules
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, BREAK);    // bullet markers
  t = t.replace(/^[ \t]*\d+[.)][ \t]+/gm, BREAK);  // numbered markers
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');        // bold
  t = t.replace(/\*([^*\n]+?)\*/g, '$1');          // *italic*
  // The underscore form needs word boundaries on both sides, or it eats the
  // underscores out of every snake_case identifier in the reply and speaks
  // "read_state_file" as "readstatefile".
  t = t.replace(/(?<![A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])/g, '$1');
  t = t.replace(/~~(.*?)~~/g, '$1');               // strikethrough
  // One character class, no overlapping repeats. The old rule interleaved
  // \s* / [-:\s|]+ / \s*, which backtracks cubically: 5000 spaces took 40
  // seconds, on every reply, before any length cap could help.
  t = t.replace(/^[-:| \t]+$/gm, ' ');             // table separator rows
  t = t.replace(/^(?=[^\n]*\|)/gm, BREAK);         // table rows are separate records
  t = t.replace(/\|/g, ' ');                       // table cell pipes
  // Strip emoji / pictographs / arrows / variation selectors, preserving smart
  // quotes, en and em dashes, and the ellipsis.
  t = t.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{2000}-\u{200F}]/gu,
    ''
  );

  t = t.replace(/[ \t]+/g, ' ');                   // collapse spaces
  t = joinLines(t);
  t = t.replace(/([.!?:;,])\.\s/g, '$1 ');         // avoid ":. " / "?. "
  t = t.replace(/\.\s*\.\s*/g, '. ');              // collapse ".. "
  return t.trim();
}

// Put the surviving lines back together as speech.
//
// A blank line, a heading, a list item or a table row is a real break and earns
// a full stop. A single newline between two lines of a paragraph is only where
// the text happened to wrap: reading a full stop there puts one in the middle of
// a sentence, and the chunker then cuts the audio at the same place.
function joinLines(t) {
  let out = '';
  let pendingBreak = false;

  for (const raw of t.split('\n')) {
    let line = raw.trim();
    let forced = false;
    let closes = false;
    while (line.startsWith(BREAK)) {
      forced = true;
      line = line.slice(BREAK.length).trim();
    }
    while (line.endsWith(BREAK)) {
      closes = true;
      line = line.slice(0, -BREAK.length).trim();
    }
    if (!line) {
      pendingBreak = true;
      continue;
    }
    if (out) {
      const endsSentence = /[.!?:;…]["'”’)\]]?$/.test(out);
      out += (forced || pendingBreak) && !endsSentence ? `. ${line}` : ` ${line}`;
    } else {
      out = line;
    }
    pendingBreak = closes;
  }

  return out.replaceAll(BREAK, '');
}

// Keep spoken output to a sane length; long replies get a spoken tail note.
// The default matches config's maxChars, so a caller that omits it does not
// silently cut at a limit nobody configured.
export function truncateForSpeech(text, maxChars = 12000) {
  if (!text || text.length <= maxChars) return text || '';
  let cut = text.slice(0, maxChars);
  const lastPunct = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? ')
  );
  if (lastPunct > maxChars * 0.6) {
    cut = cut.slice(0, lastPunct + 1);
  } else {
    const sp = cut.lastIndexOf(' ');
    if (sp > 0) cut = cut.slice(0, sp);
  }
  return `${cut.trim()} … the rest is on screen.`;
}

// Synthesize via the active provider. Returns WAV bytes (Inworld LINEAR16 is
// already WAV; ElevenLabs PCM is wrapped in a WAV header) so the streaming
// player is provider-agnostic.
export async function synthesize(text, state) {
  const provider = getProvider(state.provider);
  const cfg = activeConfig(state);
  const key = getApiKey(state.provider);
  return provider.synthesize(text, cfg, key);
}

// List voices from the active provider.
export async function listVoices(state, opts) {
  const provider = getProvider(state.provider);
  const key = getApiKey(state.provider);
  return provider.listVoices(key, opts);
}
