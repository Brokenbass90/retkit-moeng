#!/usr/bin/env node
/**
 * Распаковка письма из UCC (JSON от /api/email/templates/<id>) в папки:
 *   <out>/<microservice>/<name>/params.txt, subjects.txt, <locale>/index.html, <locale>/subject.txt
 * и отчёт по футеру: какие плейсхолдеры UCC встречаются и чем их заменить для MoEngage.
 *
 * node tools/ucc-unpack.mjs <ucc.json> [<out>=migration] [--map tools/ucc-footer-map.json]
 *
 * Карта футера — tools/ucc-footer-map.json: { "{{embedded.risk_warning}}": "<чем заменить в MoEngage>" }.
 * Пустое значение = замена ещё не согласована: плейсхолдер остаётся как есть и попадает в отчёт.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const input = args[0];
if (!input) { console.error('usage: ucc-unpack.mjs <ucc.json> [out] [--map file]'); process.exit(2); }
const out = args[1] && !args[1].startsWith('--') ? args[1] : 'migration';
const mapIdx = args.indexOf('--map');
const mapPath = mapIdx >= 0 ? args[mapIdx + 1] : new URL('./ucc-footer-map.json', import.meta.url).pathname;
const footerMap = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : {};

const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const tpl = raw.template || raw;
const list = (v) => (Array.isArray(v) ? v : v?.data || v?.items || []);
const sender = list(raw.senders).find((s) => s.id === tpl.email_sender_id);
const category = list(raw.categories).find((c) => c.id === tpl.email_category_id);
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();

const ms = safe(tpl.microservice_name || tpl.microservice?.Name || 'no-microservice');
const dir = path.join(out, ms, safe(tpl.name));
fs.mkdirSync(dir, { recursive: true });

const placeholderRe = /\{\{\s*[^{}]+?\s*\}\}/g;
const report = { name: tpl.name, id: tpl.id, microservice: ms, locales: [], placeholders: {}, footerUnmapped: new Set() };

for (const l of tpl.locales || []) {
  const code = safe(l.locale?.short_name || l.locale?.name || l.locale_id);
  let html = l.html_body || '';
  for (const [from, to] of Object.entries(footerMap)) if (to) html = html.split(from).join(to);
  for (const from of Object.keys(footerMap)) if (!footerMap[from] && html.includes(from)) report.footerUnmapped.add(from);
  for (const m of html.match(placeholderRe) || []) report.placeholders[m] = (report.placeholders[m] || 0) + 1;
  fs.mkdirSync(path.join(dir, code), { recursive: true });
  fs.writeFileSync(path.join(dir, code, 'index.html'), html);
  fs.writeFileSync(path.join(dir, code, 'subject.txt'), `${l.subject || ''}\n`);
  report.locales.push({ code, name: l.locale?.name, status: l.status?.name, subject: l.subject || '', empty: !html.trim(), bytes: html.length });
}

const params = [
  `Name: ${tpl.name}`, `Template ID: ${tpl.id}`, raw.host ? `UCC: https://${raw.host}/email-templates/${tpl.id}/edit` : '',
  `Microservice: ${ms}`, `Sender: ${sender?.email || sender?.name || tpl.email_sender_id}`,
  `Category: ${category?.name || category?.title || tpl.email_category_id}`, `Brand ID: ${tpl.brand_id}`,
  `Locales (${report.locales.length}): ${report.locales.map((l) => l.code.toUpperCase()).join(', ')}`, '',
  ...report.locales.map((l) => `${l.code.toUpperCase()}\t${l.status || ''}\t${l.subject}`), '',
].filter((x) => x !== '' || true).join('\n');
fs.writeFileSync(path.join(dir, 'params.txt'), params);
fs.writeFileSync(path.join(dir, 'subjects.txt'), report.locales.map((l) => `${l.code}\t${l.subject}`).join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ ...report, footerUnmapped: [...report.footerUnmapped] }, null, 2));
console.log(JSON.stringify({ dir, locales: report.locales.length, empty: report.locales.filter((l) => l.empty).map((l) => l.code), placeholders: report.placeholders, footerUnmapped: [...report.footerUnmapped] }, null, 2));
