(function (root) {
  'use strict';

  function makeLineDiff(before, after, maxLines = 120) {
    const a = String(before ?? '').split('\n');
    const b = String(after ?? '').split('\n');
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
    const rows = [];
    const contextStart = Math.max(0, prefix - 2);
    for (let i = contextStart; i < prefix; i += 1) rows.push({ type: 'same', text: a[i] });
    for (const line of a.slice(prefix, Math.max(prefix, a.length - suffix))) rows.push({ type: 'remove', text: line });
    for (const line of b.slice(prefix, Math.max(prefix, b.length - suffix))) rows.push({ type: 'add', text: line });
    const suffixStart = Math.max(prefix, b.length - suffix);
    for (let i = suffixStart; i < Math.min(b.length, suffixStart + 2); i += 1) rows.push({ type: 'same', text: b[i] });
    if (rows.length > maxLines) return [...rows.slice(0, maxLines), { type: 'same', text: `… ${rows.length - maxLines} more changed/context lines` }];
    return rows;
  }

  root.__RetKitAiDiffCore = { makeLineDiff };
  if (typeof document === 'undefined') return;

  const cards = new Map();
  function ensureStyle() {
    if (document.getElementById('retkit-ai-diff-style')) return;
    const style = document.createElement('style');
    style.id = 'retkit-ai-diff-style';
    style.textContent = `
      .rk-ai-proposal { flex:0 0 auto; max-height:42%; overflow:auto; border-bottom:1px solid #334155; background:#0c131d; padding:8px; }
      .rk-ai-proposal-head { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
      .rk-ai-proposal-head strong { font-size:11px; color:#dce6f4; }
      .rk-ai-proposal-summary { flex:1; color:#8fa2b8; font-size:10px; }
      .rk-ai-diff { max-height:180px; overflow:auto; margin:6px 0; border:1px solid #263140; border-radius:7px; background:#080d13; font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
      .rk-ai-diff-row { white-space:pre-wrap; padding:1px 6px; }
      .rk-ai-diff-row[data-type="add"] { background:rgba(57,151,94,.18); color:#9ae5b8; }
      .rk-ai-diff-row[data-type="remove"] { background:rgba(188,67,76,.18); color:#ffabb0; }
      .rk-ai-diff-row[data-type="same"] { color:#697b90; }
      .rk-ai-proposal-actions { display:flex; gap:6px; }
      .rk-ai-proposal-actions button { height:27px; border:1px solid #334155; border-radius:7px; padding:0 9px; background:#172130; color:#dce6f4; cursor:pointer; font:700 10px inherit; }
      .rk-ai-proposal-actions .rk-ai-apply { background:#315be9; border-color:#4c75e7; color:#fff; }
      .rk-ai-proposal-actions .rk-ai-undo { background:#5e3e16; border-color:#8a642b; color:#ffe2aa; }
    `;
    document.head.appendChild(style);
  }

  function dismiss(id) { const card = cards.get(String(id)); card?.remove(); cards.delete(String(id)); }
  function dismissAll() { for (const id of [...cards.keys()]) dismiss(id); }

  function showProposal(proposal, options = {}) {
    ensureStyle();
    dismiss(proposal.id);
    const panel = document.getElementById('retkit-ai-panel');
    const body = document.getElementById('retkit-ai-body');
    if (!panel || !body) return false;
    const card = document.createElement('section');
    card.className = 'rk-ai-proposal';
    card.dataset.proposalId = proposal.id;
    const head = document.createElement('div');
    head.className = 'rk-ai-proposal-head';
    head.innerHTML = `<strong>${proposal.kind === 'subject' ? 'Subject proposal' : 'HTML proposal'}</strong><span class="rk-ai-proposal-summary"></span>`;
    head.querySelector('.rk-ai-proposal-summary').textContent = proposal.summary || 'AI suggested a change';
    const diff = document.createElement('div');
    diff.className = 'rk-ai-diff';
    for (const row of makeLineDiff(options.before, options.after)) {
      const line = document.createElement('div');
      line.className = 'rk-ai-diff-row';
      line.dataset.type = row.type;
      line.textContent = `${row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' '} ${row.text}`;
      diff.appendChild(line);
    }
    const actions = document.createElement('div');
    actions.className = 'rk-ai-proposal-actions';
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'rk-ai-apply'; apply.textContent = 'Apply';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try { await options.apply?.(); } catch (error) { apply.disabled = false; apply.textContent = error?.code === 'STALE_PROPOSAL' ? 'Stale – ask AI again' : 'Apply failed'; }
    });
    cancel.addEventListener('click', () => { options.cancel?.(); dismiss(proposal.id); });
    actions.append(apply, cancel);
    card.append(head, diff, actions);
    panel.insertBefore(card, body);
    cards.set(proposal.id, card);
    return true;
  }

  function markApplied(id, onUndo) {
    const card = cards.get(String(id));
    if (!card) return;
    const actions = card.querySelector('.rk-ai-proposal-actions');
    if (!actions) return;
    actions.replaceChildren();
    const label = document.createElement('span'); label.textContent = 'Applied'; label.style.color = '#72d6a0'; label.style.fontSize = '10px';
    const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'rk-ai-undo'; undo.textContent = 'Undo AI change';
    undo.addEventListener('click', async () => { undo.disabled = true; try { await onUndo?.(); } catch { undo.disabled = false; } });
    actions.append(label, undo);
  }

  root.__RetKitAiDiff = { showProposal, markApplied, dismiss, dismissAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);
