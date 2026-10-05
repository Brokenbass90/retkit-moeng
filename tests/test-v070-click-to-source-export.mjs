import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

// The exported module must behave exactly like the core it was cut from.
await import(pathToFileURL(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url).pathname).href + `?t=${Date.now()}`);
const core = globalThis.__RetKitMoEngageCore;
const sandbox = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../shared/click-to-source.js', import.meta.url), 'utf8'), sandbox);
const shared = sandbox.RetKitClickToSource;
assert.ok(shared?.findRangeFromDescriptor, 'shared/click-to-source.js must expose RetKitClickToSource');

const html = fs.readFileSync(new URL('./fixtures/email-hybrid.html', import.meta.url), 'utf8')
  + '<table><tr><td><a href="https://example.com/x"><img src="https://cdn.example/btn.png"></a></td>'
  + '<td><a href="https://example.com/x"><img src="https://cdn.example/btn.png"></a></td></tr></table>'
  + '<p>Repeat</p><p>Repeat</p>';
const cases = [
  { tag: 'IMG', src: 'https://cdn.example/hero.png', srcOccurrence: 0 },
  { tag: 'IMG', src: 'https://cdn.example/btn.png', srcOccurrence: 1 },
  { tag: 'A', href: 'https://example.com/x', hrefOccurrence: 1, text: '' },
  { tag: 'P', tagOccurrence: 1, pointText: 'Repeat', pointTextGlobalOccurrence: 1, pointTextOrdinal: 0 },
  { tag: 'B', pointText: 'trading', pointTextGlobalOccurrence: 0 },
];
for (const descriptor of cases) {
  const a = core.findRangeFromDescriptor(html, descriptor);
  const b = shared.findRangeFromDescriptor(html, descriptor);
  assert.deepEqual({ ...b }, { ...a }, `parity for ${JSON.stringify(descriptor)}`);
  assert.ok(a, `core resolves ${JSON.stringify(descriptor)}`);
}
// second identical image resolves to the second src, not the first
const second = shared.findRangeFromDescriptor(html, cases[1]);
assert.equal(second.start, html.indexOf('https://cdn.example/btn.png', html.indexOf('https://cdn.example/btn.png') + 1));
// second "Repeat" paragraph resolves to the second occurrence
const rep = shared.findRangeFromDescriptor(html, cases[3]);
assert.equal(rep.start, html.lastIndexOf('Repeat'));
console.log('✓ click-to-source export matches core');
