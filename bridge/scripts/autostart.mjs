#!/usr/bin/env node
// RetKit AI bridge autostart for macOS: one command, then the bridge starts
// with the Mac and keeps running in the background — no Terminal needed.
//   npm run bridge:install     install + start now
//   npm run bridge:uninstall   stop + remove
//   npm run bridge:status      is it running?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LABEL = 'com.retkit.ai-bridge';
const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(here, '..');

const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildPlist({ nodePath, entry, workingDirectory, logPath, envPath, home }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(entry)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(envPath)}</string>
    <key>HOME</key><string>${xml(home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

// Claude Code / Codex live in user paths a LaunchAgent does not see by default.
export function bridgePath(current = process.env.PATH || '', home = os.homedir()) {
  const extra = [
    path.dirname(process.execPath),
    path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), path.join(home, '.claude/local'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  return [...new Set([...String(current).split(':').filter(Boolean), ...extra])].join(':');
}

function paths() {
  const home = os.homedir();
  return {
    home,
    plist: path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`),
    log: path.join(home, 'Library/Logs/retkit-ai-bridge.log'),
  };
}

function launchctl(args, { quiet = false } = {}) {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (!quiet) throw error;
    return '';
  }
}

function install() {
  const p = paths();
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.mkdirSync(path.dirname(p.log), { recursive: true });
  const plist = buildPlist({
    nodePath: process.execPath,
    entry: path.join(bridgeRoot, 'src/index.mjs'),
    workingDirectory: bridgeRoot,
    logPath: p.log,
    envPath: bridgePath(),
    home: p.home,
  });
  const uid = String(process.getuid());
  launchctl(['bootout', `gui/${uid}/${LABEL}`], { quiet: true });
  fs.writeFileSync(p.plist, plist);
  launchctl(['bootstrap', `gui/${uid}`, p.plist]);
  console.log('✓ RetKit AI bridge installed: it starts with your Mac and runs in the background.');
  console.log(`  Log: ${p.log}`);
  console.log('  Open MoEngage → RK → the AI panel should show Claude / Codex instead of “Bridge offline”.');
  console.log('  If you move this folder, run npm run bridge:install again.');
}

function uninstall() {
  const p = paths();
  launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`], { quiet: true });
  fs.rmSync(p.plist, { force: true });
  console.log('✓ RetKit AI bridge autostart removed.');
}

async function status() {
  const p = paths();
  const installed = fs.existsSync(p.plist);
  let health = 'not answering';
  try {
    const res = await fetch('http://127.0.0.1:43118/health', { headers: { Origin: 'https://dashboard-02.moengage.com' } });
    const body = await res.json();
    health = body?.ok ? `running v${body.version}` : 'not answering';
  } catch {}
  console.log(`autostart: ${installed ? 'installed' : 'not installed'} · bridge: ${health}`);
  if (installed && health === 'not answering') console.log(`  See the log: ${p.log}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'darwin') {
    console.error('Autostart is implemented for macOS. On other systems run: npm run bridge');
    process.exit(1);
  }
  const command = process.argv[2] || 'install';
  if (command === 'install') install();
  else if (command === 'uninstall') uninstall();
  else if (command === 'status') await status();
  else { console.error('usage: autostart.mjs install|uninstall|status'); process.exit(2); }
}
