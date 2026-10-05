import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../src/shared/replace-across.js', import.meta.url), 'utf8'), sandbox);
const RA = sandbox.RetKitReplaceAcross;
const plain = (v) => JSON.parse(JSON.stringify(v));

// & and &amp; are one link; the replacement keeps the encoding it replaces.
assert.equal(RA.countIn('<a href="https://x.com/?a=1&amp;b=2">', 'https://x.com/?a=1&b=2'), 1);
assert.equal(RA.replaceIn('<a href="https://x.com/?a=1&amp;b=2">', 'https://x.com/?a=1&b=2', 'https://y.com/?c=3&d=4').value, '<a href="https://y.com/?c=3&amp;d=4">');
assert.equal(RA.replaceIn('go to a&b now', 'a&amp;b', 'c&d').value, 'go to c&d now');
assert.deepEqual(plain(RA.replaceIn('img.png img.png', 'img.png', 'new-img.png')), { value: 'new-img.png new-img.png', count: 2 }, 'single pass');

// Filename mode: the same image uploaded per locale under different paths.
const en = '<img src="https://fsms.quadcode.com/storage/public/da/qe/s4iq83us706t3t4g/icon1.png" class="i">';
const ar = '<img src="https://fsms.quadcode.com/storage/public/aa/bb/zzzz/icon1.png?v=2"><img src="https://cdn.x/xicon1.png">';
assert.equal(RA.looksLikeImage('https://fsms.quadcode.com/storage/public/da/qe/s4iq83us706t3t4g/icon1.png'), true);
assert.equal(RA.looksLikeImage('Grafik live'), false);
assert.equal(RA.countIn(ar, 'icon1.png', { mode: 'filename' }), 1, 'xicon1.png is a different file');
assert.equal(RA.countIn(en, 'https://other.host/any/path/icon1.png', { mode: 'filename' }), 1, 'full URL query works by file name');
assert.equal(RA.replaceIn(ar, 'icon1.png', 'https://new.cdn/icon1-v2.png', { mode: 'filename' }).value,
  '<img src="https://new.cdn/icon1-v2.png"><img src="https://cdn.x/xicon1.png">', 'whole URL (incl. query) is replaced');

// Hits carry kind + context for the UI and for models.
const s = RA.scan('<a href="https://x.com/a"><img src="https://x.com/a"></a> see https://x.com/a <td style="background:url(https://x.com/a)">', 'https://x.com/a');
assert.deepEqual(plain(s.hits.map((h) => h.kind)), ['link', 'image', 'text', 'background']);
assert.equal(s.count, 4);

// Studio shape: code + namespaces, locked namespaces reported but untouched.
const namespaces = [
  { id: 'n1', name: 'promo', locales: { en: ['Hello', 'Visit https://x.com/a'], ar: ['https://x.com/a'], de: ['nothing'] } },
  { id: 'n2', name: 'footer_upload', builtin: true, locales: { en: ['https://x.com/a terms'] } },
];
const code = '<img src="https://x.com/a"><a href="https://x.com/a">x</a>';
const p = RA.plan({ code, namespaces, find: 'https://x.com/a' });
assert.equal(p.code.count, 2);
assert.deepEqual(plain(p.locales.map((l) => [l.nsName, l.locale, l.count, l.locked])), [['footer_upload', 'en', 1, true], ['promo', 'ar', 1, false], ['promo', 'en', 1, false]]);
assert.equal(p.editableTotal, 4);
const r = RA.apply({ code, namespaces, find: 'https://x.com/a', replacement: 'https://z.com/b', selection: { code: true, locales: ['n1|en', 'n2|en'] } });
assert.equal(r.code, '<img src="https://z.com/b"><a href="https://z.com/b">x</a>');
assert.deepEqual(plain(r.patches), [{ nsId: 'n1', locale: 'en', blocks: ['Hello', 'Visit https://z.com/b'], count: 1 }]);
assert.equal(namespaces[0].locales.en[1], 'Visit https://x.com/a', 'pure');

// Own value per place (e.g. a localized banner per locale).
const own = RA.apply({ code, namespaces, find: 'https://x.com/a', replacement: 'https://all.com', selection: { code: true, locales: ['n1|en', 'n1|ar'] }, replacements: { 'n1|ar': 'https://ar.com' } });
assert.equal(own.code, '<img src="https://all.com"><a href="https://all.com">x</a>');
assert.deepEqual(plain(own.patches.map((p) => [p.locale, p.blocks.join(' ')])), [['en', 'Hello Visit https://all.com'], ['ar', 'https://ar.com']]);

// MoEngage shape: { LOCALE: html }
assert.deepEqual(plain(RA.planLocales({ EN: en, AR: ar }, 'icon1.png', { mode: 'filename' }).map((x) => [x.locale, x.count])), [['EN', 1], ['AR', 1]]);
console.log('✓ replace-across core: &amp;-aware, filename mode, kinds, studio + MoEngage shapes');
