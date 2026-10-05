import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { findChrome, buildChromeArgs, renderEmailPng, neutralizeScripts } from '../src/screenshot.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { createMcpRequestHandler } from '../src/mcp/stdio-server.mjs';
import { toolResultToRpcResponse } from '../src/providers/codex.mjs';

test('finds Chrome from env first, then platform defaults', () => {
  assert.equal(findChrome({ env: { RETKIT_CHROME: '/x/chrome' }, platform: 'darwin', exists: (p) => p === '/x/chrome' }), '/x/chrome');
  assert.equal(findChrome({ env: {}, platform: 'darwin', exists: (p) => p.includes('Google Chrome.app') }), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(findChrome({ env: {}, platform: 'darwin', exists: () => false }), '');
});

test('email scripts are stripped and blocked by CSP before rendering', () => {
  const out = neutralizeScripts('<html><head><title>t</title></head><body onload="x()"><script>alert(1)</script><a href="javascript:evil()">a</a><img src=x onerror=alert(2)></body></html>');
  assert.doesNotMatch(out, /<script|onload|onerror|javascript:/i);
  assert.match(out, /<head><meta http-equiv="Content-Security-Policy" content="script-src 'none'/);
});

test('chrome runs headless with a throwaway profile', () => {
  const args = buildChromeArgs({ htmlPath: '/t/a.html', pngPath: '/t/a.png', profileDir: '/t/p', width: 390, height: 3600 });
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--user-data-dir=/t/p'));
  assert.ok(args.includes('--window-size=390,3600'));
  assert.equal(args.at(-1), 'file:///t/a.html');
});

test('renderEmailPng: explicit reasons, cleanup of the temp html', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rk-shot-test-'));
  assert.equal((await renderEmailPng({ html: '<p>x</p>', outDir, chromePath: '' })).supported, false);
  assert.equal((await renderEmailPng({ html: '  ', outDir, chromePath: '/c' })).supported, false);
  const fakeSpawn = (_cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    const png = args.find((a) => a.startsWith('--screenshot=')).slice('--screenshot='.length);
    fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47])).then(() => child.emit('close', 0));
    return child;
  };
  const shot = await renderEmailPng({ html: '<p>hi</p>', view: 'mobile', outDir, chromePath: '/c', spawnImpl: fakeSpawn });
  assert.equal(shot.supported, true);
  assert.equal(shot.width, 390);
  assert.ok(shot.path.endsWith('.mobile.png'));
  const left = await fs.readdir(outDir);
  assert.ok(!left.some((name) => name.endsWith('.html')), 'temp preview html must be removed');
});

test('bridge answers get_preview_screenshot by rendering the preview DOM', async () => {
  const seen = [];
  const bridge = createBridgeServer({
    port: 0, host: '127.0.0.1', detectProviders: async () => [],
    renderScreenshot: async ({ html, view }) => { seen.push({ html, view }); return { supported: true, path: '/tmp/x.png', view, width: 390, height: 3600 }; },
  });
  const address = await bridge.start();
  try {
    let secret = '';
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Origin: 'https://dashboard-02.moengage.com' } });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, workspaceId: 'shot' })));
      ws.addEventListener('message', (event) => {
        const value = JSON.parse(event.data);
        if (value.type === 'bridge.ready') { secret = value.sessionSecret; resolve(); }
        if (value.type === 'tool.call') {
          assert.equal(value.tool, 'get_preview_dom', 'bridge asks the browser for the preview DOM, not for pixels');
          ws.send(JSON.stringify({ type: 'tool.result', protocol: 1, callId: value.callId, ok: true, result: { html: '<p>preview</p>' } }));
        }
      });
      ws.addEventListener('error', reject);
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-retkit-session': secret },
      body: JSON.stringify({ tool: 'get_preview_screenshot', args: { view: 'mobile' } }),
    });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.supported, true);
    assert.deepEqual(seen, [{ html: '<p>preview</p>', view: 'mobile' }]);
    ws.close();
  } finally {
    await bridge.stop();
  }
});

test('MCP returns the PNG as image content; Codex gets an inputImage', async () => {
  const handle = createMcpRequestHandler({
    sessionSecret: 's',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { supported: true, path: '/tmp/a.png' } }) }),
    readFile: async () => Buffer.from('PNG'),
  });
  const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_preview_screenshot', arguments: {} } });
  const image = reply.result.content.find((item) => item.type === 'image');
  assert.equal(image?.mimeType, 'image/png');
  assert.equal(image.data, Buffer.from('PNG').toString('base64'));

  const rpc = toolResultToRpcResponse(7, { ok: true, result: { supported: true }, imageDataUrl: 'data:image/png;base64,AAA' });
  assert.deepEqual(rpc.result.contentItems[1], { type: 'inputImage', imageUrl: 'data:image/png;base64,AAA' });
});
