// ==UserScript==
// @name         RetKit UCC Export
// @namespace    https://github.com/Brokenbass90/retkit-moeng
// @version      0.1.0
// @description  Кнопка «⬇ ZIP письма» в UCC: все локали письма (HTML + Subject) и параметры одним архивом. Только чтение.
// @match        https://ucc.iqoption.com/*
// @match        https://ucc.int.iqoption.com/*
// @updateURL    https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-ucc-export.user.js
// @downloadURL  https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/dist/retkit-ucc-export.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Зачем: перенос системных писем из UCC (в MoEngage и куда угодно) — это
 * «открыть письмо → в каждой локали Ctrl+A, Ctrl+C → скопировать тему →
 * посмотреть настройки». Тут то же самое одной кнопкой.
 *
 * Только чтение: скрипт делает те же GET-запросы, что и сама страница
 * (/api/email/templates/<id>, /api/email/senders/, /api/email/categories).
 * Ничего не сохраняет в UCC и не жмёт кнопки. Токен микросервиса (JWT) из
 * ответа в архив не попадает.
 *
 * Архив: <имя письма>/
 *          params.txt           — название, id, микросервис, отправитель, категория, локали
 *          subjects.txt         — тема каждой локали
 *          <локаль>/index.html  — код локали как в редакторе
 *          <локаль>/subject.txt
 */
(function () {
  'use strict';
  if (window.__retkitUccExport) return;

  // ─── ZIP без зависимостей (метод STORE) ───────────────────────────────────
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeZip(files) {
    const enc = new TextEncoder();
    const chunks = []; const central = []; let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const file of files) {
      const name = enc.encode(file.path);
      const data = typeof file.content === 'string' ? enc.encode(file.content) : file.content;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), name, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  // ─── Данные письма ────────────────────────────────────────────────────────
  async function getJson(url) {
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }
  function asList(value) {
    if (Array.isArray(value)) return value;
    for (const key of ['data', 'items', 'results', 'senders', 'categories']) if (Array.isArray(value?.[key])) return value[key];
    return [];
  }
  function describe(item) {
    if (!item) return '';
    const main = item.email || item.address || item.from || item.name || item.title || '';
    const extra = item.name && item.name !== main ? ` (${item.name})` : '';
    return `${main}${extra}`.trim() || JSON.stringify(item);
  }
  function safe(value, fallback) {
    const s = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
    return s || fallback;
  }

  async function collect(id) {
    const tpl = await getJson(`/api/email/templates/${id}`);
    const [senders, categories] = await Promise.all([
      getJson('/api/email/senders/').then(asList).catch(() => []),
      getJson('/api/email/categories').then(asList).catch(() => []),
    ]);
    const sender = senders.find((s) => s.id === tpl.email_sender_id);
    const category = categories.find((c) => c.id === tpl.email_category_id);
    const locales = (tpl.locales || []).map((l) => ({
      code: l.locale?.short_name || l.locale?.name || String(l.locale_id),
      name: l.locale?.name || '',
      title: l.locale?.title || '',
      status: l.status?.name || String(l.status_id ?? ''),
      subject: l.subject || '',
      html: l.html_body || '',
    }));
    return {
      id: tpl.id,
      name: tpl.name || `template-${id}`,
      host: location.host,
      microservice: tpl.microservice_name || tpl.microservice?.Name || '',
      microserviceTitle: tpl.microservice?.Title || '',
      brandId: tpl.brand_id,
      sender: describe(sender) || (tpl.email_sender_id != null ? `id ${tpl.email_sender_id}` : ''),
      category: describe(category) || (tpl.email_category_id != null ? `id ${tpl.email_category_id}` : ''),
      presetId: tpl.preset_id,
      status: tpl.status_id,
      updatedAt: tpl.updated_at,
      locales,
    };
  }

  function filesFor(mail) {
    const root = safe(mail.name, `template-${mail.id}`);
    const params = [
      `Name: ${mail.name}`,
      `Template ID: ${mail.id}`,
      `UCC: https://${mail.host}/email-templates/${mail.id}/edit`,
      `Microservice: ${mail.microservice}${mail.microserviceTitle && mail.microserviceTitle !== mail.microservice ? ` (${mail.microserviceTitle})` : ''}`,
      `Sender: ${mail.sender}`,
      `Category: ${mail.category}`,
      `Brand ID: ${mail.brandId ?? ''}`,
      `Preset ID: ${mail.presetId ?? '-'}`,
      `Updated: ${mail.updatedAt || ''}`,
      `Locales (${mail.locales.length}): ${mail.locales.map((l) => l.code.toUpperCase()).join(', ')}`,
      '',
      ...mail.locales.map((l) => `${l.code.toUpperCase()}\t${l.status}\t${l.subject}`),
      '',
    ].join('\n');
    const files = [
      { path: `${root}/params.txt`, content: params },
      { path: `${root}/subjects.txt`, content: mail.locales.map((l) => `${l.code}\t${l.subject}`).join('\n') + '\n' },
    ];
    for (const l of mail.locales) {
      const dir = `${root}/${safe(l.code, 'locale')}`;
      files.push({ path: `${dir}/index.html`, content: l.html });
      files.push({ path: `${dir}/subject.txt`, content: `${l.subject}\n` });
    }
    return { root, files };
  }

  async function exportZip(id) {
    const mail = await collect(id);
    const { root, files } = filesFor(mail);
    const url = URL.createObjectURL(makeZip(files));
    Object.assign(document.createElement('a'), { href: url, download: `${root}.zip` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    return { name: mail.name, locales: mail.locales.length };
  }

  // ─── Кнопка ───────────────────────────────────────────────────────────────
  const BUTTON_ID = 'retkit-ucc-export';
  function templateId() {
    const m = location.pathname.match(/\/email-templates\/(\d+)/);
    return m ? m[1] : null;
  }
  function sync() {
    const id = templateId();
    let button = document.getElementById(BUTTON_ID);
    if (!id) { button?.remove(); return; }
    if (button) { button.dataset.id = id; return; }
    button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.dataset.id = id;
    button.textContent = '⬇ ZIP письма';
    button.title = 'RetKit: скачать все локали письма (HTML + Subject) и параметры одним архивом. Только чтение.';
    Object.assign(button.style, {
      position: 'fixed', right: '20px', bottom: '20px', zIndex: 99999, padding: '10px 16px',
      borderRadius: '8px', border: 'none', background: '#3b5bfd', color: '#fff', font: '600 14px/1 sans-serif',
      cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,.25)',
    });
    button.addEventListener('click', async () => {
      const label = button.textContent;
      button.disabled = true; button.textContent = '⬇ собираю…';
      try {
        const r = await exportZip(button.dataset.id);
        button.textContent = `✓ ${r.locales} локалей`;
      } catch (error) {
        button.textContent = '✕ ошибка';
        alert(`RetKit UCC Export: ${error.message}`);
      } finally {
        setTimeout(() => { button.disabled = false; button.textContent = label; }, 2500);
      }
    });
    document.body.appendChild(button);
  }

  window.__retkitUccExport = { collect, filesFor, makeZip, exportZip };
  sync();
  setInterval(sync, 1000); // UCC — одностраничное приложение, адрес меняется без перезагрузки
})();
