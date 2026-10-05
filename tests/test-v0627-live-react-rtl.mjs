import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

function functionBody(name) {
  const starts = [`async function ${name}`, `function ${name}`]
    .map((needle) => source.indexOf(needle)).filter((index) => index >= 0);
  assert.ok(starts.length, `${name} should exist`);
  const start = Math.min(...starts);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (!depth) return source.slice(start, i + 1);
    }
  }
  throw new Error(`cannot parse ${name}`);
}

assert.match(source, /@version\s+\d+\.\d+\.\d+/, 'userscript should declare a version (exact value: test-version-consistency)');

const activateDropdown = functionBody('activateMdsDropdown');
assert.match(activateDropdown, /mdsDropdownHost\(control\)/, 'MDS activation should target the actual dropdown host helper');
assert.match(activateDropdown, /mousedown/, 'MDS activation should use the live onMouseDown path');

const openPopup = functionBody('openTestLocalePopup');
assert.match(openPopup, /invokeReactHandler\(host, 'onMouseDown', target\)/, 'Test Campaign locale popup should use the recorded React onMouseDown activation');
assert.match(openPopup, /test-campaign-variation-locale-dropdown-popup/, 'Test Campaign should wait for the exact recorded portal');

const rtlWriter = functionBody('replaceOverlayHtmlAsEdit');
assert.match(rtlWriter, /replaceRange/, 'RTL must be applied as a real CodeMirror edit, not setValue');
assert.match(rtlWriter, /retkit-rtl/, 'RTL writes should carry an explicit non-setValue origin');

const rtl = functionBody('applyRtlFix');
assert.doesNotMatch(rtl, /editor\.setValue/, 'RTL must not use setValue because core intentionally ignores clean setValue changes');
assert.match(rtl, /replaceOverlayHtmlAsEdit/, 'RTL apply/revert should use the dirty/sync-aware editor writer');
assert.doesNotMatch(rtl, /root\.confirm/, 'RTL is a direct toggle and should not be blocked by a modal confirmation');

console.log('v0.6.31 live React dropdown + RTL dirty-sync regression checks passed');
