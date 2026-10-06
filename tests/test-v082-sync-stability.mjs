import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Логи 2026-10-06: запись в MoEngage на письме 82 КБ шла ~2,3 с после каждой
// паузы 1,4 с (подвисания при наборе), а запись, начатая во время прохода по
// локалям, откатывалась MoEngage (moengage_sync_rejected).
const source = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const sandbox = { console, globalThis: null, location: { hostname: 'not-moengage.invalid' } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'retkit-moengage-core.user.js' });
const core = sandbox.__RetKitMoEngageCore;

assert.equal(core.idleSyncDelay(), 1400, 'small/unknown: as before');
assert.equal(core.idleSyncDelay(600), 1400);
assert.equal(core.idleSyncDelay(2300), 3240, 'slow MoEngage writes wait for a longer pause');
assert.equal(core.idleSyncDelay(9000), 4000, 'capped');

assert.match(source, /if \(!force && STATE\.multiLocaleBusy\) \{\s*STATE\.syncAfterMultiLocale = true;/, 'no native write while walking locales');
assert.match(source, /if \(STATE\.dirty && !STATE\.composing\) scheduleNativeSync\(300\);/, 'write right after the locale walk');
assert.match(source, /if \(STATE\.applying \|\| STATE\.syncTimer \|\| STATE\.dirty\) \{/, 'locale scan waits for the pending write');
assert.match(source, /lastNativeSyncMs = durationMs;/, 'delay learns from real write time');
assert.match(source, /STATE\.searchHighlightTimer = setTimeout\(/, 'search highlight is debounced while typing');

console.log('v0.8.2 sync stability: ok');
