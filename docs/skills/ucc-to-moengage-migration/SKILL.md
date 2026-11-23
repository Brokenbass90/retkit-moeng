---
name: "ucc-to-moengage-migration"
description: "Перенос системных писем из UCC (ucc.iqoption.com / ucc.int) в MoEngage: выгрузка всех локалей, замена футера, проверка, создание письма, ссылка в таблицу."
---

# Мост UCC → MoEngage

Отвечать по-русски, коротко. Формат: где мы сейчас / что узнали / что делаем следующим / что запрещено трогать.

## Жёсткие правила
- UCC — только чтение (GET). Никаких Save, Set as Ready, удалений.
- MoEngage — создавать и удалять только после явного «да» человека. Запущенные кампании не трогать.
- Google-таблица «All system emails» (лист IQ): менять только крайний правый столбец «MoEngage» (ссылка на письмо напротив названия).
- Порт 3001 на компьютере человека не трогать никогда.
- Токен микросервиса (`microservice.JWT`) из ответа UCC никуда не сохранять.
- Порядок: сначала INT → тестовые письма с суффиксом `(TEST)`; потом PROD → PROD. Одно письмо → три → конвейер.

## Где что лежит
- Репозиторий расширений: `~/Documents/retkit/retkit-moengage` (на устройстве `~/mnt/retkit/retkit-moengage`).
  - `dist/retkit-ucc-export.user.js` — userscript «⬇ ZIP письма» для UCC (ставится отдельно в Tampermonkey).
  - `tools/ucc-unpack.mjs` — JSON письма UCC → папки по локалям + отчёт.
  - `tools/ucc-footer-map.json` — карта замен футера и соответствие локалей UCC → MoEngage. Дополнять здесь.
- Рабочая папка переноса: `~/Documents/retkit/migration/` (`raw/` — JSON из UCC, `ucc-int/`, `ucc-prod/` — результат).
- Таблица писем: Google Sheets «Копия All system emails», лист IQ. Столбцы: Namespace, Template link PROD, Template link INT, Languages, Subject, Sender, Comments.

## Шаг 1. Выгрузка из UCC
API UCC (через вход человека, тот же origin):
- `GET /api/email/templates/<id>` — всё письмо: `name`, `microservice_name` (= namespace), `email_sender_id`, `email_category_id`, `brand_id`, `locales[]` с `locale.short_name`, `subject`, `html_body`, `status`.
- `GET /api/email/senders/`, `GET /api/email/categories` — расшифровка id.
id берётся из ссылки в таблице: `.../email-templates/<id>/edit`.

Способы:
- Встроенный браузер: UCC считается high-risk — разрешение на каждое действие. Поэтому одно действие = одно письмо целиком: `fetch` в странице, удалить `microservice.JWT` и `preview_body`, сохранить файлом (скачивание) `ucc-<env>-<id>-<name>.json`. Большие данные НЕ гонять через ответ инструмента и не перепечатывать base64 — портится.
- Человек: кнопка «⬇ ZIP письма» (userscript) в своём браузере.
Полученный файл положить в `migration/raw/`.

## Шаг 2. Преобразование
`node retkit-moengage/tools/ucc-unpack.mjs migration/raw/<file>.json migration/ucc-<env>`
Результат: `<namespace>/<name>/<locale>/index.html`, `subject.txt`, `params.txt`, `subjects.txt`, `report.json`.

Карта замен (noreg-письма; для рег-писем будет отдельная карта):
- `{{embedded.company_address}}` → `{{ContentBlock['iq_company_address_text']}}`
- `{{embedded.risk_warning}}` → `{{ContentBlock['iq_risk_warning_noreg_<ЯЗЫК>']}}` (суффикс = код локали заглавными: EN, PT…)
- `{{embedded.company_terms_link}}` → `{{ContentBlock['iq_terms_noreg_url']}}`
- `{{embedded.domain}}/traderoom/` (ссылка логотипа) → `https://iqbroker.co/lp/multilink/asset?aff=7&amp;afftrack=mail_system&amp;retrack=system` (как в уже переделанных EN/JA).

Локали MoEngage (сейчас заведены): en→en_US, ar→ar_KW, es→es_ES, pt→pt_PT, th→th_TH, id→id_ID, vi→vi_VN, fr→fr_FR. Остальные локали UCC переносить нельзя — записать в список «попросить завести».

## Шаг 3. Проверка перед заливкой
- `report.json`: пустые локали, `footerUnmapped` (должен быть пуст), все плейсхолдеры.
- Язык каждой локали — движок `RetKitLocaleLint` (`src/shared/locale-lint.js`): не тот язык, непереведённый текст, кракозябры, пустые блоки → алерт человеку и исправление.
- Комментарии из таблицы (столбцы Comments) учитывать: «разный текст в футере», «старый риск ворнинг», «взять переводы с учётом англ письма».
- Если тексты в INT и PROD отличаются, брать переделанные (новые) версии — спросить, если неясно.

## Шаг 4. Создание в MoEngage (уточняется на пилоте)
- Нужен чат с включённым коннектором MoEngage (`https://mcp.moengage.com`). Сначала изучить инструменты без создания.
- Каждая локаль = отдельная локаль письма MoEngage со своим HTML и Subject. Отправитель — из `params.txt`.
- Название: имя письма UCC; на тестах — `<name>(TEST)`. Namespace (микросервис) отметить так, как договоримся (тег/папка/префикс).
- Если коннектор не умеет HTML/локали: человек создаёт пустое письмо, заливка через расширение RetKit for MoEngage (`moengage_write_email`, `moengage_switch_locale`), проверка `moengage_lint_locales` / `moengage_validator`.
- Тестовая отправка — только на тестовый адрес человека.

## Шаг 5. Таблица
После создания — ссылка на письмо MoEngage в столбец «MoEngage» напротив названия (строка по названию + namespace: имена повторяются в разных namespace, напр. `mail-changing_email` в auth и core).

## Открытые вопросы (обновлять по мере ответов)
1. Замена прочих плейсхолдеров: `{{code}}`, `{{embedded.brand_name}}`, `{{embedded.company_email}}`, `{{embedded.domain}}`, `{{activation_link}}`, `{{embedded.user_full_name}}`…
2. Завести в MoEngage локали RU, CN, TR, IT, DE, KO, SE, HI, UR, TL, BN, JA и блоки `iq_risk_warning_noreg_<ЯЗЫК>`.
3. Нужна ли отписка `iq_unsubscribe` в системных письмах.
4. Что ставить в локаль Default MoEngage.
5. Системные письма — обычная кампания (Event Triggered) или MoEngage Inform.
6. Как в MoEngage отмечать namespace.
7. Строки без INT-ссылки (тестовые, manager_*_affstore и т.п.) — переносить ли.