import assert from 'node:assert/strict';
import fs from 'node:fs';

const coreSource = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

// 1) Across-locales scan must not fail silently when live locale discovery rejects.
const scanStart = coreSource.indexOf('async function scanMultiLocaleReplace');
const scanEnd = coreSource.indexOf('\n  function scheduleMultiLocaleAutoScan', scanStart);
const scanBody = coreSource.slice(scanStart, scanEnd);
assert.ok(scanStart >= 0 && scanEnd > scanStart, 'scanMultiLocaleReplace should exist');
const firstTry = scanBody.indexOf('try {');
const listLocalesCall = scanBody.indexOf('bridge.listLocales');
assert.ok(firstTry >= 0 && listLocalesCall > firstTry, 'live listLocales must execute inside the protected scan try/catch');
assert.match(scanBody, /fallback|known.*locale|locale-strip|dataset\.locales/i, 'scan must fall back to already-known RetKit locale tabs when live discovery fails');
assert.match(scanBody, /multilocale_scan_failed/, 'unrecoverable locale scan failures must reach Diagnostics');
assert.match(scanBody, /Retry|retry/i, 'unrecoverable scan state should offer a visible retry action');

// The scheduled auto-scan promise itself must be caught so an async rejection can never disappear.
const scheduleStart = coreSource.indexOf('function scheduleMultiLocaleAutoScan');
const scheduleEnd = coreSource.indexOf('\n  function selectedMultiLocaleItems', scheduleStart);
const scheduleBody = coreSource.slice(scheduleStart, scheduleEnd);
assert.match(scheduleBody, /scanMultiLocaleReplace\(\).*\.catch|Promise\.resolve\(scanMultiLocaleReplace\(\)\).*catch|void\s+scanMultiLocaleReplace\(\).*catch/s, 'auto-scan scheduler must catch rejected scan promises');

// 2) Locale creation is a deliberate native handoff: RetKit selects requested
// checkboxes, then lets the user press MoEngage's own Add button. It must not
// try to click an internal footer action itself.
const addStart = bridgeSource.indexOf('async function addNativeLocales');
const addEnd = bridgeSource.indexOf('\n  function findNativeRemoveLocaleControl', addStart);
const addBody = bridgeSource.slice(addStart, addEnd);
assert.ok(addStart >= 0 && addEnd > addStart, 'addNativeLocales should exist');
assert.match(addBody, /handOffNativeLocaleAdd\(plan\)/, 'locale add should hand the final confirmation to native MoEngage');
assert.doesNotMatch(addBody, /waitForOpenAddLocaleAction\(/, 'RetKit must not hunt for the native Add footer action');
assert.doesNotMatch(addBody, /activateNativeControl\(add\)/, 'RetKit must not click MoEngage Add automatically');

console.log('✓ RetKit v0.6.14 scan fallback + native add handoff contracts');
