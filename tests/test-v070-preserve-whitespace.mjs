import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const coreFile = new URL('../src/core/retkit-moengage-core.user.js', import.meta.url);
await import(pathToFileURL(coreFile.pathname).href + `?t=${Date.now()}`);
const core = globalThis.__RetKitMoEngageCore;
const { beautifyEmailHtml, preserveSourceWhitespace, htmlEquivalentForSync, tokenizeHtmlForWhitespace } = core;

const STRUCTURAL = /^<\/?\s*(html|head|body|center|table|thead|tbody|tfoot|tr|td|th|div|section|header|footer|main|article)\b/i;
// Same tokens, and the same inline (non-structural) whitespace presence.
function sameContent(left, right) {
  const a = tokenizeHtmlForWhitespace(left);
  const b = tokenizeHtmlForWhitespace(right);
  if (a.tokens.length !== b.tokens.length) return false;
  for (let i = 0; i < a.tokens.length; i += 1) {
    if (a.tokens[i] !== b.tokens[i]) return false;
    const neutral = STRUCTURAL.test(a.tokens[i]) || STRUCTURAL.test(a.tokens[i - 1] || '');
    if (!neutral && Boolean(a.gaps[i]) !== Boolean(b.gaps[i])) return false;
  }
  return true;
}

const raw = fs.readFileSync(new URL('./fixtures/email-hybrid.html', import.meta.url), 'utf8');
const pretty = beautifyEmailHtml(raw);
assert.notEqual(pretty, raw, 'fixture must actually be re-indented by beautify');

// 1. Opening and saving without edits must hand MoEngage the original bytes.
assert.equal(preserveSourceWhitespace(raw, pretty), raw);

// 2. A single text edit changes only that text; size grows only by the edit.
{
  const edited = pretty.replace('Help', 'Support');
  const out = preserveSourceWhitespace(raw, edited);
  assert.equal(out, raw.replace('Help', 'Support'));
  assert.ok(htmlEquivalentForSync(out, edited));
}

// 3. No whitespace is ever introduced between the inline-block columns.
{
  const edited = pretty.replace('Start <b>trading</b> now', 'Start <b>investing</b> today');
  const out = preserveSourceWhitespace(raw, edited);
  assert.ok(out.includes('</div><!--[if mso]></td><td width="300"><![endif]--><div class="col">'), 'columns stay glued');
  assert.equal(out, raw.replace('Start <b>trading</b> now', 'Start <b>investing</b> today'));
}

// 4. An inline space the user adds between links is a real change and survives.
{
  const edited = pretty.replace('</a> <a href="https://iqoption.com/help">', '</a><a href="https://iqoption.com/help">');
  const out = preserveSourceWhitespace(raw, edited);
  assert.ok(out.includes('</a><a href="https://iqoption.com/help">'));
}

// 5. Property check: for random edits, the result is always content-equivalent
//    to what the user typed, and never larger than the beautified copy.
{
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const words = ['X', 'new text', '<b>bold</b>', '', '<tr><td>row</td></tr>', ' '];
  for (let k = 0; k < 400; k += 1) {
    let edited = pretty;
    const edits = 1 + rand(3);
    for (let e = 0; e < edits; e += 1) {
      const at = rand(edited.length);
      const del = rand(12);
      edited = edited.slice(0, at) + words[rand(words.length)] + edited.slice(at + del);
    }
    const out = preserveSourceWhitespace(raw, edited);
    assert.ok(sameContent(out, edited), `case ${k}: result must match the user's edit`);
    assert.ok(out.length <= edited.length, `case ${k}: result must not exceed the beautified size`);
  }
}

// 6. Full rewrites fall back to the working copy unchanged.
assert.equal(preserveSourceWhitespace('<p>a</p>', '<div>b</div>'), '<div>b</div>');
assert.equal(preserveSourceWhitespace('', '<p>x</p>'), '<p>x</p>');

console.log('v0.7.0 source whitespace preservation checks passed');
