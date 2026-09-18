(function (root) {
  'use strict';

  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const TEXT_TYPES = new Set(['text/plain', 'text/html', 'text/css', 'text/javascript', 'application/javascript', 'application/json', 'text/markdown']);
  const TEXT_EXTENSIONS = new Set(['txt', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'md', 'markdown']);
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_TEXT_BYTES = 512 * 1024;
  const MAX_COUNT = 4;

  function extensionOf(name) {
    const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  }

  function attachmentKind(file) {
    const type = String(file?.type || file?.mime || '').split(';')[0].trim().toLowerCase();
    if (IMAGE_TYPES.has(type)) return 'image';
    if (TEXT_TYPES.has(type) || TEXT_EXTENSIONS.has(extensionOf(file?.name))) return 'text';
    return '';
  }

  function validateAttachmentMeta(file) {
    const kind = attachmentKind(file);
    const size = Number(file?.size || 0);
    if (!kind) return { ok: false, reason: 'Drop an image or HTML/TXT/JSON/CSS/JS/MD file' };
    if (size <= 0) return { ok: false, reason: 'File is empty' };
    const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (size > max) return { ok: false, reason: kind === 'image' ? 'Image is larger than 12 MiB' : 'Text file is larger than 512 KiB' };
    return { ok: true, reason: '', kind };
  }

  function limitAttachments(items) {
    return Array.from(items || []).slice(0, MAX_COUNT);
  }

  root.__RetKitAiAttachmentCore = {
    validateAttachmentMeta,
    limitAttachments,
    attachmentKind,
    MAX_BYTES: MAX_IMAGE_BYTES,
    MAX_IMAGE_BYTES,
    MAX_TEXT_BYTES,
    MAX_COUNT,
  };
  if (typeof document === 'undefined') return;

  const STYLE_ID = 'retkit-ai-attachment-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .rk-ai-attachment-bar { display:flex; align-items:center; gap:6px; margin-bottom:6px; min-height:28px; }
      .rk-ai-attachment-bar[hidden] { display:none !important; }
      .rk-ai-attachment-chips { flex:1; min-width:0; display:flex; gap:5px; overflow-x:auto; }
      .rk-ai-chip { display:flex; align-items:center; gap:5px; max-width:190px; height:28px; padding:3px 6px; border:1px solid #334155; border-radius:7px; background:#111a26; color:#aebdce; font-size:10px; }
      .rk-ai-chip img { width:20px; height:20px; object-fit:cover; border-radius:4px; }
      .rk-ai-file-icon { min-width:24px; font-size:8px; font-weight:800; color:#8fa2b8; text-align:center; }
      .rk-ai-chip span { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
      .rk-ai-chip button { border:0; background:transparent; color:#8fa2b8; cursor:pointer; padding:0; }
      .rk-ai-chat { position:relative; }
      .rk-ai-drop-active { outline:2px dashed #5682ff; outline-offset:-4px; }
      .rk-ai-drop-active::after { content:"Drop files into chat"; position:absolute; inset:8px; z-index:20; display:grid; place-items:center; pointer-events:none; border-radius:10px; background:rgba(13,20,30,.88); color:#dfe8f7; font:700 13px/1.2 Inter,ui-sans-serif,sans-serif; }
      .rk-ai-attachment-error { color:#ff8d94; font-size:10px; margin-left:auto; }
    `;
    document.head.appendChild(style);
  }

  function createAttachmentTray({ bridgeClient, dropTarget } = {}) {
    injectStyle();
    const bar = document.createElement('div');
    bar.className = 'rk-ai-attachment-bar';
    bar.hidden = true;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.style.setProperty('display', 'none', 'important');
    const chips = document.createElement('div');
    chips.className = 'rk-ai-attachment-chips';
    const error = document.createElement('div');
    error.className = 'rk-ai-attachment-error';
    bar.append(input, chips, error);

    const pending = [];

    function updateVisibility() {
      bar.hidden = pending.length === 0 && !error.textContent;
    }

    function setError(message) {
      error.textContent = String(message || '');
      updateVisibility();
      if (message) root.setTimeout?.(() => {
        if (error.textContent === message) {
          error.textContent = '';
          updateVisibility();
        }
      }, 4500);
    }

    function render() {
      chips.replaceChildren();
      for (const item of pending) {
        const chip = document.createElement('div');
        chip.className = 'rk-ai-chip';
        if (item.kind === 'image') {
          const img = document.createElement('img');
          try { img.src = item.previewUrl || (item.previewUrl = URL.createObjectURL(item.file)); } catch {}
          chip.appendChild(img);
        } else {
          const icon = document.createElement('span');
          icon.className = 'rk-ai-file-icon';
          icon.textContent = (extensionOf(item.name) || 'FILE').slice(0, 4).toUpperCase();
          chip.appendChild(icon);
        }
        const name = document.createElement('span');
        name.textContent = item.name;
        name.title = item.name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = `Remove ${item.name}`;
        remove.addEventListener('click', () => {
          const index = pending.indexOf(item);
          if (index >= 0) pending.splice(index, 1);
          if (item.previewUrl) try { URL.revokeObjectURL(item.previewUrl); } catch {}
          render();
        });
        chip.append(name, remove);
        chips.appendChild(chip);
      }
      updateVisibility();
    }

    async function addFiles(fileList) {
      const files = limitAttachments(Array.from(fileList || []));
      for (const file of files) {
        if (pending.length >= MAX_COUNT) { setError('Maximum 4 files per message'); break; }
        const valid = validateAttachmentMeta(file);
        if (!valid.ok) { setError(valid.reason); continue; }
        const localId = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const item = {
          localId,
          file,
          kind: valid.kind,
          name: file.name || (valid.kind === 'image' ? 'image' : 'file'),
          mime: file.type || '',
          size: file.size,
          status: 'uploading',
          attachmentId: null,
        };
        pending.push(item);
        render();
        try {
          const uploaded = await bridgeClient.uploadAttachment(file);
          item.status = 'ready';
          item.attachmentId = uploaded.attachmentId;
        } catch (uploadError) {
          item.status = 'error';
          setError(uploadError?.message || String(uploadError));
        }
        render();
      }
      return pending;
    }

    input.addEventListener('change', async () => { await addFiles(input.files); input.value = ''; });

    const target = dropTarget || document;
    let dragDepth = 0;
    target.addEventListener?.('dragenter', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      dropTarget?.classList?.add('rk-ai-drop-active');
    });
    target.addEventListener?.('dragover', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      dropTarget?.classList?.add('rk-ai-drop-active');
    });
    target.addEventListener?.('dragleave', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropTarget?.classList?.remove('rk-ai-drop-active');
    });
    target.addEventListener?.('drop', async (event) => {
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      event.preventDefault();
      dragDepth = 0;
      dropTarget?.classList?.remove('rk-ai-drop-active');
      await addFiles(files);
    });
    target.addEventListener?.('paste', async (event) => {
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.length) return;
      event.preventDefault();
      await addFiles(files);
    });

    function clearPending() {
      for (const item of pending) if (item.previewUrl) try { URL.revokeObjectURL(item.previewUrl); } catch {}
      pending.length = 0;
      render();
    }

    return { element: bar, addFiles, getPending: () => pending.slice(), clearPending, setError };
  }

  root.__RetKitAiAttachments = { createAttachmentTray };
})(typeof globalThis !== 'undefined' ? globalThis : this);
