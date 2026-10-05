import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../dist/retkit-moengage.user.js', import.meta.url), 'utf8');

assert.match(source, /@version\s+\d+\.\d+\.\d+/, 'userscript should declare a version (exact value: test-version-consistency)');
assert.match(source, /function handOffNativeTestCampaign\(\)/, 'manual native Test Campaign handoff should exist');
assert.match(source, /workspace\.style\.visibility = 'hidden'/, 'handoff should hide RetKit without destroying the workspace');
assert.match(source, /section\.scrollIntoView\?\.\(\{ behavior: 'smooth', block: 'center' \}\)/, 'handoff should scroll to the native Test Campaign section');
assert.match(source, /back\.textContent = 'Return to RetKit'/, 'handoff should expose a Return to RetKit action');
assert.match(source, /makeToolbarButton\(IDS\.testButton, 'Send test', handOffNativeTestCampaign/, 'toolbar Send test should use manual handoff');
assert.doesNotMatch(source, /makeToolbarButton\(IDS\.testButton, 'Send test', renderTestPopover/, 'toolbar Send test must not invoke the broken automatic test flow');

console.log('v0.6.31 native Test Campaign handoff regression checks passed');
