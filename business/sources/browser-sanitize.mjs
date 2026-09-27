// HTML in, bounded plain text out.
//
// What a page says is data, never instruction. There is no path from this module's output to a
// system prompt, a tool definition or a task instruction: it becomes source text that the existing
// pipeline already treats as untrusted, and the opportunity path is where a model's reading of it
// is judged rather than obeyed. That is the property that matters, and it is a property of the
// pipeline, not of a parser.
//
// The extraction here is a stripper, not a parser, and a stripper can be defeated by markup it does
// not understand. So the guarantee is deliberately narrow and is stated as such: the result is
// text, bounded in length, with the executable and presentational parts removed. If a hostile page
// can leave residue, the residue is residue a model may read as content — which the pipeline
// already knows not to trust. A real parser belongs here if this ever becomes a boundary rather
// than a convenience.

// Removed with their contents: everything whose text is code, styling, or a control the reader must
// never see as prose. `form` is removed whole because a form is an instruction aimed at a human.
const DROP_WITH_CONTENT = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'form'];
// Removed as tags only: their text is content.
const DROP_TAG_ONLY = ['input', 'button', 'select', 'option', 'textarea', 'label'];

const stripDangerous = (html) => {
  let out = html;
  for (const tag of DROP_WITH_CONTENT) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    // An unclosed one would otherwise keep everything after it as "text".
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'gi'), ' ');
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), ' ');
  }
  for (const tag of DROP_TAG_ONLY) out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), ' ');
  return out;
};

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', middot: '·', bull: '•',
};

const decodeEntities = (text) => text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X'
      ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' ';
    try { return String.fromCodePoint(code); } catch { return ' '; }
  }
  const named = ENTITIES[body.toLowerCase()];
  return named ?? ' ';
});

// Block-level elements become line breaks so a page does not arrive as one unreadable line.
const BLOCKS = /<\/?(?:p|div|section|article|main|header|footer|nav|aside|br|hr|li|ul|ol|tr|table|h[1-6]|blockquote|pre|figure|figcaption|dl|dt|dd)\b[^>]*>/gi;
// Inline elements are removed with nothing in their place. Replacing them with a space would put
// one between every pair of words a link separated, and "here ." is the page arriving slightly
// wrong rather than the page being read correctly.
const INLINE = /<\/?(?:a|span|b|i|u|em|strong|em|code|kbd|samp|var|small|sub|sup|abbr|cite|q|time|mark|dfn|bdi|bdo|ruby|rt|rp|wbr)\b[^>]*>/gi;

const toText = (html) => {
  let out = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')   // comments
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<!doctype[^>]*>/gi, ' ');
  out = stripDangerous(out);
  out = out.replace(BLOCKS, '\n');
  out = out.replace(INLINE, '');
  out = out.replace(/<[^>]*>/g, ' ');   // every remaining tag
  out = decodeEntities(out);
  return out.replace(/[ \t\f\v ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
};

// The bound is applied last, on the character count the envelope checks, so the reader never
// builds a string the contract will refuse. A truncated page is marked rather than silently
// shortened: a reader should know the text is partial.
export function sanitizeHtml(html, maxChars) {
  const text = toText(html);
  if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
  return { text: text.slice(0, maxChars), truncated: true, originalLength: text.length };
}
