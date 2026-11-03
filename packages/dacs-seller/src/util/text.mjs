// Run-time port of http-mcp/src/util/text.mjs at DACS-Agent-commerce/frontend 15fdf23: the whole
// file.
// Grapheme clusters where Intl.Segmenter exists; whole code points otherwise.
const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const pieces = (value) => (segmenter ? Array.from(segmenter.segment(value), (part) => part.segment) : value);

// Cuts text to at most max UTF-16 units on a grapheme boundary, so a cut never
// leaves half of a surrogate pair (which canonical JSON refuses) or drops a
// combining mark or emoji joiner from the character it belongs to.
export function cutText(text, max) {
  const value = String(text);
  if (value.length <= max) return value;
  let out = '';
  for (const piece of pieces(value)) {
    if (out.length + piece.length > max) break;
    out += piece;
  }
  return out;
}
