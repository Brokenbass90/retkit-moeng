import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');
const core = require('../src/shared/rtl-core.js');
const applyRtl = core.applyRtl || globalThis.RetKitRtlCore?.applyRtl;
assert.ok(applyRtl, 'rtl-core exports applyRtl');

// Already arabized emails are left exactly as they are, without an error.
const done = '<!doctype html><html dir="rtl" lang="ar"><body><p style="padding-left:10px">مرحبا</p></body></html>';
let report = null;
assert.equal(applyRtl(done, { mode: 'document', onReport: (r) => { report = r; } }), done);
assert.equal(report?.alreadyRtl, true);
const textDone = applyRtl('<html><body><p style="text-align:left">مرحبا</p></body></html>', { mode: 'text' });
assert.equal(applyRtl(textDone, { mode: 'document' }), textDone, 'old RTL Fix output + new button: no error, no change');
assert.match(bridge, /письмо уже арабизировано — ничего не менял/, 'RTL Fix says so');
console.log('✓ RetKit v0.8.5 already-arabized email is left alone');
