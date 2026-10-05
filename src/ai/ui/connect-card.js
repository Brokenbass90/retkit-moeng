(function (root) {
  'use strict';

  // "Connect Claude / Codex" card shown inside RetKit AI while the local bridge
  // is not running (or the model CLI is missing / not logged in). The browser
  // cannot install programs by itself, so the card does the most it can:
  // detects Mac / Windows, gives the one installer for that system (copy one
  // line on Mac, download a .cmd on Windows) and waits for the bridge to come up.

  const INSTALL_BASE = 'https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/install';
  const CARD_ID = 'retkit-ai-connect-card';

  function detectOs(nav = root.navigator) {
    const raw = String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '').toLowerCase();
    if (raw.includes('win')) return 'windows';
    if (raw.includes('mac') || raw.includes('darwin')) return 'mac';
    if (raw.includes('linux')) return 'linux';
    return 'mac';
  }

  function installCommand(os, { codex = false } = {}) {
    if (os === 'windows') {
      const prefix = codex ? '$env:RETKIT_CODEX="1"; ' : '';
      return `${prefix}irm ${INSTALL_BASE}/install-windows.ps1 | iex`;
    }
    return `curl -fsSL ${INSTALL_BASE}/install-mac.sh | bash${codex ? ' -s -- --codex' : ''}`;
  }

  function windowsCmdFile({ codex = false } = {}) {
    return [
      '@echo off',
      'rem RetKit AI setup: installs Claude Code, the RetKit bridge and autostart.',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${codex ? '$env:RETKIT_CODEX=\'1\'; ' : ''}irm ${INSTALL_BASE}/install-windows.ps1 | iex"`,
      'echo.',
      'pause',
      '',
    ].join('\r\n');
  }

  // What the card should say for the current bridge/provider state.
  function connectView({ bridge = {}, provider = {}, providerId = 'claude' } = {}) {
    const name = providerId === 'codex' ? 'Codex' : 'Claude';
    if (String(bridge.status || '') !== 'connected') return { step: 'install', title: `Подключить ${name}` };
    if (!provider.detected) return { step: 'install', title: `${name} не найден на этом компьютере` };
    if (provider.authenticated === 'no') return { step: 'login', title: `Войдите в ${name}` };
    return null;
  }

  function render(host, state = {}) {
    if (typeof document === 'undefined' || !host) return;
    const view = connectView(state);
    let card = document.getElementById(CARD_ID);
    if (!view) { card?.remove(); return; }
    const os = detectOs();
    const key = `${view.step}|${view.title}|${os}`;
    if (card && card.dataset.key === key) return;
    card?.remove();
    card = document.createElement('div');
    card.id = CARD_ID;
    card.dataset.key = key;
    card.className = 'rk-ai-connect';

    const title = document.createElement('strong');
    title.textContent = view.title;
    card.appendChild(title);

    if (view.step === 'login') {
      const text = document.createElement('p');
      text.textContent = state.providerId === 'codex'
        ? 'Откройте Терминал, введите codex login и войдите в браузере. RetKit подхватит вход сам.'
        : 'Откройте Терминал, введите claude и войдите в браузере (потом /exit). RetKit подхватит вход сам.';
      card.appendChild(text);
      host.prepend(card);
      return;
    }

    const intro = document.createElement('p');
    intro.textContent = os === 'windows'
      ? 'Один раз: скачайте установщик и откройте его двойным кликом. Он поставит Claude Code, связку RetKit и автозапуск — дальше всё работает само.'
      : 'Один раз: скопируйте команду, откройте Терминал (⌘ Пробел → «Терминал»), вставьте ⌘V и нажмите Enter. Поставится Claude Code, связка RetKit и автозапуск — дальше всё работает само.';
    card.appendChild(intro);

    const codexLabel = document.createElement('label');
    codexLabel.className = 'rk-ai-connect-opt';
    const codex = document.createElement('input');
    codex.type = 'checkbox';
    codex.checked = state.providerId === 'codex';
    codexLabel.append(codex, document.createTextNode(' ещё и Codex'));

    const row = document.createElement('div');
    row.className = 'rk-ai-connect-row';
    const note = document.createElement('span');
    note.className = 'rk-ai-connect-note';

    if (os === 'windows') {
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'rk-ai-connect-primary';
      download.textContent = 'Скачать установщик для Windows';
      download.addEventListener('click', () => {
        const blob = new Blob([windowsCmdFile({ codex: codex.checked })], { type: 'application/octet-stream' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'RetKit-Connect.cmd';
        document.body.appendChild(link);
        link.click();
        setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
        note.textContent = 'Откройте RetKit-Connect.cmd из Загрузок. Если Windows предупредит — «Подробнее» → «Выполнить в любом случае».';
      });
      row.appendChild(download);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = os === 'windows' ? 'rk-ai-connect-secondary' : 'rk-ai-connect-primary';
    copy.textContent = os === 'windows' ? 'или скопировать команду PowerShell' : 'Скопировать команду';
    copy.addEventListener('click', async () => {
      const command = installCommand(os, { codex: codex.checked });
      try {
        await root.navigator.clipboard.writeText(command);
        note.textContent = os === 'windows'
          ? 'Скопировано. Win+X → «Терминал» → вставьте и Enter.'
          : 'Скопировано. Теперь ⌘ Пробел → «Терминал» → ⌘V → Enter.';
      } catch {
        note.textContent = command;
      }
    });
    row.appendChild(copy);
    card.append(codexLabel, row, note);

    const wait = document.createElement('p');
    wait.className = 'rk-ai-connect-wait';
    wait.textContent = 'RetKit сам увидит подключение — эту карточку можно не закрывать.';
    card.appendChild(wait);
    host.prepend(card);
  }

  root.__RetKitAiConnect = { detectOs, installCommand, windowsCmdFile, connectView, render, INSTALL_BASE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
