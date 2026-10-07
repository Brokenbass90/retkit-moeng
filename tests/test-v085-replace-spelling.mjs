import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../src/shared/replace-across.js');
const RA = globalThis.RetKitReplaceAcross;

// Text mode = what a person sees. Same text, any HTML spelling.
assert.equal(RA.countIn('Here&#39;s how', "Here's how"), 1, "' = &#39;");
assert.equal(RA.countIn('say &quot;hi&quot;', 'say "hi"'), 1, '" = &quot;');
assert.equal(RA.countIn('IQ&nbsp;Option', 'IQ Option'), 1, 'space = &nbsp;');
assert.equal(RA.countIn('IQ Option', 'IQ Option'), 1, 'space = U+00A0');
assert.equal(RA.countIn('Add funds to\n      your account', 'Add funds to your account'), 1, 'space = re-wrapped line');
assert.equal(RA.countIn('IQ Option', 'IQ&nbsp;Option'), 1, 'query typed with an entity');
// Replacement keeps the spelling of what it replaces.
assert.equal(RA.replaceIn('<p>Here&#39;s how</p>', "Here's how", "That's why").value, '<p>That&#39;s why</p>');
assert.equal(RA.replaceIn('<a href="https://x.com/?a=1&amp;b=2">', 'https://x.com/?a=1&b=2', 'https://y.com/?c=3&d=4').value, '<a href="https://y.com/?c=3&amp;d=4">');
// Whitespace-only query stays literal, never "every space in the email".
assert.equal(RA.countIn('a b  c', ' '), 3);
console.log('✓ RetKit v0.8.5 replace matches any HTML spelling of the same text');
