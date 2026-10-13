// Split cleaned speech text into small, sentence-aligned chunks so the first
// audio can start after synthesizing just one short chunk (fast time-to-first-
// audio), while the rest are synthesized in the background and played back-to-back.
//
// The FIRST sentence is always its own chunk (snappiest start); later sentences
// are grouped up to maxChunk to keep the number of round-trips down.
//
// A sentence ends at . ! ? or … (and any closing quote or bracket) only where
// whitespace and then a capital, a digit or an opening quote follow, or at the
// end of the text. A bare period is not enough: src/state.js, 0.7.0, 2.5 and
// e.g. were each cut in two.
const SENTENCE = /\S[\s\S]*?[.!?…]+["'”’)\]]*(?=\s+["'“‘(\[]*[\p{Lu}\p{N}]|\s*$)|\S[\s\S]*$/gu;

export function chunkForSpeech(text, { maxChunk = 300 } = {}) {
  const t = (text || '').trim();
  if (!t) return [];

  const sentences = (t.match(SENTENCE) || [t])
    .map((s) => s.trim())
    .filter(Boolean);

  const grouped = [];
  let buf = '';
  sentences.forEach((s, idx) => {
    if (idx === 0) {
      grouped.push(s); // first sentence alone
      return;
    }
    if (!buf) buf = s;
    else if (buf.length + 1 + s.length <= maxChunk) buf += ' ' + s;
    else {
      grouped.push(buf);
      buf = s;
    }
  });
  if (buf) grouped.push(buf);

  // Hard-split any chunk still longer than maxChunk (e.g. a very long sentence
  // or text with no sentence breaks at all).
  const out = [];
  for (const c of grouped) {
    if (c.length <= maxChunk) {
      out.push(c);
      continue;
    }
    let rest = c;
    while (rest.length > maxChunk) {
      let cut = rest.lastIndexOf(' ', maxChunk);
      if (cut <= 0) cut = maxChunk;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out.filter(Boolean);
}
