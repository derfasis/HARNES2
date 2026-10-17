// Public HTML -> bounded plain text. Parsing/entities come from the same OSS
// parser already used by GramJS. This projection never executes markup, reads
// field values, follows links, or submits a form. Source text remains untrusted.
import { Parser } from 'htmlparser2';

// A form can contain ordinary contractual prose. Discard its controls and code,
// not its entire subtree. Attributes (including action/value) are never emitted.
const DROP = new Set(['script','style','noscript','template','svg','iframe','object',
  'input','button','select','option','textarea']);
const BLOCK = new Set(['p','div','section','article','main','header','footer','nav','aside',
  'br','hr','li','ul','ol','tr','table','h1','h2','h3','h4','h5','h6','blockquote','pre',
  'figure','figcaption','dl','dt','dd','form']);

export function sanitizeHtml(html, maxChars) {
  const chunks = [];
  let dropped = 0;
  const parser = new Parser({
    onopentag(name) {
      if (dropped) { dropped++; return; }
      if (DROP.has(name)) { dropped = 1; return; }
      if (BLOCK.has(name)) chunks.push('\n');
    },
    onclosetag(name) {
      if (dropped) { dropped--; return; }
      if (BLOCK.has(name)) chunks.push('\n');
    },
    ontext(text) { if (!dropped) chunks.push(text); },
  }, { decodeEntities: true });
  parser.end(String(html));
  const text = chunks.join('').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars, originalLength: text.length };
}
