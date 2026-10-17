import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const bootstrap = source.slice(0, source.indexOf("document.addEventListener('click'"));

function renderKnowledge(knowledge) {
  const context = vm.createContext({ console, Date, Map, JSON, Promise,
    document: { querySelector: () => ({}), querySelectorAll: () => [] } });
  vm.runInContext(bootstrap + `
    globalThis.panel=(title,body)=>'<section><h2>'+esc(title)+'</h2>'+body+'</section>';
    globalThis.empty=(title,body)=>'<p><strong>'+esc(title)+'</strong>'+esc(body)+'</p>';
    globalThis.badge=status=>'<span class="badge">'+esc(status)+'</span>';
    globalThis.button=(title)=>'<button>'+esc(title)+'</button>';
    globalThis.renderKnowledge=experience;
  `, context);
  context.knowledgeFixture = knowledge;
  vm.runInContext('state = { lessons: [], knowledge: knowledgeFixture }', context);
  return context.renderKnowledge();
}

test('knowledge panel labels owner requirements, shows scoped source details, and escapes every supplied value', () => {
  const hostile = '<script>alert("x")</script>';
  const html = renderKnowledge([{
    id: 'pm-international', title: `Offer ${hostile}`, status: 'market_reference_available_owner_terms_unknown',
    selected_market: null,
    facts: [{ kind: 'owner_requirement', text: `Owner choice ${hostile}`, source: `idea ${hostile}` }],
    official_references: [{ id: `ref ${hostile}`, market: 'DE', status: 'reference_only',
      source: { url: `https://example.test/${hostile}`, document_version: hostile,
        checked_at: hostile, review_after: hostile, sha256: hostile },
      currentness_basis: hostile,
      claims: [{ id: hostile, section: hostile, text: hostile }] }],
    missing: [hostile], boundaries: [hostile],
  }, {
    id: 'wellness-partnership-offer', title: 'Offer rubric', status: 'needs_owner_materials',
    missing: ['Owner market'],
  }]);

  assert.match(html, /Знания и источники/);
  assert.match(html, /Требование владельца/);
  assert.match(html, /Рынок владельца:<\/strong> не выбран/);
  assert.match(html, /Исследовательская справка · рынок DE/);
  assert.match(html, /не являются условиями оффера владельца/);
  assert.match(html, /Версия документа/);
  assert.match(html, /Дата получения источника/);
  assert.match(html, /Перепроверить после/);
  assert.match(html, /SHA-256/);
  assert.match(html, /раздел/);
  assert.match(html, /Неизвестно \/ требуется исследовать/);
  assert.doesNotMatch(html, /<script>/);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;\/script&gt;'), 'hostile values are HTML-escaped');
  assert.doesNotMatch(html, /<a\b/i, 'source URL is displayed as escaped text, never as an unchecked link');
});

test('unavailable source metadata is visible while its old claims stay hidden', () => {
  const html = renderKnowledge([{
    title: 'PM / FitLine', status: 'needs_owner_materials', facts: [],
    official_references: [{ id: 'pm-de-rules', market: 'DE', status: 'unavailable',
      reason: 'REFERENCE_RECHECK_REQUIRED',
      claims: [{ id: 'old-claim', section: '2.1', text: 'STALE CLAIM MUST NOT APPEAR' }] }],
  }]);
  assert.match(html, /Справка недоступна: REFERENCE_RECHECK_REQUIRED/);
  assert.match(html, /Содержание скрыто до повторной проверки/);
  assert.doesNotMatch(html, /STALE CLAIM MUST NOT APPEAR|old-claim|2\.1/);
});

