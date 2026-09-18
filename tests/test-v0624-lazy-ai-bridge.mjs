import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/ai/ui/ai-panel.js', import.meta.url), 'utf8');

function functionBody(name) {
  const start = source.indexOf(`function ${name}`);
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

const createClient = functionBody('ensureBridgeClient');
assert.doesNotMatch(createClient, /\.connect\(\)/, 'creating the hidden AI panel must not start a localhost WebSocket loop');

const connect = functionBody('ensureBridgeConnection');
assert.match(connect, /client\.connect\(\)/, 'explicit AI use should still start the local bridge');
assert.match(connect, /connected.*connecting|connecting.*connected/s, 'do not reconnect while already connected/connecting');

const toggle = functionBody('toggleAiPanel');
assert.match(toggle, /if \(state\.open\) ensureBridgeConnection\(\)/, 'opening the AI drawer should connect lazily');

const provider = functionBody('selectAndConnectProvider');
assert.match(provider, /ensureBridgeConnection\(\)/, 'provider click should connect the bridge on demand');

const mount = functionBody('mountAiPanel');
assert.match(mount, /if \(state\.open\) ensureBridgeConnection\(\)/, 'persisted-open AI drawer should reconnect on mount');

console.log('v0.6.24 lazy AI bridge regression checks passed');
