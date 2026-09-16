import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const corePath = new URL('../src/core/retkit-moengage-core.user.js', import.meta.url);
const source = fs.readFileSync(corePath, 'utf8');
const sandbox = { console, setTimeout, clearTimeout, globalThis: {} };
sandbox.globalThis.globalThis = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'retkit-moengage-core.user.js' });
const core = sandbox.globalThis.__RetKitMoEngageCore;
assert.ok(core, 'core should be exposed');

// A click on the second visible "1" must map to that element's text, not the first raw "1" in CSS/HTML.
const sourceHtml = `
<style>.x{z-index:1}.y{line-height:1}</style>
<div><p class="number">1</p></div>
<div><p class="number">1</p></div>`;
const secondVisibleOne = sourceHtml.lastIndexOf('>1<') + 1;
const mapped = core.findRangeFromDescriptor(sourceHtml, {
  tag: 'P',
  tagOccurrence: 1,
  pointText: '1',
  pointTextOrdinal: 0,
  pointTextGlobalOccurrence: 1,
  pointParentTag: 'P',
  pointParentHasElementChildren: false,
  classes: ['number'],
});
assert.ok(mapped, 'second number should map');
assert.equal(mapped.start, secondVisibleOne, 'mapping should use the clicked paragraph occurrence');
assert.equal(sourceHtml.slice(mapped.start, mapped.end), '1');

console.log('✓ RetKit v0.5.4 click-to-source regression');
