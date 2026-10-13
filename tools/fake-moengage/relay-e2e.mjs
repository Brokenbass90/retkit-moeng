import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
import { chromium } from 'playwright-core';
const here = path.dirname(new URL(import.meta.url).pathname);
const relayMod = await import(path.join(here, 'studio/src/relay.js'));
const TOKEN = '0123456789abcdef0123456789abcdef';
const readBody = (req) => new Promise((r) => { let s=''; req.on('data', d=>s+=d); req.on('end', ()=>{ try{r(JSON.parse(s||'{}'))}catch{r({})} }); });
const send = (res, code, obj) => { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj)); };
const srv = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/relay.html' || u === '/relay.js') { res.writeHead(200, {'content-type': u.endsWith('.js')?'text/javascript':'text/html'}); res.end(fs.readFileSync(path.join(here,'studio/public',u))); return; }
  if (u === '/api/mcp/link') return send(res, 200, { ok: true, url: 'http://127.0.0.1:4555/mcp/KEY' });
  if (u === '/api/relay/poll') { const b = await readBody(req); return send(res, 200, { ok: true, command: await relayMod.pollRelay(TOKEN, b.status, { waitMs: 3000 }) }); }
  if (u === '/api/relay/result') { const b = await readBody(req); return send(res, 200, { ok: relayMod.resolveRelay(TOKEN, b.id, { ok: b.ok, result: b.result, error: b.error }) }); }
  if (u === '/api/relay/call') { const b = await readBody(req); return send(res, 200, await relayMod.callRelay(TOKEN, b.tool, b.args, { timeoutMs: 30000 })); }
  send(res, 404, {});
}).listen(4555);
const call = async (tool, args = {}) => (await fetch('http://127.0.0.1:4555/api/relay/call', { method:'POST', body: JSON.stringify({ tool, args }) })).json();

const cmJs = fs.readFileSync(path.join(here, 'node_modules/codemirror/lib/codemirror.js'), 'utf8');
const cmCss = fs.readFileSync(path.join(here, 'node_modules/codemirror/lib/codemirror.css'), 'utf8');
const page0 = fs.readFileSync(path.join(here, 'fake-moengage.html'), 'utf8').replace('/*CMJS*/', () => cmJs).replace('/*CMCSS*/', () => cmCss);
const dist = fs.readFileSync(process.argv[2], 'utf8');
const mk = (w) => `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>t</title></head>\n<body>\n<div class="preheader">MARK-${w}</div>\n<table><tr><td><a href="https://x.test/?aff=88&afftrack=old">Go IQ Option</a></td></tr></table>\n<p>Hello ${w}</p>\n</body>\n</html>`;
const store = { Default: mk('ENGLISH'), ar_KW: mk('ARABIC'), fr_FR: mk('FRENCH') };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('https://dashboard-02.moengage.com/**', (route) => route.fulfill({ contentType: 'text/html', body: page0 }));
await page.addInitScript(({ store }) => { window.__FAKE_STORE = store; window.__FAKE_CFG = { swapDelay: 300 }; localStorage.setItem('retkit-studio-url', 'http://127.0.0.1:4555'); }, { store });
await page.goto('https://dashboard-02.moengage.com/v4/create/flows/test');
await page.addScriptTag({ content: dist });
await page.waitForTimeout(800);
await page.click('#retkit-mo-launcher'); await page.waitForTimeout(1500);
let bad = 0; const check = (n, ok, d='') => { console.log(`${ok?'PASS':'FAIL'} ${n}${ok?'':' '+d}`); if(!ok) bad++; };
check('кнопка «Агент» в RetKit', Boolean(await page.$('#retkit-agent-button')));
const popupP = ctx.waitForEvent('page');
await page.click('#retkit-agent-button');
const popup = await popupP; popup.on('pageerror', (e) => console.log('POPUPERR', e.message));
await page.waitForFunction(() => /✓/.test(document.getElementById('retkit-agent-button')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
check('связь установлена (✓ на кнопке)', /✓/.test(await page.textContent('#retkit-agent-button')));
await popup.waitForTimeout(1500);
console.log('popup:', (await popup.textContent('#st')).trim());
const st = await call('status'); check('status через связь', st.ok && st.result?.workspaceOpen && st.result.locales?.length === 3, JSON.stringify(st));
const rd = await call('read_email'); check('read_email открытой', rd.ok && /MARK-ENGLISH/.test(rd.result.html), JSON.stringify(rd).slice(0,300));
const rdAr = await call('read_email', { locale: 'AR_KW' }); check('read_email другой локали', rdAr.ok && /MARK-ARABIC/.test(rdAr.result?.html || ''), JSON.stringify(rdAr).slice(0,300));
await page.waitForTimeout(1500);
const back = await call('status'); check('человек вернулся на свою локаль', back.result?.locale === 'DEFAULT' || back.result?.locale === st.result.locale, JSON.stringify(back.result));
const rd2 = await call('read_email');
const stale = await call('write_email', { html: rd2.result.html.replace('Hello ENGLISH', 'X'), based_on_hash: 'nope' }); check('запись со старым hash отказана', !stale.ok, JSON.stringify(stale));
const empty = await call('write_email', { html: '<html><body>  </body></html>', based_on_hash: rd2.result.hash }); check('пустой body отказан', !empty.ok, JSON.stringify(empty));
const wr = await call('write_email', { html: rd2.result.html.replace('Hello ENGLISH', 'Hello from agent'), based_on_hash: rd2.result.hash });
check('write_email ок', wr.ok && wr.result.changed, JSON.stringify(wr));
await page.waitForTimeout(3000);
const fs1 = await page.evaluate(() => window.__FAKE_STORE.Default);
check('правка дошла до редактора MoEngage', fs1.includes('Hello from agent'), fs1.slice(0,200));
const other = await page.evaluate(() => [window.__FAKE_STORE.ar_KW.includes('MARK-ARABIC'), window.__FAKE_STORE.fr_FR.includes('MARK-FRENCH')]);
check('другие локали не тронуты', other.every(Boolean));
const fa = await call('find_across_locales', { query: 'afftrack=old', replacement: 'afftrack=new' });
check('поиск по локалям подготовлен', fa.ok && Number(fa.result?.totalCount ?? fa.result?.total ?? 0) >= 3 || (fa.ok && JSON.stringify(fa.result).includes('AR_KW')), JSON.stringify(fa).slice(0,400));
const after = await page.evaluate(() => Object.values(window.__FAKE_STORE).every((h) => h.includes('afftrack=old')));
check('замену сам агент не нажал', after);
await popup.close(); await page.waitForTimeout(5000);
const gone = await call('status'); check('окно закрыто → понятный отказ', !gone.ok, JSON.stringify(gone));
console.log(bad ? `RELAY: ${bad} FAIL` : 'RELAY: all passed');
await browser.close(); srv.close(); process.exit(0);
