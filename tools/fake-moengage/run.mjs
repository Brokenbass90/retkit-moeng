// Setup once in this folder: npm i codemirror@5 playwright-core (needs a Chromium; set the path below).
// Scenarios: read | replace | dirty | spelling ; last arg = MoEngage tab->content delay in ms.
// Fake-MoEngage harness for RetKit multi-locale find/replace.
// usage: node run.mjs <dist.user.js> <base.html> [scenario] [swapDelay]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [distPath, basePath, scenario = 'read', swapDelayArg = '450'] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const cmJs = fs.readFileSync(path.join(here, 'node_modules/codemirror/lib/codemirror.js'), 'utf8');
const cmCss = fs.readFileSync(path.join(here, 'node_modules/codemirror/lib/codemirror.css'), 'utf8');
const page0 = fs.readFileSync(path.join(here, 'fake-moengage.html'), 'utf8')
  .replace('/*CMJS*/', () => cmJs).replace('/*CMCSS*/', () => cmCss);
const dist = fs.readFileSync(distPath, 'utf8');
const base = fs.readFileSync(basePath, 'utf8').replace(/<!--\s*retkit-rtl[^>]*-->/g, '').replace(/<html[^>]*>/i, '<html lang="en">');

// Each locale: same template, own visible text + own preheader, same links.
const LOCALES = { Default: 'ENGLISH', ar_KW: 'ARABIC', es_ES: 'SPANISH', fr_FR: 'FRENCH', id_ID: 'INDONESIAN' };
const store = {};
for (const [loc, word] of Object.entries(LOCALES)) {
  store[loc] = base.replace(/(<div[^>]*class="preheader"[^>]*>)([\s\S]*?)(<\/div>)/i, `$1 MARK-${word} $3`);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('https://dashboard-02.moengage.com/**', (route) => route.fulfill({ contentType: 'text/html', body: page0 }));
await page.addInitScript(({ store, cfg }) => { window.__FAKE_STORE = store; window.__FAKE_CFG = cfg; }, { store, cfg: { swapDelay: Number(swapDelayArg) } });
await page.goto('https://dashboard-02.moengage.com/v4/create/flows/test');
await page.addScriptTag({ content: dist });
await page.waitForTimeout(800);
await page.click('#retkit-mo-launcher');
await page.waitForTimeout(1200);

const markOf = (html) => (String(html).match(/MARK-([A-Z]+)/) || [])[1] || '?';
const fakeStore = () => page.evaluate(() => ({ ...window.__FAKE_STORE }));

if (scenario === 'read') {
  const results = await page.evaluate(async (locales) => {
    const api = window.__RetKitMoEngageBridgeApi;
    const out = [];
    for (const loc of locales) {
      try { const html = await api.readLocaleHtmlFast(loc); out.push([loc, (html.match(/MARK-([A-Z]+)/) || [])[1] || '?']); }
      catch (e) { out.push([loc, 'ERR ' + e.message]); }
    }
    return out;
  }, ['AR_KW', 'ES_ES', 'FR_FR', 'ID_ID', 'EN', 'FR_FR', 'AR_KW']);
  const want = { AR_KW: 'ARABIC', ES_ES: 'SPANISH', FR_FR: 'FRENCH', ID_ID: 'INDONESIAN', EN: 'ENGLISH' };
  let bad = 0;
  for (const [loc, got] of results) { const ok = got === want[loc]; if (!ok) bad += 1; console.log(`${ok ? 'PASS' : 'FAIL'} read ${loc}: got ${got}`); }
  console.log(bad ? `READ: ${bad} wrong` : 'READ: all correct');
}

if (scenario === 'spelling') {
  // Same visible text, different HTML spelling per locale.
  await page.evaluate(() => { const st = window.__FAKE_STORE; st.Default = st.Default.split('IQ&nbsp;Option').join('IQ Option'); st.es_ES = st.es_ES.split('IQ&nbsp;Option').join('IQ\n            Option'); });
  await page.click('#retkit-mo-workspace .CodeMirror');
  // re-open workspace content from the modified Default
  await page.evaluate(() => window.__RetKitMoEngageCore?.rebindNativeEditorFromMoEngage?.({}));
}
if (scenario === 'replace' || scenario === 'dirty' || scenario === 'spelling') {
  if (scenario === 'dirty') {
    // unsaved edit in the open locale right before the bulk replace
    await page.evaluate(() => { const cm = document.querySelector('#retkit-mo-workspace .CodeMirror').CodeMirror; cm.replaceRange('<!-- EDIT-X -->', { line: 2, ch: 0 }); });
    await page.waitForTimeout(150);
  }
  const FIND = scenario === 'spelling' ? 'IQ Option' : 'afftrack=mail_photo-welcome8-3';
  const REPL = scenario === 'spelling' ? 'IQ Broker' : 'afftrack=mail_NEW-CAMPAIGN';
  const before = await fakeStore();
  const expected = {};
  for (const [loc, html] of Object.entries(before)) expected[loc] = scenario === 'spelling' ? html.split(FIND).join(REPL).split('IQ&nbsp;Option').join(REPL).split('IQ\n            Option').join(REPL) : html.split(FIND).join(REPL);
  // UI flow, like a person: Cmd+F, type, Search all locales, Replace.
  await page.click('#retkit-mo-workspace .CodeMirror');
  await page.keyboard.press('Meta+f').catch(() => {});
  await page.keyboard.press('Control+f').catch(() => {});
  await page.waitForTimeout(300);
  const findSel = '#retkit-mo-find-input';
  if (!(await page.$(findSel))) { console.log('find input id unknown'); }
  await page.fill(findSel, FIND);
  await page.fill('#retkit-mo-replace-input', REPL);
  await page.click('[data-rk-multilocale-search]');
  await page.waitForFunction(() => document.querySelector('[data-rk-multilocale-apply]') && !document.querySelector('[data-rk-multilocale-apply]').disabled, null, { timeout: 60000 });
  const label = await page.textContent('[data-rk-multilocale-apply]');
  console.log('apply button:', label.trim());
  await page.click('[data-rk-multilocale-apply]');
  await page.waitForFunction(() => /Replaced|stopped/.test(document.querySelector('#retkit-mo-status')?.textContent || ''), null, { timeout: 120000 });
  console.log('status:', (await page.textContent('#retkit-mo-status')).trim());
  await page.waitForTimeout(2500);
  const after = await fakeStore();
  let bad = 0;
  for (const loc of Object.keys(expected)) {
    const ok = after[loc] === expected[loc];
    const left = after[loc].split(FIND).length - 1;
    const repl = after[loc].split(REPL).length - 1;
    if (!ok) bad += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${loc}: mark=${markOf(after[loc])} (want ${markOf(before[loc])}) old-left=${left} new=${repl} want-new=${expected[loc].split(REPL).length - 1}${ok ? '' : ` len ${after[loc].length} vs ${expected[loc].length}`}`);
  }
  if (scenario === 'dirty') {
    const keep = after.Default.includes('EDIT-X');
    console.log(`${keep ? 'PASS' : 'FAIL'} unsaved edit in the open locale kept in MoEngage`);
    for (const loc of Object.keys(expected)) if (loc !== 'Default') expected[loc] = expected[loc];
  }
  const overlay = await page.evaluate(() => document.querySelector('#retkit-mo-workspace .CodeMirror').CodeMirror.getValue());
  const ovOk = markOf(overlay) === 'ENGLISH' && overlay.includes(REPL) && !overlay.includes(FIND);
  console.log(`${ovOk ? 'PASS' : 'FAIL'} RetKit editor after replace shows Default with the replacement (mark=${markOf(overlay)})`);
  console.log(bad ? `REPLACE: ${bad} locale(s) wrong` : 'REPLACE: all locales exact');
}
await browser.close();
