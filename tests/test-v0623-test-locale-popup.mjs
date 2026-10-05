import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');

function functionBody(name) {
  const needle = `function ${name}`;
  const asyncNeedle = `async function ${name}`;
  const start = Math.max(source.indexOf(needle), source.indexOf(asyncNeedle));
  assert.ok(start >= 0, `${name} should exist`);
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

const exactPopup = functionBody('findExactTestLocalePopup');
assert.match(exactPopup, /test-campaign-variation-locale-dropdown-popup/, 'use MoEngage stable locale popup test id');

const openPopup = functionBody('openTestLocalePopup');
assert.match(openPopup, /test-campaign-variation-locale-dropdown-popup/, 'reuse the exact MoEngage locale popup portal');
const firstActivation = openPopup.indexOf("invokeReactHandler(host, 'onMouseDown'");
const firstReuse = openPopup.indexOf('let popup = exactPopup()');
assert.ok(firstReuse >= 0 && firstActivation > firstReuse, 'do not blindly toggle the dropdown closed before checking for an open portal');
assert.match(openPopup, /mds-dropdown__popup__select-deselect-all/, 'scope Select all/Clear all lookup to the exact popup');

const localeSelection = functionBody('selectExplicitTestLocales');
assert.match(localeSelection, /openTestLocalePopup\(control\)/, 'open the native locale portal before changing selection');
assert.match(localeSelection, /test-campaign-variation-locale-dropdown-popup/, 're-acquire the exact live locale popup during selection');
assert.match(localeSelection, /activateReactClickable\(selectAll\)/, 'use the native React Select all handler');

console.log('v0.6.23 Test Campaign locale portal regression fix passed');
