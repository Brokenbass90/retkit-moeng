// RetKit · разведка полей отправителя в MoEngage (только чтение, ничего не меняет и не кликает).
// Как запустить: открыть кампанию в MoEngage → DevTools (Cmd+Opt+I) → Console →
// вставить весь файл → Enter. Результат уже в буфере обмена — вставить в чат.
// Запустить на двух вкладках локали (например Default и ar_KW), чтобы понять,
// свои ли у каждой локали отправитель и прехедер.
(() => {
  const LABELS = ['Subject', 'Preview Text', 'Sender Name', 'From email address', 'Reply-to email address', 'Use same as'];
  const workspace = document.getElementById('rk-workspace') || document.querySelector('[id^="rk-"][id*="workspace"]');
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const outside = (el) => !workspace || !workspace.contains(el);
  const cssPath = (el) => {
    const parts = [];
    for (let node = el, i = 0; node && node.nodeType === 1 && i < 6; node = node.parentElement, i += 1) {
      let part = node.tagName.toLowerCase();
      if (node.id) { part += `#${node.id}`; parts.unshift(part); break; }
      const cls = [...node.classList].filter((c) => !/^(css|sc|jss|Mui.*-\d+)/.test(c)).slice(0, 2);
      if (cls.length) part += `.${cls.join('.')}`;
      const tid = node.getAttribute('data-testid');
      if (tid) part += `[data-testid="${tid}"]`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const describe = (el) => el && ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || '',
    role: el.getAttribute('role') || '',
    name: el.getAttribute('name') || '',
    id: el.id || '',
    testid: el.getAttribute('data-testid') || el.closest('[data-testid]')?.getAttribute('data-testid') || '',
    placeholder: el.getAttribute('placeholder') || '',
    contenteditable: el.getAttribute('contenteditable') || '',
    disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    checked: el.type === 'checkbox' ? el.checked : undefined,
    value: (el.value ?? text(el)).slice(0, 120),
    reactProps: Object.keys(el).some((k) => k.startsWith('__reactProps')),
    path: cssPath(el),
  });
  const controlFor = (label) => {
    for (let box = label.parentElement, depth = 0; box && depth < 6; box = box.parentElement, depth += 1) {
      const found = [...box.querySelectorAll('input,textarea,select,[contenteditable="true"],[role="combobox"],[role="button"][aria-haspopup],[aria-haspopup="listbox"]')]
        .filter((el) => outside(el) && visible(el) && !label.contains(el));
      if (found.length) return found;
    }
    return [];
  };
  const fields = {};
  for (const wanted of LABELS) {
    const re = new RegExp(`^${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const labels = [...document.querySelectorAll('label,span,div,p,legend')]
      .filter((el) => outside(el) && visible(el) && re.test(text(el)) && text(el).length < wanted.length + 25)
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    const label = labels[0];
    fields[wanted] = label
      ? { label: text(label), labelPath: cssPath(label), controls: controlFor(label).slice(0, 3).map(describe) }
      : null;
  }
  const tabs = [...document.querySelectorAll('[role="tab"],button,a,li')]
    .filter((el) => outside(el) && visible(el) && /^(Default|[a-z]{2}_[A-Z]{2}|[A-Z]{2})(\s*close)?$/.test(text(el)))
    .map((el) => ({ label: text(el).replace(/\s*close$/, ''), selected: el.getAttribute('aria-selected') === 'true' || /active|selected/i.test(el.className) }));
  const senderBox = fields['Sender Name']?.labelPath ? document.querySelector(fields['Sender Name'].labelPath) : null;
  const tabBar = document.querySelector('[role="tablist"]');
  const report = {
    probe: 'retkit-sender-fields v1',
    url: location.href.replace(/[?#].*$/, ''),
    localeTabs: tabs,
    // Поля ниже панели вкладок локалей — скорее всего свои у каждой локали.
    senderBelowLocaleTabs: Boolean(senderBox && tabBar && (tabBar.compareDocumentPosition(senderBox) & Node.DOCUMENT_POSITION_FOLLOWING)),
    fields,
  };
  const json = JSON.stringify(report, null, 2);
  try { copy(json); } catch { navigator.clipboard?.writeText?.(json).catch(() => {}); }
  console.log(json);
  console.log('%cRetKit probe: результат в буфере обмена — вставьте его в чат.', 'color:#1a7f37;font-weight:bold');
})();
