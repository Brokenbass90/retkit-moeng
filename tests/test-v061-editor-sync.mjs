import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const sandbox = { console, globalThis: null, location: { hostname: 'not-moengage.invalid' } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'retkit-moengage-core.user.js' });
const core = sandbox.__RetKitMoEngageCore;
assert.ok(core, 'core exported');

assert.equal(core.nextEditRevision(0), 1);
assert.equal(core.nextEditRevision(41), 42);
assert.equal(core.idleSyncDelay(), 1400);

assert.equal(core.shouldApplyNativeResult({ startedRevision: 3, currentRevision: 3 }), true);
assert.equal(core.shouldApplyNativeResult({ startedRevision: 3, currentRevision: 4 }), false, 'stale native result must not win');

assert.equal(core.shouldPullNativeIntoOverlay({ focused: true, dirty: true, composing: false, applying: false }), false, 'focused dirty editor owns current text');
assert.equal(core.shouldPullNativeIntoOverlay({ focused: false, dirty: true, composing: false, applying: false }), false, 'dirty local text must not be overwritten by native changes');
assert.equal(core.shouldPullNativeIntoOverlay({ focused: true, dirty: false, composing: false, applying: false }), false, 'focused editor should not be rewritten underneath the cursor');
assert.equal(core.shouldPullNativeIntoOverlay({ focused: false, dirty: false, composing: false, applying: false }), true);
assert.equal(core.shouldPullNativeIntoOverlay({ focused: false, dirty: false, composing: true, applying: false }), false);
assert.equal(core.shouldPullNativeIntoOverlay({ focused: false, dirty: false, composing: false, applying: true }), false);


assert.equal(core.shouldTreatNativeMismatchAsLateRevert({ sameContent: false, lastAppliedRevision: 7, currentRevision: 7, lastAppliedAt: 1000, now: 4000 }), true);
assert.equal(core.shouldTreatNativeMismatchAsLateRevert({ sameContent: false, lastAppliedRevision: 7, currentRevision: 8, lastAppliedAt: 1000, now: 4000 }), false);
assert.equal(core.shouldTreatNativeMismatchAsLateRevert({ sameContent: false, lastAppliedRevision: 7, currentRevision: 7, lastAppliedAt: 1000, now: 8000 }), false);

console.log('✓ RetKit v0.6.1 revision-safe editor sync core');
