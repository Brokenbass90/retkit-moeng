import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

function functionBody(name) {
  const starts = [`async function ${name}`, `function ${name}`]
    .map((needle) => source.indexOf(needle)).filter((i) => i >= 0);
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

// Current MoEngage changes the native action to "Rerun Test" after a previous
// test. RetKit must treat Test and Rerun Test as the same native submit action.
const submit = functionBody('submitNativeTestCampaign');
assert.match(submit, /Rerun\s+Test/i, 'Send test must support the native Rerun Test action');

// RTL is a manual toggle for any locale. The proven path is the workspace
// editor sync; direct Froala commits race the normal sync and can be reverted.
const rtl = functionBody('applyRtlFix');
assert.doesNotMatch(rtl, /commitNativeHtml/, 'RTL Fix should not bypass the normal workspace sync path');
assert.match(rtl, /rtlToggleStates/, 'RTL Fix should retain a separate toggle snapshot for each locale');
assert.match(rtl, /replaceOverlayHtmlAsEdit\(editor, result\.html/, 'RTL Fix should write through the dirty-aware RetKit editor sync path');
assert.match(rtl, /allParagraphs:\s*true/, 'RTL Fix remains a manual toggle for any currently open locale');

console.log('Send/Rerun + per-locale RTL workspace-sync contract passed');
