import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url);
assert.ok(fs.existsSync(sourcePath), 'v0.5 userscript source should exist');
const source = fs.readFileSync(sourcePath, 'utf8');

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  globalThis: {},
};
sandbox.globalThis.globalThis = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'retkit-moengage-v0.5.user.js' });

const core = sandbox.globalThis.__RetKitMoEngageBridgeCore;
assert.ok(core, 'bridge core should be exposed');

assert.equal(core.normaliseLocale(' ar-SA '), 'AR');
assert.equal(core.normaliseLocale('pt_BR'), 'PT');
assert.equal(core.localeFromHtml('<html lang="ar"><body>x</body></html>'), 'AR');
assert.equal(core.localeFromHtml("<html lang='es-ES'>"), 'ES');
assert.equal(core.localeFromHtml('<html><body>x</body></html>'), '');
assert.equal(core.isArabicLocale('AR'), true);
assert.equal(core.isArabicLocale('ar-SA'), true);
assert.equal(core.isArabicLocale('EN'), false);

const input = `
<table>
  <tr>
    <td style="text-align: left; color:#222">
      <p style="text-align:left">مرحبا <b>بك</b></p>
      <p style="text-align:left">English only</p>
    </td>
    <td style="text-align:center">
      <p>نص عربي</p>
    </td>
  </tr>
</table>`;

const rtl = core.transformRtlHtml(input);
assert.equal(rtl.paragraphCount, 2, 'only Arabic paragraphs should be targeted');
assert.equal(rtl.cellCount, 2, 'only nearest cells of Arabic paragraphs should be targeted');
assert.match(rtl.html, /<p[^>]*dir="rtl"[^>]*style="text-align:\s*right"[^>]*>مرحبا/);
assert.match(rtl.html, /<td[^>]*dir="rtl"[^>]*style="text-align:\s*right;\s*color:#222"/);
assert.match(rtl.html, /<p style="text-align:left">English only<\/p>/, 'non-Arabic paragraph must remain unchanged');
assert.match(rtl.html, /<td[^>]*dir="rtl"[^>]*style="text-align:center"/, 'center alignment must stay centered');
assert.equal((rtl.html.match(/dir="rtl"/g) || []).length, 4);

const already = core.transformRtlHtml('<td dir="rtl"><p dir="rtl" style="text-align:right">مرحبا</p></td>');
assert.equal(already.paragraphCount, 0, 'already-correct RTL paragraph should not count as a change');
assert.equal(already.cellCount, 0, 'already-correct RTL cell should not count as a change');

const ltr = core.transformRtlHtml('<td dir="ltr" style="text-align: left"><p dir="ltr">مرحبا</p></td>');
assert.match(ltr.html, /<td dir="rtl" style="text-align: right">/);
assert.match(ltr.html, /<p dir="rtl">مرحبا<\/p>/);

assert.equal(
  JSON.stringify(core.normaliseTestPreferences({ email: '  qa@example.com ', locales: ['AR', 'DEFAULT'], personalise: false })),
  JSON.stringify({ email: 'qa@example.com', locales: ['AR', 'EN'], personalise: false, sendVia: 'Email ID (Non-registered users)' }),
);
assert.equal(
  JSON.stringify(core.normaliseTestPreferences({ email: 'qa@example.com', locales: [], personalise: 'yes' })),
  JSON.stringify({ email: 'qa@example.com', locales: [], personalise: true, sendVia: 'Email ID (Non-registered users)' }),
);

assert.match(source, /@version\s+0\.6\.31/);
assert.match(source, /@require\s+https:\/\/raw\.githubusercontent\.com\/Brokenbass90\/retkit-moeng\/main\/src\/retkit-moengage\.user\.js/);
assert.match(source, /function pruneLegacyToolbarButtons\(/);
assert.match(source, /setTextContentIfChanged\(version, 'v0\.6\.31'\)/);
assert.match(source, /function renderLocaleStrip\(/);
assert.match(source, /\['Save', 'Apply now'\]/);
assert.match(source, /function switchNativeLocale\(/);
assert.match(source, /function findTestCampaignSection\(/);
assert.match(source, /function submitNativeTestCampaign\(/);
assert.doesNotMatch(source, /fetch\s*\(.*moengage/i, 'bridge must not send through a private MoEngage API');


const fake = {
  writes: 0,
  _text: 'AR',
  get textContent() { return this._text; },
  set textContent(value) { this.writes += 1; this._text = value; },
};
assert.equal(core.setTextContentIfChanged(fake, 'AR'), false, 'same toolbar label must not mutate DOM');
assert.equal(fake.writes, 0, 'same toolbar label must not write textContent');
assert.equal(core.setTextContentIfChanged(fake, 'ES'), true, 'different toolbar label should update DOM');
assert.equal(fake.writes, 1);
assert.equal(fake.textContent, 'ES');

console.log('✓ RetKit v0.5.1 bridge core');
