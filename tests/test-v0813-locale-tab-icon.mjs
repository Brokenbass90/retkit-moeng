// v0.8.13: активная вкладка удаляемой локали в MoEngage читается как «fr_FR close»
// (иконка-лигатура Material Icons). Код локали должен узнаваться и так —
// иначе замена по всем локалям падала на ES_ES/FR_FR с «did not render».
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');
const between = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} must exist`);
  return src.slice(a, b);
};
const helpers = src.slice(src.indexOf('  function normaliseLocale(value) {'), src.indexOf('  function normaliseAddableLocaleLabels'));
const exact = between('  function exactLocaleFromText(value) {', '  function localeCodeFromOptionElement');
const api = new Function(`${helpers}\n${exact}\nreturn { localeCodeFromLabel, exactLocaleFromText, stripLocaleTabIconWords };`)();

assert.equal(api.localeCodeFromLabel('fr_FR close'), api.localeCodeFromLabel('fr_FR'));
assert.equal(api.localeCodeFromLabel('es_ES  close '), api.localeCodeFromLabel('es_ES'));
assert.equal(api.localeCodeFromLabel('es_ES clear'), api.localeCodeFromLabel('es_ES'));
assert.ok(api.localeCodeFromLabel('fr_FR'), 'plain tab still works');
assert.equal(api.exactLocaleFromText('fr_FR close'), api.exactLocaleFromText('fr_FR'));
assert.equal(api.localeCodeFromLabel('Default close'), api.localeCodeFromLabel('Default'));
// не превращаем случайный текст в локаль
assert.equal(api.localeCodeFromLabel('close'), '');
assert.equal(api.localeCodeFromLabel('Add close'), '');
assert.equal(api.localeCodeFromLabel('fr_FR something'), '');
console.log('✓ v0.8.13 locale tab with icon word: fr_FR close → FR_FR');
