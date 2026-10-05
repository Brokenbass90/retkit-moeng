import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlist, bridgePath, LABEL } from '../scripts/autostart.mjs';

test('LaunchAgent plist runs the bridge with node, restarts on crash, logs to a file', () => {
  const plist = buildPlist({ nodePath: '/usr/local/bin/node', entry: '/Users/a b/retkit/bridge/src/index.mjs', workingDirectory: '/Users/a b/retkit/bridge', logPath: '/Users/x/Library/Logs/retkit-ai-bridge.log', envPath: '/usr/bin:/x&y', home: '/Users/x' });
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/Users\/a b\/retkit\/bridge\/src\/index\.mjs<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /\/usr\/bin:\/x&amp;y/, 'values are XML-escaped');
});

test('PATH for the agent includes where Claude Code / Codex usually live', () => {
  const value = bridgePath('/usr/bin', '/Users/x');
  for (const dir of ['/Users/x/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']) assert.ok(value.split(':').includes(dir), dir);
  assert.equal(value.split(':').filter((d) => d === '/usr/bin').length, 1, 'no duplicates');
});
