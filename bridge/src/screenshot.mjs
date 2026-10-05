// Renders the email the user is looking at into a PNG with the user's own
// installed Chrome (headless). No extra dependencies, nothing leaves the
// machine except the email's own image requests. Scripts never run: they are
// stripped and a script-src 'none' CSP is injected (Chrome's own JS switch
// breaks headless screenshots).
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const VIEWS = Object.freeze({
  desktop: { width: 800, height: 3200 },
  mobile: { width: 390, height: 3600 },
});

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

export function findChrome({ env = process.env, platform = process.platform, exists = fsSync.existsSync } = {}) {
  if (env.RETKIT_CHROME && exists(env.RETKIT_CHROME)) return env.RETKIT_CHROME;
  return (CANDIDATES[platform] || []).find((candidate) => exists(candidate)) || '';
}

export function buildChromeArgs({ htmlPath, pngPath, profileDir, width, height }) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    '--virtual-time-budget=6000',
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ];
}

const NO_SCRIPT_CSP = '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'; frame-src \'none\'">';

export function neutralizeScripts(html) {
  let out = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z][\w:-]*\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2');
  if (/<head\b[^>]*>/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (head) => `${head}${NO_SCRIPT_CSP}`);
  else out = `${NO_SCRIPT_CSP}${out}`;
  return out;
}

export async function renderEmailPng({ html, view = 'desktop', outDir, chromePath = findChrome(), spawnImpl = nodeSpawn, timeoutMs = 30000, height } = {}) {
  const preset = VIEWS[view] || VIEWS.desktop;
  if (!chromePath) {
    return { supported: false, reason: 'Chrome/Chromium was not found on this computer. Install Google Chrome or set RETKIT_CHROME to its path.' };
  }
  const source = String(html || '');
  if (!source.trim()) return { supported: false, reason: 'The preview is empty right now.' };
  const id = crypto.randomUUID();
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  const htmlPath = path.join(outDir, `${id}.preview.html`);
  const pngPath = path.join(outDir, `${id}.${view}.png`);
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retkit-shot-'));
  await fs.writeFile(htmlPath, neutralizeScripts(source), { mode: 0o600 });
  const size = { width: preset.width, height: Math.max(400, Math.min(12000, Number(height) || preset.height)) };
  try {
    await new Promise((resolve, reject) => {
      const child = spawnImpl(chromePath, buildChromeArgs({ htmlPath, pngPath, profileDir, ...size }), { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on?.('data', (chunk) => { stderr += String(chunk); });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('Chrome screenshot timed out')); }, timeoutMs);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Chrome exited with ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`));
      });
    });
    const stat = await fs.stat(pngPath);
    return { supported: true, view, path: pngPath, bytes: stat.size, ...size };
  } catch (error) {
    return { supported: false, reason: error?.message || String(error) };
  } finally {
    await fs.rm(htmlPath, { force: true }).catch(() => {});
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}
