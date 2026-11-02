// v0.9.3: Doctor — проверка мест MoEngage, только чтение.
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

const summarySrc = between(bridge, '  function doctorSummary(', '  function runDoctor(');
const { doctorSummary } = new Function(`${summarySrc}; return { doctorSummary };`)();
assert.equal(doctorSummary([{ status: 'PASS' }, { status: 'PASS' }]).state, 'pass');
assert.equal(doctorSummary([{ status: 'PASS' }, { status: 'UNKNOWN' }]).state, 'unknown');
assert.equal(doctorSummary([{ status: 'UNKNOWN' }, { status: 'FAIL' }]).state, 'fail');
assert.deepEqual({ ...doctorSummary([{ status: 'PASS' }, { status: 'FAIL' }, { status: 'UNKNOWN' }]) }, { pass: 1, fail: 1, unknown: 1, state: 'fail' });

// Только чтение: в Doctor нет кликов, записи и переключений.
const doctor = between(bridge, '  function runDoctor(', '  function doctorReportText(');
for (const forbidden of ['.click(', 'setNativeValue(', 'switchNativeLocale(', 'commitNativeHtml', 'activateMdsDropdown(', 'openMdsDropdown(']) {
  assert.ok(!doctor.includes(forbidden), `Doctor must not ${forbidden}`);
}
// Статусы — только PASS / FAIL / UNKNOWN.
const statuses = [...doctor.matchAll(/'(PASS|FAIL|UNKNOWN|OK|WARN|ERROR)'/g)].map((m) => m[1]);
assert.ok(statuses.length > 10);
assert.ok(statuses.every((s) => ['PASS', 'FAIL', 'UNKNOWN'].includes(s)), 'only PASS / FAIL / UNKNOWN');

// Проверяет всё, за что держится RetKit.
for (const id of ["'editor'", "'codeview'", "'body'", "'preview'", "'locales'", "'bound'", "'subject'", "'preview'", "'senderName'", "'connector'", "'fromEmail'", "'replyTo'", "'test'", "'sync'", "'storage'"]) {
  assert.ok(doctor.includes(id), `checks ${id}`);
}
assert.match(core, /doctorProbe: \(\) =>/, 'core exposes a read-only probe');
assert.match(bridge, /scheduleSilentDoctor\(2500\)/, 'silent run after the workspace opens paints the dot');
console.log('✓ v0.9.3: Doctor');
