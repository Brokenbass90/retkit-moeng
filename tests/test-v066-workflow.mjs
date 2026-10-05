import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../dist/retkit-moengage.user.js', import.meta.url), 'utf8');

// Static UX contracts: no technical Scope/scan/rollback/cancel controls in Find/Replace UI.
assert(!source.includes("makeButton('Scope ▾'"), 'v0.6.6 removes Scope button');
assert(!source.includes("makeButton('Scan locales'"), 'v0.6.6 removes manual Scan locales button');
assert(!source.includes("makeButton('Rollback last'"), 'v0.6.6 removes rollback button from find UI');
assert(!source.includes("makeButton('Cancel'"), 'v0.6.6 removes cancel button from find UI');
assert(source.includes('Replace ${selectedMatches} match'), 'v0.6.6 exposes one replace-across-locales action');
assert(source.includes('scheduleMultiLocaleAutoScan'), 'Cmd+F/find changes trigger automatic locale scan');

// Validator contract: template-bearing tags still participate in structural parsing,
// and missing image src is a warning rather than a blocking syntax error.
assert(!source.includes("if (/\\{[{%]/.test(raw)) continue;"), 'template tags are not skipped wholesale by validator');
assert(source.includes("add('warning', 'img-src'"), 'missing img src is warning-only');
assert(!source.includes("inline.classList.toggle('rk-open'"), 'large inline validator error banner is removed');
assert(source.includes("markText") && source.includes('rk-html-error-mark'), 'syntax errors are marked in CodeMirror');

// Locale discovery contract: async deep discovery exists and add-locale trigger is not dependent on finding locale bar first.
assert(source.includes('discoverNativeLocalesDeep'), 'bounded async deep locale discovery exists');
assert(source.includes('scheduleNativeLocaleDiscovery'), 'deep locale discovery is scheduled asynchronously');
const addTriggerBody = source.slice(source.indexOf('function findNativeAddLocaleTrigger()'), source.indexOf('function findLocaleRowForControl'));
assert(!/const bar = findNativeLocaleBar\(\);\s*if \(!bar\) return null;/.test(addTriggerBody), '+ Locale discovery no longer requires locale bar');

console.log('v0.6.6 workflow regression checks passed');
