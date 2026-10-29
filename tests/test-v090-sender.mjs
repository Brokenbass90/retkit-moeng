// v0.9.0: Preheader и отправитель в строке темы; пресеты; «на все локали».
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end}`);
  return source.slice(from, to);
}

const pure = [
  between(bridge, '  function normaliseSenderPreset(', '  function readSenderPresets('),
  between(bridge, '  function senderChangesNeeded(', '  function senderSummary('),
  between(bridge, '  function cleanDropdownText(', '  function readNativeSender('),
].join('\n');
const api = new Function(`${pure}; return { normaliseSenderPreset, normaliseSenderPresets, senderChangesNeeded, cleanDropdownText };`)();

// Стабильные testid из разведки MoEngage.
for (const id of ['email-preview-text', 'email-sender-name', 'email-reply-address', 'reply-email-same-checkbox', 'from-email-address']) {
  assert.ok(bridge.includes(`'${id}'`), `uses data-testid ${id}`);
}

assert.equal(api.cleanDropdownText('noreply@iqoption.comarrow_drop_up'), 'noreply@iqoption.com');

const p = api.normaliseSenderPreset({ senderName: '  IQ Option ', replySame: true, replyTo: 'x@y.z' });
assert.deepEqual(JSON.parse(JSON.stringify(p)), { name: 'IQ Option', senderName: 'IQ Option', replyTo: '', replySame: true, connector: '', fromEmail: '' }, 'reply-to dropped when same as From');

const store = api.normaliseSenderPresets({ presets: [{ senderName: 'IQ Option' }, { name: 'iq option', senderName: 'dup' }, { senderName: '' }, { name: 'Broker', senderName: 'IQ Broker', replySame: false, replyTo: 'help@iqbroker.com' }], last: 'Broker' });
assert.deepEqual(store.presets.map((x) => x.name), ['IQ Option', 'Broker'], 'dedupe by name, skip empty');
assert.equal(store.last, 'Broker');
assert.equal(api.normaliseSenderPresets({ presets: [{ senderName: 'A' }], last: 'gone' }).last, 'A', 'missing last falls back to the first preset');

const want = { senderName: 'IQ Option', replySame: true };
assert.deepEqual([...api.senderChangesNeeded({ senderName: 'IQ Option', replySame: true, replyTo: 'noreply@iqoption.com' }, want)], [], 'already set');
assert.deepEqual([...api.senderChangesNeeded({ senderName: '', replySame: true }, want)], ['senderName']);
assert.deepEqual([...api.senderChangesNeeded({ senderName: 'IQ Option', replySame: true }, { senderName: 'IQ Option', replySame: false, replyTo: 'help@x.com' })], ['replySame', 'replyTo']);

// Все локали: сначала сохраняем текущую правку, ядро в это время не пишет, в конце — назад.
const applyAll = between(bridge, '  async function applySenderToLocales(', '  function paintSenderChip(');
assert.ok(applyAll.indexOf('flushBeforeLocaleSwitch') < applyAll.indexOf('switchNativeLocale'), 'flush before walking locales');
assert.match(applyAll, /setMultiLocaleBusy\?\.\(true/, 'core sync paused during the walk');
assert.match(applyAll, /finally \{[\s\S]*switchNativeLocale\(origin[\s\S]*setMultiLocaleBusy\?\.\(false\)/, 'always returns to the original locale and resumes');
assert.match(core, /setMultiLocaleBusy: \(value, message\) =>/, 'core exposes setMultiLocaleBusy');

// Каждая запись проверяется чтением назад.
const write = between(bridge, '  async function writeNativeSender(', '  async function applySenderToLocales(');
assert.match(write, /const after = readNativeSender\(\);[\s\S]*senderChangesNeeded\(after, want\)/, 'verifies after writing');

// UI: preheader и чип в строке темы.
const row = between(bridge, "      input.addEventListener('change', () => commitSubjectToMoEngage(input.value));", "row.insertAdjacentElement('afterend', subjectRow);");
assert.match(row, /subjectRow\.append\(label, input, preLabel, pre, chip\)/);
assert.match(between(bridge, '  function syncSubjectFromMoEngage(', '  function syncSubjectOnlyFromMoEngage('), /syncPreheaderFromMoEngage[\s\S]*paintSenderChip/, 'heartbeat keeps preheader and chip in sync');

// v0.9.1: Connector и From — выбор, пишется раньше имени.
assert.deepEqual([...api.senderChangesNeeded({ senderName: 'IQ Option', replySame: true, connector: 'IQOption', fromEmail: 'noreply@iqoption.com' }, { senderName: 'IQ Option', connector: 'IQBroker', fromEmail: 'noreply@iqbroker.com' })], ['connector', 'fromEmail']);
assert.ok(write.indexOf("selectSenderDropdown('connector'") < write.indexOf("selectSenderDropdown('from'"), 'connector before From');
assert.ok(write.indexOf("selectSenderDropdown('from'") < write.indexOf("findNativeField('senderName')"), 'From before sender name');
const bridgeClient = fs.readFileSync(new URL('../src/ai/client/bridge-client.js', import.meta.url), 'utf8');
assert.match(bridgeClient, /!hadSuccessfulConnection && reconnectAttempt >= IDLE_ATTEMPTS/, 'no endless reconnects to a bridge that never answered');
console.log('✓ v0.9.0: preheader + sender presets + apply to all locales');
