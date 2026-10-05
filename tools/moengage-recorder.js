/*
 * RetKit · MoEngage recorder — только читает, ничего не меняет и никуда не отправляет.
 *
 * Как пользоваться:
 *   1. Откройте письмо в MoEngage, DevTools → Console (Chrome может попросить
 *      набрать «allow pasting» — это его обычная защита).
 *   2. Вставьте весь этот файл и нажмите Enter. Справа внизу появится панель.
 *   3. В поле «Действие» напишите, что сейчас сделаете («создать локаль»),
 *      нажмите «Начать» и сделайте это на странице как обычно. Потом следующее.
 *   4. «Снимок страницы» — записать, какие кнопки и поля есть на экране (без значений).
 *   5. «Скачать журнал» — JSON-файл в «Загрузки». Его и пришлите.
 *   6. «Выключить» или перезагрузка страницы — и следа не останется.
 *
 * Что записывается: адрес и метод каждого запроса страницы, СТРУКТУРА того,
 * что ушло и пришло (имена полей и типы). Что НЕ записывается: значения —
 * токены, cookie, заголовки авторизации, email, тексты писем. Строки
 * заменяются на «<text len=42>», «<email>», «<id>», «<html len=…>».
 * Запросы страницы не меняются: обёртка передаёт их дальше как есть и
 * читает только копию ответа.
 */
(() => {
  "use strict";
  if (window.__retkitRecorder) { window.__retkitRecorder.show(); return; }

  const MAX_DEPTH = 7;
  const MAX_KEYS = 80;
  const MAX_EVENTS = 5000;
  const events = [];
  let action = "(без подписи)";
  let seq = 0;

  /* ── Обезличивание ─────────────────────────────────────────────── */
  const LOCALE = /^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/;
  const ID = /^([0-9a-f]{24}|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{6,})$/i;
  const ENUMISH = /^[A-Z][A-Z0-9_]{1,40}$|^[a-z][a-z0-9]*_[a-z0-9_]+$/; // DRAFT, email_campaign (обычные слова — это текст)

  function describeString(s) {
    if (s === "") return "";
    if (LOCALE.test(s)) return s;                       // коды локалей нужны как есть
    if (ID.test(s)) return "<id>";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "<email>";
    if (/^https?:\/\//i.test(s)) {
      try { const u = new URL(s); return `<url ${u.host}${u.pathname.replace(/[0-9a-f]{12,}|\d{4,}/gi, ":id")}>`; }
      catch { return "<url>"; }
    }
    if (/^\d{4}-\d\d-\d\dT/.test(s)) return "<datetime>";
    if (/<[a-z!][^>]*>/i.test(s)) return `<html len=${s.length}>`;
    if (s.length <= 40 && ENUMISH.test(s)) return `<enum ${s}>`; // служебные значения (статусы, типы)
    return `<text len=${s.length}>`;
  }

  function shape(value, depth = 0) {
    if (value === null) return null;
    const t = typeof value;
    if (t === "string") return describeString(value);
    if (t === "number") return "<number>";
    if (t === "boolean") return value;
    if (t !== "object") return `<${t}>`;
    if (depth >= MAX_DEPTH) return "<…>";
    if (Array.isArray(value)) {
      if (!value.length) return [];
      return { "<array>": value.length, first: shape(value[0], depth + 1) };
    }
    const out = {};
    const keys = Object.keys(value);
    for (const k of keys.slice(0, MAX_KEYS)) {
      // Подозрительные ключи — даже без значений.
      if (/token|secret|password|authorization|cookie|session|api[_-]?key/i.test(k)) { out[k] = "<hidden>"; continue; }
      out[k] = shape(value[k], depth + 1);
    }
    if (keys.length > MAX_KEYS) out["<more keys>"] = keys.length - MAX_KEYS;
    return out;
  }

  function shapeBody(body, contentType = "") {
    try {
      if (body == null || body === "") return null;
      if (typeof body === "string") {
        const s = body.trim();
        if (/json/i.test(contentType) || /^[{[]/.test(s)) {
          try { return { json: shape(JSON.parse(s)) }; } catch { /* не JSON */ }
        }
        if (/x-www-form-urlencoded/i.test(contentType) || /^[\w.%-]+=/.test(s)) {
          const form = {};
          for (const [k, v] of new URLSearchParams(s)) form[k] = shape(v);
          return { form };
        }
        return { text: describeString(s) };
      }
      if (body instanceof URLSearchParams) {
        const form = {}; for (const [k, v] of body) form[k] = shape(v); return { form };
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const form = {};
        for (const [k, v] of body) {
          form[k] = (typeof File !== "undefined" && v instanceof File)
            ? `<file ${v.type || "?"} ${v.size}b>` : shape(v);
        }
        return { multipart: form };
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) return { blob: `<${body.type || "blob"} ${body.size}b>` };
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { binary: `<${body.byteLength}b>` };
      return { other: Object.prototype.toString.call(body) };
    } catch (error) {
      return { error: String(error && error.message || error) };
    }
  }

  function cleanUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      const query = {};
      for (const [k, v] of u.searchParams) {
        query[k] = /token|secret|key|auth|sig/i.test(k) ? "<hidden>" : describeString(v);
      }
      return {
        host: u.host,
        path: u.pathname,
        // Шаблон пути: /campaigns/<id>/locales/<id> — так видно, что это одна ручка.
        route: u.pathname.replace(/\/([0-9a-f]{12,}|[0-9a-f-]{36}|\d{4,})(?=\/|$)/gi, "/:id"),
        query,
      };
    } catch {
      return { raw: "<unparsed>" };
    }
  }

  function record(entry) {
    if (events.length >= MAX_EVENTS) return;
    events.push({ n: ++seq, at: new Date().toISOString(), action, ...entry });
    ui.count();
  }

  /* ── fetch ─────────────────────────────────────────────────────── */
  const originalFetch = window.fetch;
  window.fetch = function retkitRecordedFetch(input, init) {
    const started = performance.now();
    let method = "GET", url = "", body = null, contentType = "";
    try {
      const req = input instanceof Request ? input : null;
      url = req ? req.url : String(input);
      method = String((init && init.method) || (req && req.method) || "GET").toUpperCase();
      body = init && "body" in init ? init.body : null;
      const headers = new Headers((init && init.headers) || (req && req.headers) || {});
      contentType = headers.get("content-type") || "";
      var headerNames = [...headers.keys()];
    } catch { /* не мешаем странице */ }
    const promise = originalFetch.apply(this, arguments);
    promise.then(async (response) => {
      let responseShape = null;
      try {
        const type = response.headers.get("content-type") || "";
        if (/json|text/i.test(type)) responseShape = shapeBody(await response.clone().text(), type);
        else responseShape = { type: type || "?" };
      } catch (error) { responseShape = { error: String(error && error.message || error) }; }
      record({
        via: "fetch", method, url: cleanUrl(url), requestHeaders: headerNames || [],
        request: shapeBody(body, contentType), status: response.status,
        ms: Math.round(performance.now() - started), response: responseShape,
      });
    }, (error) => {
      record({ via: "fetch", method, url: cleanUrl(url), request: shapeBody(body, contentType), status: "network-error", error: String(error && error.message || error) });
    });
    return promise;
  };

  /* ── XMLHttpRequest ────────────────────────────────────────────── */
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  const originalSetHeader = XHR.setRequestHeader;
  XHR.open = function (method, url) {
    try { this.__rk = { method: String(method || "GET").toUpperCase(), url: String(url), headers: {} }; } catch { /* */ }
    return originalOpen.apply(this, arguments);
  };
  XHR.setRequestHeader = function (name, value) {
    try { if (this.__rk) this.__rk.headers[String(name).toLowerCase()] = /content-type/i.test(name) ? String(value) : "<set>"; } catch { /* */ }
    return originalSetHeader.apply(this, arguments);
  };
  XHR.send = function (body) {
    const meta = this.__rk;
    if (meta) {
      const started = performance.now();
      const request = shapeBody(body, meta.headers["content-type"] || "");
      this.addEventListener("loadend", () => {
        let response = null;
        try {
          const type = this.getResponseHeader("content-type") || "";
          if (this.responseType === "" || this.responseType === "text") response = shapeBody(this.responseText, type);
          else if (this.responseType === "json") response = { json: shape(this.response) };
          else response = { type: this.responseType };
        } catch (error) { response = { error: String(error && error.message || error) }; }
        record({
          via: "xhr", method: meta.method, url: cleanUrl(meta.url), requestHeaders: Object.keys(meta.headers),
          request, status: this.status, ms: Math.round(performance.now() - started), response,
        });
      });
    }
    return originalSend.apply(this, arguments);
  };

  /* ── WebSocket (если страница им пользуется) ───────────────────── */
  const OriginalWS = window.WebSocket;
  const originalWsSend = OriginalWS && OriginalWS.prototype.send;
  if (originalWsSend) {
    OriginalWS.prototype.send = function (data) {
      try { record({ via: "ws-send", url: cleanUrl(this.url), request: shapeBody(data, "") }); } catch { /* */ }
      return originalWsSend.apply(this, arguments);
    };
  }

  /* ── Клики: что нажал человек (подпись кнопки, не содержимое) ──── */
  function labelOf(el) {
    if (!el) return "";
    const text = (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.value || "").trim();
    return text.replace(/\s+/g, " ").slice(0, 60);
  }
  function selectorOf(el) {
    if (!el || !el.tagName) return "";
    const parts = [];
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 5; i += 1) {
      let part = node.tagName.toLowerCase();
      const testId = node.getAttribute("data-testid") || node.getAttribute("data-test-id") || node.getAttribute("data-cy");
      if (node.id && !/\d{3,}/.test(node.id)) { part += `#${node.id}`; parts.unshift(part); break; }
      if (testId) part += `[data-testid="${testId}"]`;
      else if (node.classList.length) part += "." + [...node.classList].filter((c) => !/\d{3,}|^ng-|^css-/.test(c)).slice(0, 2).join(".");
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }
  function onClick(event) {
    const el = event.target && event.target.closest
      ? event.target.closest("button, a, [role=button], [role=tab], [role=menuitem], [role=option], input[type=checkbox], input[type=radio], select, label")
      : null;
    if (!el || el.closest("#retkitRecorderPanel")) return;
    record({ via: "click", label: labelOf(el), tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "", selector: selectorOf(el) });
  }
  document.addEventListener("click", onClick, true);

  /* ── Снимок страницы: какие элементы управления есть (без значений) */
  function snapshot() {
    const controls = [];
    const walk = (doc, frame) => {
      let nodes = [];
      try { nodes = doc.querySelectorAll("button, a[href], [role=button], [role=tab], [role=menuitem], input, select, textarea, [contenteditable=true], iframe"); }
      catch { return; }
      for (const el of nodes) {
        if (el.closest && el.closest("#retkitRecorderPanel")) continue;
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
        controls.push({
          frame,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || "",
          role: el.getAttribute("role") || "",
          name: el.getAttribute("name") || "",
          label: el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? (el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").slice(0, 60) : labelOf(el),
          visible: rect.width > 0 && rect.height > 0,
          disabled: Boolean(el.disabled),
          selector: selectorOf(el),
        });
        if (el.tagName === "IFRAME") {
          try { if (el.contentDocument) walk(el.contentDocument, `${frame} > iframe(${selectorOf(el)})`); } catch { /* чужой домен */ }
        }
      }
    };
    walk(document, "top");
    record({
      via: "snapshot",
      page: cleanUrl(location.href),
      title: describeString(document.title || ""),
      frameworks: {
        angular: Boolean(window.angular || document.querySelector("[ng-version]")),
        ngVersion: (document.querySelector("[ng-version]") || {}).getAttribute?.("ng-version") || "",
        react: Boolean(document.querySelector("[data-reactroot]") || [...document.querySelectorAll("body *")].slice(0, 300).some((n) => Object.keys(n).some((k) => k.startsWith("__react")))),
        froala: Boolean(window.FroalaEditor || document.querySelector(".fr-box")),
        retkit: Boolean(window.RetKit || window.__RetKitAiWorkspaceApi),
      },
      controls,
    });
  }

  /* ── Выгрузка ──────────────────────────────────────────────────── */
  function download() {
    const payload = {
      tool: "retkit-moengage-recorder",
      version: 1,
      createdAt: new Date().toISOString(),
      page: cleanUrl(location.href),
      userAgent: navigator.userAgent.replace(/\d+\.\d+\.\d+\.\d+/, "x"),
      note: "Значения обезличены: токены, cookie, email и тексты писем не записываются.",
      events,
    };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `moengage-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function stop() {
    window.fetch = originalFetch;
    XHR.open = originalOpen;
    XHR.send = originalSend;
    XHR.setRequestHeader = originalSetHeader;
    if (originalWsSend) OriginalWS.prototype.send = originalWsSend;
    document.removeEventListener("click", onClick, true);
    panel.remove();
    delete window.__retkitRecorder;
    console.log("[RetKit recorder] выключен, всё вернулось как было.");
  }

  /* ── Панель ────────────────────────────────────────────────────── */
  const panel = document.createElement("div");
  panel.id = "retkitRecorderPanel";
  panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;background:#111827;color:#f9fafb;"
    + "font:13px/1.4 -apple-system,Segoe UI,sans-serif;border-radius:10px;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,.35)";
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <b>● RetKit · запись</b><span data-rk="count" style="opacity:.75">0 событий</span>
    </div>
    <div data-rk="now" style="opacity:.8;margin-bottom:6px">Сейчас: (без подписи)</div>
    <input data-rk="action" placeholder="Действие: «создать локаль»" style="width:100%;box-sizing:border-box;padding:6px;border-radius:6px;border:0;margin-bottom:6px;color:#111">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
      <button data-rk="start">Начать действие</button>
      <button data-rk="snap">Снимок страницы</button>
      <button data-rk="save">Скачать журнал</button>
      <button data-rk="off">Выключить</button>
    </div>
    <div style="opacity:.6;font-size:11px;margin-top:6px">Только читает. Значения не записываются. Ничего никуда не отправляет.</div>`;
  for (const b of panel.querySelectorAll("button")) {
    b.style.cssText = "padding:6px;border-radius:6px;border:0;background:#f97316;color:#fff;cursor:pointer;font:inherit";
  }
  document.body.appendChild(panel);
  const $ = (k) => panel.querySelector(`[data-rk="${k}"]`);
  const ui = {
    count: () => { $("count").textContent = `${events.length} событий`; },
  };
  $("start").addEventListener("click", () => {
    action = $("action").value.trim() || `действие ${new Date().toLocaleTimeString()}`;
    $("now").textContent = `Сейчас: ${action}`;
    record({ via: "mark", label: action });
    $("action").value = "";
  });
  $("snap").addEventListener("click", snapshot);
  $("save").addEventListener("click", download);
  $("off").addEventListener("click", stop);

  window.__retkitRecorder = { events, snapshot, download, stop, show: () => { panel.style.display = ""; } };
  console.log("[RetKit recorder] включён. Панель справа внизу. Перезагрузка страницы выключает запись.");
})();
