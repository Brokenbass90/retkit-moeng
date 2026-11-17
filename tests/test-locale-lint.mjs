// locale-lint: one checker for Studio and RetKit for MoEngage — same verdicts everywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['../src/shared/locale-lint-data.js', '../src/shared/locale-lint.js']) {
  vm.runInContext(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), sandbox);
}
const L = sandbox.RetKitLocaleLint;
const codes = (r, locale) => JSON.parse(JSON.stringify(r.issues)).filter((x) => !locale || x.locale === locale).map((x) => `${x.locale}#${x.block ?? '-'}:${x.code}:${x.severity}`);

const en = [
  'Hello, {{name}}!',
  'Your verification code is ready. Please remember that this code is only active for 5 minutes and can only be used once.',
  'embedded.brand_name',
  'IQ Option',
  'Should you need a hand or have any questions, please feel free to contact our @@Support Team@@ at any time.',
  'Terms and Conditions',
  'Unsubscribe',
];
const es = [
  '¡Hola, {{name}}!',
  'Tu código de verificación está listo. Recuerda que este código solo está activo durante 5 minutos y solo se puede usar una vez.',
  'embedded.brand_name',
  'IQ Option',
  'Si necesitas ayuda o tienes alguna pregunta, no dudes en contactar con nuestro @@Equipo de Soporte@@ en cualquier momento.',
  'Términos y Condiciones',
  'Darse de baja',
];
const ru = [
  'Здравствуйте, {{name}}!',
  'Ваш код подтверждения готов. Помните, что этот код действует только 5 минут и может быть использован только один раз.',
  'embedded.brand_name',
  'IQ Option',
  'Если вам нужна помощь или у вас есть вопросы, свяжитесь с нашей @@Службой поддержки@@ в любое время.',
  'Условия и положения',
  'Отписаться',
];
const ar = [
  'مرحبًا، {{name}}!',
  'رمز التحقق الخاص بك جاهز. تذكر أن هذا الرمز صالح لمدة 5 دقائق فقط ويمكن استخدامه مرة واحدة فقط.',
  'embedded.brand_name',
  'IQ Option',
  'إذا كنت بحاجة إلى مساعدة أو لديك أي أسئلة، فلا تتردد في التواصل مع @@فريق الدعم@@ في أي وقت.',
  'الشروط والأحكام',
  'إلغاء الاشتراك',
];

// 1. Clean locales: nothing to report.
let r = L.lint({ locales: { en, es, ru, ar } });
assert.deepEqual(codes(r), [], JSON.stringify(r.issues, null, 1));
assert.equal(r.ok, true);
assert.equal(r.summary, 'en (эталон) · es ✓ · ru ✓ · ar ✓');

// 2. Raw email copied into a locale: untranslated + whole-locale language.
r = L.lint({ locales: { en, fr: en.slice() } });
assert.ok(codes(r, 'fr').includes('fr#1:untranslated:error'));
assert.ok(codes(r, 'fr').includes('fr#4:untranslated:error'));
assert.ok(!codes(r, 'fr').some((c) => c.startsWith('fr#3')), 'brand names are not "untranslated"');
assert.equal(r.ok, false);

// 3. English in an Arabic locale: alphabet.
r = L.lint({ locales: { en, ar: ar.map((t, i) => (i === 4 ? 'If you need help, contact our @@Support Team@@ at any time.' : t)) } });
assert.deepEqual(codes(r, 'ar'), ['ar#4:wrong_script:error']);

// 3b. A short word in another alphabet inside a Latin locale (live case: Greek in fr).
r = L.lint({ locales: { en, fr: es.map((t, i) => (i === 6 ? 'δσωσδω' : t)) } });
assert.ok(codes(r, 'fr').includes('fr#6:wrong_script:error'), codes(r, 'fr').join());
// …and a locale that lost its blocks is red even with one line left.
r = L.lint({ locales: { en, fr: ['δσωσδω'] } });
assert.ok(codes(r, 'fr').includes('fr#-:missing_block:error'), codes(r, 'fr').join());

// 3c. Live placeholders: MoEngage content blocks and embedded.* are fine (the _EN/_FR suffix is
// per locale), the EN block inside FR is a warning, an unresolved ${{ ns.block_NN }}$ is an error.
{
  const page = (lang, title, block) => `<html><body><h1>${title}</h1><p>{{ContentBlock['iq_risk_warning_noreg_${block}']}}</p><p class="address-text">{{embedded.company_address}}</p></body></html>`;
  r = L.lintHtml({ htmlByLocale: { EN: page('en', 'Your account is verified now', 'EN'), FR: page('fr', 'Votre compte est maintenant vérifié', 'FR') } });
  assert.deepEqual(codes(r), [], JSON.stringify(r.issues));
  r = L.lintHtml({ htmlByLocale: { EN: page('en', 'Your account is verified now', 'EN'), FR: page('fr', 'Votre compte est maintenant vérifié', 'EN') } });
  assert.ok(codes(r, 'FR').some((c) => c.endsWith(':var_mismatch:warn')), codes(r).join());
  r = L.lintHtml({ htmlByLocale: { EN: page('en', 'Your account is verified now', 'EN'), FR: page('fr', '${{ fraud.block_01 }}$', 'FR') } });
  assert.ok(codes(r, 'FR').some((c) => c.endsWith(':placeholder:error')), codes(r).join());
  r = L.lint({ locales: { en, fr: es.map((t, i) => (i === 1 ? '${{ fraud.block_01 }}$' : t)) } });
  assert.ok(codes(r, 'fr').includes('fr#1:placeholder:error'), codes(r).join());
}

// 3d. Live case 16.11 (MoEngage): the hidden ESP unsubscribe link «Manage your preference here» is the
// same in every locale on purpose — not "untranslated". The hidden preheader is still read.
{
  const mail = (body, pre) => `<html><body><div class="preheader" style="display: none; font-size: 1px;">${pre}</div><p>${body}</p>`
    + `<div style="display: none; font-size: 1px;"><a data-msys-unsubscribe="1" href="{{ContentBlock['iq_unsubscribe']}}">Manage your preference here</a></div></body></html>`;
  r = L.lintHtml({ htmlByLocale: { EN: mail('Complete the practice to get your first trade risk-free', 'Earn a five dollar bonus today'), ID: mail('Selesaikan latihan untuk mendapatkan trading pertama bebas risiko', 'Dapatkan bonus lima dolar hari ini') } });
  assert.deepEqual(codes(r), [], JSON.stringify(r.issues));
  r = L.lintHtml({ htmlByLocale: { EN: mail('Complete the practice to get your first trade risk-free', 'Earn a five dollar bonus today'), ID: mail('Selesaikan latihan untuk mendapatkan trading pertama bebas risiko', 'Earn a five dollar bonus today') } });
  assert.ok(codes(r, 'ID').some((c) => c.includes('untranslated')), 'untranslated preheader is still caught');
}

// 3e. Live case 17.11: keyboard mash inside an Italian text, junk symbols, a few Cyrillic letters.
{
  const it = ['Ciao, {{name}}!', 'Il tuo codice di verifica è pronto. Ricorda che questo codice è attivo solo per 5 minuti e può essere usato una sola volta.', 'embedded.brand_name', 'IQ Option', 'Se hai bisogno di aiuto o hai domande, contatta il nostro @@Team di Supporto@@ in qualsiasi momento.', 'Termini e Condizioni', 'Annulla iscrizione'];
  r = L.lint({ locales: { en, it } });
  assert.deepEqual(codes(r, 'it'), [], 'clean Italian passes');
  for (const [bad, code] of [['Termini dfgdfg sdfsdf', 'gibberish'], ['asdkjfh zxcvb', 'gibberish'], ['Termini ### ~~~ $$$ e', 'gibberish'], ['Termini e Condizioni мир при', 'wrong_script']]) {
    r = L.lint({ locales: { en, it: it.map((t, i) => (i === 5 ? bad : t)) } });
    assert.ok(codes(r, 'it').includes(`it#5:${code}:error`), `${bad}: ${codes(r, 'it')}`);
  }
}

// 3f. Live case 17.11: real words that contain 4 keyboard keys in a row are not gibberish.
{
  const ru2 = ru.map((t, i) => (i === 1 ? 'Вы не отправляли этот запрос? Проверьте и измените пароль от своего аккаунта, пожалуйста.' : t));
  assert.ok(!codes(L.lint({ locales: { en, ru: ru2 } }), 'ru').some((c) => c.includes('gibberish')), 'запрос is a word');
  const en2 = en.map((t, i) => (i === 1 ? 'Your property and liberty matter: this code is only active for 5 minutes.' : t));
  assert.ok(!codes(L.lint({ locales: { en: en2, fr: es } }), 'en').some((c) => c.includes('gibberish')), 'property / liberty are words');
}

// 4. Spanish text in the French locale: language.
r = L.lint({ locales: { en, fr: es.slice() } });
assert.ok(codes(r, 'fr').includes('fr#-:wrong_lang:error'), JSON.stringify(r.issues));

// 5. Close languages: Portuguese in es is only a warning.
const pt = [
  'Olá, {{name}}!',
  'O seu código de verificação está pronto. Lembre-se de que este código só está ativo durante 5 minutos e só pode ser usado uma vez.',
  'embedded.brand_name', 'IQ Option',
  'Se precisar de ajuda ou tiver alguma dúvida, não hesite em contactar a nossa @@Equipa de Apoio@@ a qualquer momento.',
  'Termos e Condições', 'Cancelar subscrição',
];
r = L.lint({ locales: { en, es: pt } });
assert.ok(codes(r, 'es').every((c) => c.endsWith(':warn')), JSON.stringify(r.issues));
assert.ok(codes(r, 'es').some((c) => c.includes('wrong_lang')));

// 6. Draft junk, broken encoding, variables, bold, empty, missing blocks.
r = L.lint({ locales: { en, es: [
  '¡Hola!',                                   // lost {{name}}
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
  'embedded.brand_name', 'IQ Option',
  'Si necesitas ayuda, contacta con nuestro @@Equipo de Soporte en cualquier momento.', // broken bold
  'TÃ©rminos y Condiciones',
] } });
const c6 = codes(r, 'es');
for (const want of ['es#-:missing_block:error', 'es#0:var_mismatch:error', 'es#1:placeholder:error', 'es#4:markup:error', 'es#5:mojibake:error']) assert.ok(c6.includes(want), `${want} in ${c6}`);
r = L.lint({ locales: { en, es: es.map((t, i) => (i === 6 ? '  ' : t)) } });
assert.deepEqual(codes(r, 'es'), ['es#6:empty:error']);
for (const junk of ['TODO translate', 'Title here', 'Button text', 'Step one text', '[translate]', 'Текст здесь', '???', 'Hello {{name']) {
  r = L.lint({ locales: { en, es: es.map((t, i) => (i === 1 ? junk : t)) } });
  assert.ok(codes(r, 'es').includes('es#1:placeholder:error'), `${junk}: ${codes(r, 'es')}`);
}

// 7. Same language variants (en / en_US) are not "untranslated".
r = L.lint({ locales: { en, en_US: en.slice() } });
assert.deepEqual(codes(r), []);

// 8. MoEngage: one HTML per locale, same verdicts.
const html = (blocks) => `<html><head><style>.a{color:red}</style><title>t</title></head><body><table><tr><td><p>${blocks[0]}</p><p>${blocks[1]}</p><img src="x.png" alt="${blocks[5]}"><p>${blocks[4].replace(/@@(.*?)@@/, '<b>$1</b>')}</p><a href="#">${blocks[6]}</a></td></tr></table></body></html>`;
r = L.lintHtml({ htmlByLocale: { EN: html(en), ES: html(es), FR: html(en), AR: html(ar) } });
assert.equal(r.refCode, 'EN');
assert.deepEqual(codes(r, 'ES'), []);
assert.deepEqual(codes(r, 'AR'), []);
assert.ok(codes(r, 'FR').filter((c) => c.includes('untranslated')).length >= 3, codes(r, 'FR').join());
assert.deepEqual([...L.textsFromHtml(html(en)).slice(0, 2)], [en[0], en[1]]);

// 9. Agent output is compact and stable; fingerprint changes with content.
const text = L.format(L.lint({ locales: { en, fr: en.slice(), ru } }));
assert.ok(text.split('\n')[1].startsWith('en (эталон) · fr 🔴'));
assert.ok(text.length < 1200, text);
assert.notEqual(L.fingerprint({ en }), L.fingerprint({ en: [...en, 'x'] }));
assert.equal(L.langOf('Spanish').base, 'es');
assert.equal(L.langOf('ar_KW').lang, 'arb');

// 10. Keyed JSON locales (email-base vendor/data): aligned by key, missing keys named, %%vars%% are variables.
const enK = { footer: { warn: 'General Risk Warning:', text: 'The financial services provided by this website carry a high level of risk.', address: '%%company_address%%', unsubscribe: 'Unsubscribe' } };
const ruK = { footer: { text: 'Финансовые услуги на этом сайте связаны с высоким уровнем риска.', warn: 'Общее предупреждение о рисках:', address: '%%company_address%%' } };
r = L.lint({ locales: { en: enK, ru: ruK } });
assert.deepEqual(codes(r, 'ru'), ['ru#footer.unsubscribe:missing_block:error']);

console.log('✓ locale-lint: keyed JSON;');
// Store and network names, promo codes are the same in every language.
r = L.lint({ locales: { en: ['Get it on Google Play', 'Instagram', 'PROMOCODE', 'App Store'], ar: ['Google Play', 'Instagram', 'PROMOCODE', 'App Store'] } });
assert.deepEqual(codes(r), []);

// 11. Reference in the wrong language: one error in the reference, not "untranslated" everywhere.
r = L.lint({ locales: { es: es.map((t, i) => (i === 1 ? 'Первая версия письма для проверки' : t)), en_US: en.map((t, i) => (i === 1 ? 'Первая версия письма для проверки' : t)), en: en.map((t, i) => (i === 1 ? 'Первая версия письма для проверки' : t)) } });
assert.deepEqual(codes(r), ['en#1:wrong_script:error']);
assert.ok(r.summary.startsWith('en 🔴1 (эталон)'), r.summary);

console.log('✓ locale-lint: clean / raw copy / alphabet / language / close languages / junk / vars / bold / HTML / agent format');
