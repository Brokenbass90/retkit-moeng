import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// MoEngage сейчас: вкладки «Default, en_US, es_ES, pt_PT, th_TH, id_ID, vi_VN, fr_FR, ar_KW».
// Раньше RetKit сводил всё к двум буквам: en_US сливалась с Default в «EN», а
// вкладка ar_KW показывалась как EN, потому что в HTML остался lang="en".
const source = fs.readFileSync(new URL('../src/moengage/native-bridge.user.js', import.meta.url), 'utf8');
const sandbox = { console, setTimeout, clearTimeout, globalThis: {} };
sandbox.globalThis.globalThis = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'native-bridge.user.js' });
const core = sandbox.globalThis.__RetKitMoEngageBridgeCore;
const list = (value) => JSON.stringify(Array.from(value));

const TABS = ['Default', 'en_US', 'es_ES', 'pt_PT', 'th_TH', 'id_ID', 'vi_VN', 'fr_FR', 'ar_KW'];

// Каждая вкладка — своя локаль, ничего не слипается.
const known = core.filterKnownLocales(TABS);
assert.equal(known.length, 9, `all 9 tabs are distinct: ${list(known)}`);
assert.equal(list(core.sortLocalesForUi(TABS)), list(['EN', 'EN_US', 'AR_KW', 'ES_ES', 'FR_FR', 'ID_ID', 'PT_PT', 'TH_TH', 'VI_VN']));
assert.equal(core.normaliseLocale('ar_KW'), 'AR_KW');
assert.equal(core.localeLanguage('ar_KW'), 'AR');
assert.equal(core.localeLanguage('Default'), 'EN');
assert.equal(core.isArabicLocale('ar_KW'), true, 'RTL by language');
assert.equal(core.isArabicLocale('en_US'), false);

// Подписи — как во вкладках MoEngage.
assert.equal(list(TABS.map((tab) => core.localeUiLabel(core.displayLocale(tab)))), list(TABS));
assert.equal(core.nativeLocaleLabels('AR_KW')[0], 'ar_KW');
assert.equal(core.nativeLocaleLabels('EN')[0], 'Default');

// Активная вкладка: lang="en" из шаблона не перебивает ar_KW.
assert.equal(core.resolveActiveLocale('<html lang="en">', '', 'ar_KW'), 'AR_KW');
assert.equal(core.resolveActiveLocale('<html lang="ar">', '', 'ar_KW'), 'AR_KW');
assert.equal(core.resolveActiveLocale('<html lang="en">', '', 'en_US'), 'EN_US');
assert.equal(core.resolveActiveLocale('<html lang="en">', '', 'Default'), 'EN');
// Вкладка отстала после перерисовки, HTML уже другого языка — верим HTML и
// приводим к точной вкладке.
assert.equal(core.resolveActiveLocale('<html lang="vi">', '', 'Default'), 'VI');
assert.equal(core.matchLocaleToTabs('VI', ['EN', 'VI_VN', 'AR_KW']), 'VI_VN');
assert.equal(core.matchLocaleToTabs('EN', ['EN', 'EN_US']), 'EN', 'Default stays Default');

// Старые двухбуквенные вкладки по-прежнему работают.
assert.equal(list(core.sortLocalesForUi(['AR', 'PT', 'EN', 'ES'])), list(['EN', 'AR', 'ES', 'PT']));
assert.equal(core.localeUiLabel('AR'), 'AR');

// Тест-рассылка: сохранённый «AR» находит «ar_KW», точные — точно.
const plan = core.resolveTestLocaleSelectionPlan(['AR', 'en_US', 'Default'], ['Default', 'en_US', 'ar_KW', 'es_ES']);
assert.equal(list(plan.labels), list(['ar_KW', 'en_US', 'Default']), list(plan.labels));
assert.equal(plan.missing.length, 0);

console.log('v0.8.1 MoEngage locale regions: ok');
