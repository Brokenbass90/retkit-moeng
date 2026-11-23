// Почтовый ящик RetKit для конвейера UCC → MoEngage.
//
// Три участника, все на компьютере человека:
//   claude — агент (шлёт команды со страницы MoEngage во встроенном браузере),
//   ucc    — вкладка UCC со скриптом RetKit UCC Export,
//   mo     — вкладка MoEngage с RetKit.
// Сообщение: { id, ts, from, to, type, ...data }. Ящик держит последние MAX сообщений
// в памяти процесса (ничего не пишет на диск). Получатель читает по номеру after;
// long-poll ждёт новое сообщение до waitMs.

const MAX = 300;
const ROLES = new Set(['claude', 'ucc', 'mo']);

export function createMailbox({ max = MAX } = {}) {
  let seq = 0;
  const messages = [];
  const waiters = new Set();

  function post(from, to, body = {}) {
    if (!ROLES.has(from) || !ROLES.has(to)) throw new Error(`Unknown role: ${from} → ${to}`);
    const type = String(body.type || '').trim();
    if (!type) throw new Error('Message type is required');
    const msg = { ...body, id: ++seq, ts: Date.now(), from, to, type };
    messages.push(msg);
    while (messages.length > max) messages.shift();
    for (const w of [...waiters]) if (w.to === msg.to) { waiters.delete(w); w.resolve(); }
    return msg;
  }

  function list({ to, after = 0, type, limit = 50 } = {}) {
    return messages.filter((m) => (!to || m.to === to) && m.id > Number(after || 0) && (!type || m.type === type)).slice(-limit);
  }

  /** Последнее сообщение типа type для получателя to, где все поля match совпадают. */
  function latest({ to, type, match = {} }) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.to !== to || m.type !== type) continue;
      if (Object.entries(match).every(([k, v]) => v == null || String(m[k]) === String(v))) return m;
    }
    return null;
  }

  function poll({ to, after = 0, waitMs = 0 }) {
    const now = list({ to, after });
    if (now.length || !waitMs) return Promise.resolve(now);
    return new Promise((resolve) => {
      const w = { to, resolve: () => { clearTimeout(timer); resolve(list({ to, after })); } };
      const timer = setTimeout(() => { waiters.delete(w); resolve([]); }, Math.min(Number(waitMs) || 0, 25000));
      waiters.add(w);
    });
  }

  function lastId() { return seq; }
  function close() { for (const w of waiters) w.resolve(); waiters.clear(); }

  return { post, list, latest, poll, lastId, close };
}

export const MAILBOX_ORIGINS = [
  'https://dashboard-02.moengage.com',
  'https://ucc.iqoption.com',
  'https://ucc.int.iqoption.com',
];

export function isMailboxOrigin(origin) {
  if (!origin) return false;
  try { const u = new URL(String(origin)); return MAILBOX_ORIGINS.includes(`${u.protocol}//${u.host}`); } catch { return false; }
}
