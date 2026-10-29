# Changelog

## 0.9.1

- Sender window: Email Connector and From are now choices (read from MoEngage when the window opens) and part of presets. Apply sets Connector first, then From, then the name — in every selected locale.
- The AI bridge no longer floods the console with "WebSocket connection failed" when it is not running: 3 attempts, then it waits for a click on Claude/Codex or for you to come back to the tab (at most once a minute).

## 0.9.0

- Preheader field and a sender chip next to Subject; sender presets; apply sender to all locales with a per-locale report.

## 0.8.14

- One locale's HTML is never written into another. Before each write RetKit checks that MoEngage still shows the locale it loaded (tab and text). If MoEngage has switched under it (e.g. AR opened while the overlay still held EN), the write is refused (`write_blocked_other_locale` in Logs, with the HTML), the edit goes to the clipboard and RetKit reloads the locale MoEngage really shows.
- Clearing the whole editor now clears the preview too, instead of showing the old email until you type.

## 0.8.13

- Replace across locales no longer skips ES_ES and FR_FR with "MoEngage did not render … after the locale click". The active tab of a removable locale reads as `fr_FR close` (Material Icons ligature of its delete icon), so RetKit did not recognise the open locale. Icon words are now ignored when reading locale tabs.

## 0.8.12

- Fewer false alarms in Logs: clearing the editor yourself (select all → delete before pasting) no longer records `empty_body_blocked` — RetKit just says "paste the new email"; MoEngage keeps the old one meanwhile.
- An empty MoEngage locale (417-byte skeleton) no longer records `preview_not_ready`.

## 0.8.11

- Locale switch fixed: when an email's `<html lang>` named another language than its tab (a French email pasted into es_ES), RetKit took itself for that language — the fr_FR click did nothing or ended with "could not bind the FR_FR editor". The selected MoEngage tab is now the truth; lang no longer blocks binding.
- Locale switches are logged (start / done / failed), and a failed bind writes a `locale_bind_failed` incident with the reason.
- Logs window: it closes first and then copies/downloads, so it never stays open.

## 0.8.10

- The Logs window closes by itself: after Download / Copy / Clear, on a click outside it, on Esc, or on a second press of the Logs button.
- `slow_sync` is recorded only above 6 s: up to ~4.5 s is the normal wait while MoEngage accepts a large email.

## 0.8.9

- New **🤖 Агент** button in the RetKit top bar: connects your own Claude or Codex to the open email. It opens a small Retention Studio window (keep it open) that relays the agent's commands to this tab.
- The agent can read the email and any locale, write the open locale (only with a fresh hash, never an empty body), switch locales, run "Search all locales" and prepare a replacement. Pressing Replace and saving the campaign in MoEngage stay human clicks.

## 0.8.8 — запись в MoEngage не забирает клавиатуру и выделение

- Запись в MoEngage идёт через его редактор Froala и на ~2 с ставит фокус в него. До 0.8.8 в это время пропадало выделение в RetKit, а набранные клавиши уходили в скрытый редактор MoEngage и затирались (стенд: из 10 букв, набранных во время записи, в письме не осталось ни одной).
- Теперь во время записи настоящие нажатия вне RetKit останавливаются и фокус сразу возвращается в RetKit; после записи фокус и выделение восстанавливаются как были (стенд: 9 из 10 букв на месте, одна — та, что пришлась на сам момент переключения, — не уходит в MoEngage, а просто не вводится; статус просит набрать ещё раз).

## 0.8.7 — Close больше не опустошает локаль

- Найдено по логам 07–08.10: каждый раз, когда MoEngage оставался с пустой заготовкой (`<head><style>` + пустой `<body>`, 417 символов), перед этим нажимали **Close** с несохранённой правкой. Close запускал запись в MoEngage и в ту же секунду разбирал RetKit; запись (переключения Code View, ~5 с) гонялась с разборкой, и в локали оставалась пустая заготовка.
- Теперь Close сначала сохраняет и ждёт подтверждения от MoEngage, и только потом закрывается. Не сохранилось — RetKit не закрывается и пишет почему (`close_blocked_unsaved`).
- Если после записи MoEngage всё же показал пустую заготовку, RetKit повторяет запись один раз; не помогло — красное «MoEngage EMPTIED this locale… Do NOT press Save».

## 0.8.6 — пустой код-вью MoEngage больше не сохраняется

- MoEngage иногда открывает локаль с пустым `<body>` в Code View, хотя превью показывает письмо (pt_PT). RetKit теперь это видит: красное предупреждение «code view came up EMPTY… reload the page», инцидент `native_empty_body` в Logs, и запись такого HTML заблокирована — сравнение идёт и с превью, а не только с редактором.
- ↶ Original больше не сохраняет «пустое письмо» (head + стили + пустой `<body>`) как оригинал локали и не даёт его восстановить: старые такие снимки помечены «Saved original is EMPTY — cannot restore». Каждое восстановление пишется в Logs (`original_restored`). Снимок берётся для локали, к которой привязан RetKit, а не для вкладки, которая могла ещё не переключиться.
- Номер версии поднят, чтобы после переустановки было видно, что стоит новая сборка.

## 0.8.5 — поиск по всем локалям только по кнопке

- Защита от пустого письма: HTML, у которого `<body>` пустой (только `<head>` и стили), больше никогда не записывается поверх письма с содержимым — ни при обычной синхронизации, ни при замене по локалям (`empty_body_blocked` в Logs).

- **Замена во всех локалях — исправлены доказанные ошибки** (стенд `tools/fake-moengage`):
  - чтение локали принимало старый HTML: MoEngage сначала подсвечивает вкладку, а содержимое меняет позже, и `lang="en"` одинаков во всех шаблонах. Итог: пересчёт и замена шли по HTML соседней локали, в 4 из 5 локалей ничего не менялось, а статус писал «Replaced … in 1 locales» без ошибки. Теперь RetKit ждёт, пока сам редактор покажет новую локаль и успокоится;
  - запись в локаль идёт только если редактор показывает ровно то, что было прочитано для неё (иначе — «не записано», без подмены одной локали другой);
  - после замены каждая локаль перечитывается из MoEngage и сверяется; статус называет локали, где не получилось;
  - RetKit больше не привязывается к редактору прошлой локали после переключения (так HTML одной локали оказывался под вкладкой другой);
  - бэкап локалей читает их тем же надёжным способом;
  - несохранённая правка открытой локали записывается до обхода локалей;
  - одно поле замены на все локали: поле «значение для одной локали» убрано из интерфейса (его принимали за основное — `aff=764878` вырезался в 8 локалях дважды); при пустом «Replace with…» кнопка неактивна и пишет «Write the new value…», удалить найденное через массовую замену нельзя;
  - кнопка массовой замены — сразу под заголовком «Across locales», выделена цветом; после замены — карточка результата: по каждой локали ✓ / ✗ и подсказка, как перепроверить;
  - панель локалей сворачивается по клику вне поиска (например, по Logs) и возвращается при фокусе на поле Find;
  - поле локали переименовано в «Only <локаль>, a different value (optional)»; кнопка массовой замены показывает, на что меняет;
  - повторный клик не запускает замену второй раз: кнопка блокируется сразу и пишет «Replacing in N locales…», а после завершения нужен новый «Search all locales»;
  - каждая массовая замена пишет в Logs постоянный отчёт `multilocale_apply_report` (переживает перезагрузку): что искали, на что меняли, сколько в каждой локали и первые 3 места «было → стало»;
  - поиск видит один и тот же текст в любом написании: `'`/`&#39;`, `"`/`&quot;`, пробел/`&nbsp;`/перенос строки с отступом, `&`/`&amp;`; замена пишется в том же написании.

- Набор в поле Find ищет только в открытой локали. Обход всех локалей (он переключает вкладки MoEngage) запускается только кнопкой «Search all locales» внизу панели — больше не стартует сам при вводе, открытии поиска, «All» в текущей локали, смене режима «по имени файла» и после массовой замены.
- Результат по всем локалям привязан к запросу: изменили текст — старый результат сброшен, кнопка «Replace across locales» неактивна до нового поиска.
- Переключение локали больше не теряет правку. Раньше вкладка переключалась сразу: если запись в MoEngage ещё ждала паузы (на больших письмах до 4 с), шла или не прошла — новая локаль затирала редактор. Теперь клик по вкладке сначала дописывает текущую локаль в MoEngage (с повтором); не получилось — переключение отменяется и правка остаётся на месте (`locale_switch_blocked_unsaved` в логах).
- Ложные «MoEngage reverted the HTML»: на больших письмах MoEngage пару секунд показывает старый HTML и только потом новый (в логах сразу за отказом шло «Already in sync»). Проверка теперь ждёт до 3 с дольше и только потом считает запись отказом (`sync.settled-late` в логах).
- Переключение локали больше не принимается за «MoEngage откатил HTML»: после записи RetKit 5 с сравнивал редактор со своей версией и, увидев HTML новой локали, считал это откатом и держал в редакторе текст прошлой локали. Теперь на время переключения и для другой активной локали это смена локали, а редактор показывает ровно то, что лежит в MoEngage. Временная «страховка» с хранением правки по локалям убрана — она путала локали.
- RTL Fix не трогает уже арабизированное письмо (dir="rtl" на `<html>`/`<body>` или маркер RetKit): пишет «письмо уже арабизировано — ничего не менял» вместо ошибки и второго прохода.
- Статус после записи: `AR_KW · saved to MoEngage ✓ 16:48`.
- Диагностика: `moengage_sync_rejected` теперь различает `reverted` (MoEngage вернул старый HTML) и `changed` (оставил другой HTML), а он и `late_native_revert` пишут место первого расхождения с коротким контекстом (`diff`), без самого письма.

## 0.8.4 — арабизация не двигает карточки с картинкой на фоне

- Карточка, у которой на фоне большая иллюстрация, прижатая к краю (`right bottom`, `background-size` от 120px), не зеркалится: картинка и колонка текста остаются на месте, а сам текст внутри становится RTL (справа налево, выравнивание вправо). Иначе текст уезжал на картинку.
- Маленькие иконки сбоку с отступом под них (иконка 56px + `padding-left:70px`) по-прежнему зеркалятся целиком: иконка справа, текст слева от неё.
- Статус RTL Fix пишет, сколько таких карточек оставлено на месте.

## 0.8.3 — RTL Fix арабизирует письмо целиком

- RTL Fix теперь делает то, что команда делает руками: `<html dir="rtl" lang="ar">`, `<body dir="rtl">`, `dir="rtl"` на всех блоках, зеркальные стороны (text-align, padding/margin/border, float, align, 4-значные margin/padding) и в inline-стилях, и в `<style>` — мобильные медиазапросы тоже.
- Движок общий со студией (`src/shared/rtl-core.js` генерируется из `retantion-future/email-base/tools/rtl.js` скриптом `scripts/sync-rtl-core.mjs`).
- Проверено на эталонной паре photo-welcome2 (EN-шаблон → готовое AR-письмо): каждый элемент совпадает 1:1. Повторный клик по-прежнему возвращает как было.

## 0.8.2 — меньше подвисаний и откатов (по логам 2026-10-06)

- Пауза перед записью в MoEngage подстраивается под письмо: если запись длится 2–3 с (большое письмо), RetKit ждёт паузу подольше (до 4 с) и не подвешивает страницу посреди набора. Уход из редактора по-прежнему пишет сразу.
- Во время поиска/замены по всем локалям RetKit не пишет текущую правку в MoEngage — пишет сразу после. Раньше MoEngage такую запись откатывал.
- Поиск по локалям ждёт, пока текущая правка запишется, и только потом ходит по вкладкам.
- Подсветка поиска при наборе пересчитывается после паузы, а не на каждую букву.

## 0.8.1 — новые названия локалей MoEngage

- Вкладки вида `Default, en_US, es_ES, pt_PT, th_TH, id_ID, vi_VN, fr_FR, ar_KW` распознаются как отдельные локали: `en_US` больше не сливается с `Default`, подписи в RetKit совпадают с вкладками MoEngage.
- Активная локаль: `lang="en"`, оставшийся в шаблоне, больше не выдаёт вкладку `ar_KW` за EN; приоритет у выбранной вкладки MoEngage.
- RTL и арабские проверки определяются по языку (`ar_KW` → арабский).
- Тест-рассылка: сохранённый ранее выбор «AR» находит вкладку `ar_KW`.

## 0.8.0 — карта функционала в Logs

- RetKit тихо записывает, как устроена страница письма MoEngage: запросы на сервер (метод, адрес-шаблон, имена полей и типы), после какого нажатия они ушли, какие кнопки нажимались и какие элементы есть на каждом экране.
- Значения не хранятся: токены, cookie, email и тексты писем заменяются на `<hidden>`, `<email>`, `<text len=…>`, `<html len=…>`. Ничего никуда не отправляется — карта лежит в браузере и попадает только в скачанный отчёт.
- В окне **Logs**: строка «Functionality map» (сколько запросов / кнопок / экранов), «Snapshot screen», «Clear map». «Download .json» отдаёт сбои и карту в одном файле.
- Сбои запросов MoEngage (5xx, обрыв сети) попадают в контекст инцидентов.

## 0.7.8 — безопасно для рабочих компьютеров

- Убраны автозапуск bridge и установщики из панели: на рабочем Mac антивирус (EDR) расценил LaunchAgent как «persistence». Карточка в RetKit AI теперь только подсказывает запустить `npm run bridge`. `npm run bridge:uninstall` удаляет ранее поставленный автозапуск.
- Установщики в `install/` больше не создают элементов автозапуска.

## 0.7.7 — подключение Claude / Codex одной кнопкой

- Карточка «Подключить Claude» в RetKit AI (Mac — одна команда, Windows — `RetKit-Connect.cmd`), сама исчезает, когда bridge и модель готовы; подсказка про вход, если не залогинен.
- Установщики `install/install-mac.sh`, `install/install-windows.ps1`: Claude Code, приватный Node.js (с проверкой SHA-256), bridge, автозапуск, вход; опционально Codex. Без sudo/админа.
- `npm run dev:loader` → `dev/retkit-dev-loader.user.js`: ставится в Tampermonkey один раз и грузит RetKit из папки проекта — после сборки достаточно обновить вкладку MoEngage.

## 0.7.6 — своя замена для каждой локали

- ⌘F → Across locales: клик по локали → поле «{LOCALE}: replace with». Пусто — общая замена из «Replace with…», заполнено — своя для этой локали (например, локализованный баннер). Метка локали получает ✎.
- `propose_replace_across_locales` принимает `perLocale` ({"AR": "…"}).

## 0.7.5 — модели умеют «во всех локалях»

- `npm run bridge:install` (macOS): bridge стартует вместе с Mac и работает в фоне, терминал не нужен; `bridge:status`, `bridge:uninstall`.
- Инструменты AI bridge: `find_across_locales` (поиск во всех локалях кампании, с типом и контекстом) и `propose_replace_across_locales` (RetKit заполняет ⌘F и сканирует локали; заменяет только человек кнопкой). В режиме Ask замена недоступна.

## 0.7.4 — умная замена во всех локалях

- ⌘F → **Across locales**: одно поле «Replace with…» и для текущей локали, и для всех (второе поле убрано — их легко было перепутать).
- Клик по имени локали в полосе показывает, **где именно** совпадения: тип (картинка / ссылка / фон / текст) и подсвеченный контекст.
- Поиск понимает `&` = `&amp;`; замена пишется в той кодировке, которую заменяет.
- Для картинок — **Same image by file name**: находит один и тот же файл (`icon1.png`), даже если в каждой локали он загружен по своему адресу, и меняет URL целиком.
- Общее ядро `src/shared/replace-across.js` (публикуется в `shared/`) — то же самое использует Retention Future Studio.
- Отдельная кнопка Undo для массовой замены по-прежнему не вводится (решение stable freeze v0.6.17); страховка — ↶ Original для каждой локали.

## 0.7.3

- В `dist/` теперь лежит только `retkit-moengage.user.js` — единственный файл для Tampermonkey. Общий модуль клика для других инструментов переехал в `shared/click-to-source.js`.

## 0.7.2 — AI видит письмо

- `get_preview_screenshot` теперь работает: bridge рендерит текущее превью (активная локаль) в PNG через локальный headless Chrome, desktop 800px / mobile 390px. Claude Code получает картинку как image-контент MCP, Codex — как `inputImage`. Скрипты письма вырезаются и дополнительно блокируются CSP.

## 0.7.1 — ↶ Original

- **↶ Original:** перед первой правкой письма RetKit сохраняет его исходную версию (по кампании и локали). Кнопка в тулбаре: посмотреть, скопировать, вернуть (возврат — отменяемая правка, в MoEngage уходят исходные байты), удалить. Хранение — IndexedDB этого браузера, авто-очистка через 14 дней без использования, лимит 40 МБ.
- **Click-to-source для других инструментов:** `npm run build` дополнительно собирает `shared/click-to-source.js` — тот же матчер «клик в превью → место в коде», что использует RetKit; подключён в Retention Future Studio.
- README: пошаговая установка через Tampermonkey, что происходит с данными.

## 0.7.0 — polish

Без новых функций: надёжность, безопасность, скорость, порядок в проекте.

- **Sync:** в MoEngage больше не уходит переформатированный («beautified») HTML. Неизменённые части письма сохраняют исходное форматирование автора, меняется только отредактированный кусок. Письмо не раздувается (Gmail clipping), между inline-block колонками не появляются лишние пробелы.
- **Security:** preview-iframe в `sandbox="allow-same-origin"` — скрипты из HTML письма не выполняются с правами MoEngage. AI bridge не принимает WebSocket без Origin браузера.
- **Perf:** фоновые таймеры не делают лишней работы: превью не перепроверяет неизменный HTML, поиск поля Subject кешируется, на скрытой вкладке всё стоит.
- **Project:** один репозиторий; `src/retkit-moengage-v0.5.user.js` → `src/moengage/native-bridge.user.js`; собранный файл только в `dist/`; единый тест-раннер (`npm test`, параллельно); одна версия на всё (`npm run version:set`) с проверкой в тестах; версия AI bridge синхронизирована с userscript.
