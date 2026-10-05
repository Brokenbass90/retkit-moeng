import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');
assert.match(source, /@version\s+\d+\.\d+\.\d+/, 'bridge userscript should declare a version (exact value: test-version-consistency)');
const start = source.indexOf('function activateMdsDropdown(control)');
const end = source.indexOf('function testLocaleLabelToDisplay', start);
assert.ok(start >= 0 && end > start, 'activateMdsDropdown should exist');
const fn = source.slice(start, end);
const reactCall = fn.indexOf("invokeReactHandler(host, 'onMouseDown'");
const domDispatch = fn.indexOf("dispatchEvent?.(createNativeActivationEvent('mousedown'))");
assert.ok(reactCall >= 0, 'MDS activation should call the verified React onMouseDown handler');
assert.ok(domDispatch >= 0, 'MDS activation should keep a DOM fallback');
assert.ok(reactCall < domDispatch, 'React onMouseDown must run before the DOM fallback');
console.log('v0.6.31 direct React MDS dropdown regression checks passed');
