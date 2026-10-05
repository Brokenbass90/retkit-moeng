import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../src/ai/ui/connect-card.js', import.meta.url), 'utf8'), sandbox);
const C = sandbox.__RetKitAiConnect;

assert.equal(C.detectOs({ userAgentData: { platform: 'macOS' } }), 'mac');
assert.equal(C.detectOs({ platform: 'Win32' }), 'windows');
assert.equal(C.detectOs({ platform: 'MacIntel' }), 'mac');
assert.equal(C.installCommand('mac'), `curl -fsSL ${C.INSTALL_BASE}/install-mac.sh | bash`);
assert.equal(C.installCommand('mac', { codex: true }), `curl -fsSL ${C.INSTALL_BASE}/install-mac.sh | bash -s -- --codex`);
assert.match(C.installCommand('windows', { codex: true }), /^\$env:RETKIT_CODEX="1"; irm .*install-windows\.ps1 \| iex$/);
const cmd = C.windowsCmdFile({ codex: false });
assert.match(cmd, /^@echo off\r\n/);
assert.match(cmd, /powershell -NoProfile -ExecutionPolicy Bypass -Command "irm .*install-windows\.ps1 \| iex"/);

assert.equal(C.connectView({ bridge: { status: 'offline' } }).step, 'install');
assert.equal(C.connectView({ bridge: { status: 'connected' }, provider: { detected: false } }).step, 'install');
assert.equal(C.connectView({ bridge: { status: 'connected' }, provider: { detected: true, authenticated: 'no' } }).step, 'login');
assert.equal(C.connectView({ bridge: { status: 'connected' }, provider: { detected: true, authenticated: 'yes' } }), null, 'card disappears once connected');

// The installers referenced by the card exist and stay idempotent / admin-free.
for (const file of ['install-mac.sh', 'install-windows.ps1', 'RetKit-Connect.cmd']) {
  assert.ok(fs.existsSync(new URL(`../install/${file}`, import.meta.url)), `${file} exists`);
}
const mac = fs.readFileSync(new URL('../install/install-mac.sh', import.meta.url), 'utf8');
assert.match(mac, /command -v claude/, 'skips Claude Code when present');
assert.match(mac, /claude\.ai\/install\.sh/, 'uses the official Claude Code installer');
assert.match(mac, /SHASUMS256/, 'verifies the Node.js download');
assert.match(mac, /autostart\.mjs" install/, 'registers autostart');
assert.doesNotMatch(mac, /\bsudo\b/, 'no admin rights');
const win = fs.readFileSync(new URL('../install/install-windows.ps1', import.meta.url), 'utf8');
assert.match(win, /claude\.ai\/install\.ps1/);
assert.match(win, /Get-FileHash/);
assert.match(win, /GetFolderPath\('Startup'\)/);
console.log('✓ connect card + installers');
