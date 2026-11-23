// RetKit UCC Export: архив собирается из ответа UCC, без JWT, и открывается обычным unzip.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const src = fs.readFileSync(new URL('../src/ucc/retkit-ucc-export.user.js', import.meta.url), 'utf8');
const tpl = {
  id: 15928, name: '2fa-code', brand_id: 1, email_category_id: 3, email_sender_id: 1, preset_id: null, status_id: 3,
  microservice_name: 'auth', microservice: { Name: 'auth', Title: 'Auth', JWT: 'SECRET.JWT.TOKEN' },
  locales: [
    { locale: { short_name: 'en', name: 'en_US', title: 'English' }, status: { name: 'Ready' }, subject: 'Confirm your login', html_body: '<p>Hello {{code}}</p>' },
    { locale: { short_name: 'ru', name: 'ru_RU', title: 'Russian' }, status: { name: 'Ready' }, subject: 'Подтвердите вход', html_body: '<p>Здравствуйте {{code}}</p>' },
  ],
};
const responses = {
  '/api/email/templates/15928': tpl,
  '/api/email/senders/': [{ id: 1, email: 'noreply@iqoption.com', name: 'IQ Option' }],
  '/api/email/categories': [{ id: 3, name: 'System' }],
};
const sandbox = {
  window: {}, location: { host: 'ucc.int.iqoption.com', pathname: '/' },
  document: { getElementById: () => null, createElement: () => ({ style: {}, dataset: {}, addEventListener() {}, click() {} }), body: { appendChild() {} } },
  fetch: async (url) => ({ ok: url in responses, status: url in responses ? 200 : 404, json: async () => responses[url] }),
  TextEncoder, Blob, URL, setInterval: () => 0, setTimeout, console, Uint8Array, Uint32Array, DataView, ArrayBuffer, Promise, JSON,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const api = sandbox.__retkitUccExport;
const mail = await api.collect(15928);
assert.equal(mail.microservice, 'auth');
assert.equal(mail.sender, 'noreply@iqoption.com (IQ Option)');
assert.equal(mail.category, 'System');
const { root, files } = api.filesFor(mail);
assert.equal(root, '2fa-code');
assert.ok(!files.some((f) => f.content.includes('SECRET')), 'JWT не попадает в архив');
const zip = Buffer.from(await api.makeZip(files).arrayBuffer());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucc-zip-'));
fs.writeFileSync(path.join(dir, 'a.zip'), zip);
execFileSync('unzip', ['-q', 'a.zip'], { cwd: dir });
assert.equal(fs.readFileSync(path.join(dir, '2fa-code/ru/index.html'), 'utf8'), '<p>Здравствуйте {{code}}</p>');
assert.equal(fs.readFileSync(path.join(dir, '2fa-code/en/subject.txt'), 'utf8'), 'Confirm your login\n');
const params = fs.readFileSync(path.join(dir, '2fa-code/params.txt'), 'utf8');
assert.match(params, /Microservice: auth/);
assert.match(params, /Locales \(2\): EN, RU/);
console.log('✓ ucc export: params, subjects, per-locale HTML, no JWT, valid zip');
