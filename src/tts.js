import { getApiKey } from './config.js';
import { getProvider } from './providers/index.js';
import { activeConfig } from './state.js';

// Turn a Markdown reply into something that sounds natural read aloud:
// drop code, flatten links, strip formatting markers and emoji.
export function stripForSpeech(md) {
  if (!md) return '';
  let t = String(md);

  t = t.replace(/```[\s\S]*?```/g, ' ');          // fenced code blocks
  t = t.replace(/~~~[\s\S]*?~~~/g, ' ');           // alt fenced code blocks
  t = t.replace(/`([^`]+)`/g, '$1');               // inline code -> content
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');     // images -> drop
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');   // links -> link text
  t = t.replace(/\bhttps?:\/\/\S+/gi, 'link');     // bare URLs -> "link"
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');        // ATX headers
  t = t.replace(/^\s*>\s?/gm, '');                 // blockquotes
  t = t.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, ' '); // horizontal rules
  t = t.replace(/^\s*[-*+]\s+/gm, '');             // bullet markers
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');           // numbered markers
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');        // bold
  t = t.replace(/(\*|_)(.*?)\1/g, '$2');           // italic
  t = t.replace(/~~(.*?)~~/g, '$1');               // strikethrough
  t = t.replace(/^\s*\|?[-:\s|]+\|?\s*$/gm, ' ');  // table separator rows
  t = t.replace(/\|/g, ' ');                       // table cell pipes
  // Strip emoji / pictographs / arrows / variation selectors, preserving smart
  // quotes (‘-”), en/em dashes (–-—) and the ellipsis (…).
  t = t.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{2000}-\u{200F}]/gu,
    ''
  );

  t = t.replace(/[ \t]+/g, ' ');                   // collapse spaces
  t = t.replace(/\n{2,}/g, '\n');                  // collapse blank lines
  t = t
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('. ');
  t = t.replace(/([.!?:;,])\.\s/g, '$1 ');         // avoid ":. " / "?. "
  t = t.replace(/\.\s*\.\s*/g, '. ');              // collapse ".. "
  return t.trim();
}

// Keep spoken output to a sane length; long replies get a spoken tail note.
export function truncateForSpeech(text, maxChars = 1800) {
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
