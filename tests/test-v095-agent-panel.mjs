// v0.9.5: AI в расширении — статус + «для агента» + лента; писать агенту в Claude/Codex.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const panelSrc = fs.readFileSync(new URL('../src/ai/ui/ai-panel.js', import.meta.url), 'utf8');
const relaySrc = fs.readFileSync(new URL('../src/ai/client/agent-relay.js', import.meta.url), 'utf8');
const sandbox = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(panelSrc, sandbox);
const { agentView, agoText } = sandbox.__RetKitAiUiCore;
const now = 1_800_000_000_000;

assert.equal(agentView({ relay: 'off' }, now).tone, 'idle');
assert.equal(agentView({ relay: 'off' }, now).action, 'connect');
assert.equal(agentView({ relay: 'opening' }, now).tone, 'wait');
assert.equal(agentView({ relay: 'on', agentSeenAt: 0 }, now).action, 'copy', 'relay open, agent never came: offer the text');
assert.equal(agentView({ relay: 'on', agentSeenAt: now - 120000, client: 'Claude' }, now).title, 'Claude подключён · был 2 мин назад');
assert.equal(agentView({ relay: 'on', busy: true, client: 'Codex' }, now).title, 'Codex работает…');
assert.equal(agentView({ relay: 'on', agentSeenAt: now - 3 * 24 * 3600e3 }, now).tone, 'wait', 'stale visit counts as not connected');
assert.equal(agoText(now - 5000, now), 'только что');

// Индикатор живёт в одном месте и не зависит от открытия панели.
assert.match(relaySrc, /const agentState = \{/);
assert.match(relaySrc, /subscribe, feedText/);
assert.match(panelSrc, /agentUnsub = root\.__RetKitAgentRelay\?\.subscribe\?\.\(renderAgent\)/);
// Писать в расширении нельзя — только статус и лента.
assert.match(panelSrc, /Писать агенту — в Claude или Codex, не здесь/);
assert.match(panelSrc, /if \(!localMode\(\)\) return mountAgentPanel/);
// Кнопки «Агент» в верхней панели больше нет.
assert.match(relaySrc, /getElementById\('retkit-agent-button'\)\?\.remove\(\)/);
console.log('✓ v0.9.5: agent panel');
