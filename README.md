<!-- ════════════════════════ ROSEVPN — sponsor ════════════════════════ -->

<p align="center">
  <a href="https://t.me/rosevpnru_bot">
    <img src="https://img.shields.io/badge/%F0%9F%8C%B9%20RoseVPN-%D0%9F%D0%BE%D0%BF%D1%80%D0%BE%D0%B1%D0%BE%D0%B2%D0%B0%D1%82%D1%8C%20%D0%B1%D0%B5%D1%81%D0%BF%D0%BB%D0%B0%D1%82%D0%BD%D0%BE-E63946?style=for-the-badge&logo=telegram&logoColor=white&labelColor=0a0a0a" height="44" alt="RoseVPN — попробовать бесплатно в Telegram"/>
  </a>
</p>

<p align="center">
  <b>Быстрый VPN для России</b> — YouTube без буферизации, Discord/Instagram/ChatGPT снова работают.<br/>
  <sub>Подключение в Telegram через <a href="https://t.me/rosevpnru_bot"><b>@rosevpnru_bot</b></a> — бесплатный пробный период, без регистрации, без карты.</sub>
</p>

<p align="center">
  <a href="https://t.me/rosevpnru_bot"><img alt="YouTube — без буферов" src="https://img.shields.io/badge/YouTube-%D0%B1%D0%B5%D0%B7%20%D0%B1%D1%83%D1%84%D0%B5%D1%80%D0%BE%D0%B2-E63946?style=flat-square&logo=youtube&logoColor=white"></a>
  <a href="https://t.me/rosevpnru_bot"><img alt="Discord — голос работает" src="https://img.shields.io/badge/Discord-%D0%B3%D0%BE%D0%BB%D0%BE%D1%81%20%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D0%B0%D0%B5%D1%82-E63946?style=flat-square&logo=discord&logoColor=white"></a>
  <a href="https://t.me/rosevpnru_bot"><img alt="Instagram — открывается" src="https://img.shields.io/badge/Instagram-%D0%BE%D1%82%D0%BA%D1%80%D1%8B%D0%B2%D0%B0%D0%B5%D1%82%D1%81%D1%8F-E63946?style=flat-square&logo=instagram&logoColor=white"></a>
  <a href="https://t.me/rosevpnru_bot"><img alt="ChatGPT — доступен" src="https://img.shields.io/badge/ChatGPT-%D0%B4%D0%BE%D1%81%D1%82%D1%83%D0%BF%D0%B5%D0%BD-E63946?style=flat-square&logo=openai&logoColor=white"></a>
</p>

---

# Claude Code в Telegram — ставьте задачи с телефона голосом

**Телеграм-бот для Claude Code: текст, файлы и голосовые сообщения превращаются в задачи, которые выполняются на вашем компьютере с реальными файлами проектов.** Работает без официальной фичи Channels — а значит и на корпоративном тарифе Claude Team, где каналы выключены политикой организации и включить их может только владелец.

Написали задачу голосом из машины — вернулись домой к готовому результату.

> **EN:** Telegram bot for Claude Code. Send text, files or voice notes from your phone; tasks run on your own machine against your real project files. Works **without** the official Channels research preview — so it also works on Claude Team, where Channels are disabled by org policy. Russian voice transcription via local Whisper. [English section below](#english).

---

## Что умеет

| | |
|---|---|
| 🎙 **Голосовые и «кружочки»** | расшифровка локальным Whisper (faster-whisper `large-v3-turbo`), русский язык, ~4 с на голосовуху на CUDA |
| 💬 **Непрерывный диалог** | бот помнит контекст между сообщениями, а не отвечает разрозненными запросами |
| 📥 **Очередь вместо «занят»** | пока идёт задача, новые сообщения копятся и уходят следующим ходом; альбом фото или «пересланное + комментарий» — одна задача |
| 📎 **Файлы в обе стороны** | фото и документы уходят в задачу; результаты приходят **документами**, готовыми к пересылке клиенту |
| ✍️ **Читаемые ответы** | markdown из ответа Claude превращается в разметку Telegram: жирный, код, блоки кода, ссылки |
| ⛔ **Отмена задачи** | кнопка в чате, аналог `Esc` в CLI — **контекст сохраняется**, можно уточнить задачу и продолжить |
| 🔁 **Повтор одной кнопкой** | если задача упала (API перегружен, оборвалась сеть, перезапуск моста) — не нужно набирать её заново |
| 📊 **Прогресс в реальном времени** | видно, какой инструмент выполняется, пункт плана, сколько шагов и минут, сколько потрачено |
| 🧭 **Маршрутизация по проектам** | проект определяется по смыслу задачи, папку указывать не нужно |
| ⚙️ **Управление из чата** | `/model` и `/effort` кнопками, `/new`, `/status` — и команда, чтобы продолжить тот же диалог в терминале |
| 🔒 **Allowlist** | гейт по ID отправителя, поддержка групповых чатов с обязательным упоминанием бота |
| 🆘 **Не молчит и не зависает** | сам переподключается после сна и обрывов сети; если мост всё-таки упал — пришлёт сообщение с причиной |

---

## Почему не официальные Channels

У Anthropic **есть** официальный Telegram-плагин — [`telegram@claude-plugins-official`](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram). Он хорош и умеет больше, чем описано в его README: голосовые как вложение, подтверждение прав инлайн-кнопками, реакции. Если он у вас работает — **берите его, а не этот мост.**

Проблема одна: [Channels — research preview](https://code.claude.com/docs/en/channels), и на планах **Team и Enterprise они выключены по умолчанию**, пока владелец организации не включит тумблер в админке. Локально это не обходится: `channelsEnabled` — managed-настройка, пользователь её не переопределяет.

**Как выглядит эта блокировка** (полезно, чтобы не отлаживать сутки):

- `claude mcp list` показывает плагин как **Connected**;
- его инструменты **работают** — `reply` реально отправляет сообщения в Telegram;
- порт слушается, процессы живы, в логах чисто;
- **а события канала молча теряются.** Бот получает ваши сообщения (это видно в `getUpdates`), но до Claude они не доходят.

Проверить за минуту, не трогая Telegram: поставьте демо-канал `fakechat`, запустите сессию с `--channels plugin:fakechat@claude-plugins-official`, отправьте `POST /upload` на `127.0.0.1:8787` с задачей «создай файл X» и посмотрите, появился ли файл. Не появился — каналы выключены.

Обходы без прав администратора: попросить владельца организации включить тумблер; личный аккаунт Pro/Max вне организации (там проверки политики не применяются); либо ключ Anthropic Console — при аутентификации по API-ключу каналы разрешены по умолчанию, но оплата пойдёт по токенам вместо места в подписке.

**Либо этот мост.** Он не использует Channels вообще: сам опрашивает Bot API и запускает Claude Code headless-вызовами. Политика организации гасит конкретный транспорт, а не саму возможность.

---

## Как это работает

```
Telegram Bot API  ──long poll──▶  bridge.ts
                                     │  гейт по ID отправителя (access.json)
                                     │  очередь чата: сообщения за ~1 с склеиваются
                                     │  голос → Whisper → текст
                                     │  фото/документы → inbox, пути в промпт
                                     ▼
                       claude -p --resume <session-id>
                       --output-format stream-json
                                     │  события инструментов → строка прогресса
                                     ▼
                       markdown → HTML Telegram
                       sendMessage / sendDocument
```

Непрерывность диалога держится на id сессии: первое сообщение чата создаёт сессию через `--session-id`, каждое следующее продолжает её через `--resume`. Поэтому мосту не нужно, чтобы окно терминала висело открытым, — в отличие от Channels, которые доставляют события только в уже запущенную сессию. Если история сессии пропала (Claude Code чистит старые через 30 дней, или сменилась рабочая папка), мост сам начнёт новую и честно об этом скажет.

---

## Быстрый старт

### Что нужно

- **Windows 10/11** (мост опирается на PowerShell; Linux/macOS — см. [Ограничения](#ограничения))
- [Claude Code](https://code.claude.com) с активной подпиской, `claude` в `PATH`
- [Bun](https://bun.sh) — на нём работает мост
- [uv](https://docs.astral.sh/uv/) — запускает скрипт расшифровки без ручной сборки окружения
- **NVIDIA GPU** — не обязателен, но с ним расшифровка идёт секунды вместо десятков секунд

```powershell
scoop install bun ffmpeg
scoop install uv
```

### 1. Создайте бота

В Telegram напишите [@BotFather](https://t.me/BotFather) → `/newbot` → имя → username, оканчивающийся на `bot`. Скопируйте токен.

### 2. Положите токен

Мост прочитает `.env` в любом виде (CRLF, BOM, пробелы вокруг `=`), но официальный плагин — только с переводом строки LF, поэтому пишите так (см. [Грабли](#грабли-windows)):

```powershell
$dir = "$env:USERPROFILE\.claude\channels\telegram"
New-Item -ItemType Directory -Force $dir | Out-Null
[System.IO.File]::WriteAllText("$dir\.env", "TELEGRAM_BOT_TOKEN=ВАШ_ТОКЕН`n", (New-Object System.Text.ASCIIEncoding))
```

### 3. Разрешите себе писать боту

Свой числовой ID проще всего узнать у самого бота: запустите мост (шаг 5) и напишите ему — пока `allowFrom` пуст, он ответит вашим ID. Или спросите у [@userinfobot](https://t.me/userinfobot). Создайте `%USERPROFILE%\.claude\channels\telegram\access.json` (комментарии и BOM допустимы):

```jsonc
{
  "allowFrom": ["ВАШ_ЧИСЛОВОЙ_ID"],
  "ackReaction": "👀",

  // Групповые чаты — необязательно. ID супергруппы отрицательный, с префиксом -100.
  // requireMention: бот реагирует только на @упоминание или ответ на его сообщение.
  // allowFrom внутри группы сужает общий: задачи ставит только тот, кто есть в обоих.
  "groups": {
    "-100XXXXXXXXXX": { "requireMention": true, "allowFrom": ["ВАШ_ЧИСЛОВОЙ_ID"] }
  }
}
```

Файл читается на каждом сообщении — правки применяются без перезапуска. Если при правке сломать JSON, мост продолжит работать по последней рабочей версии и напишет об ошибке в лог.

### 4. Настройте проекты

В [`workspaces.json`](workspaces.json) укажите рабочую папку и папки проектов — пути можно писать через `~` и `%ПЕРЕМЕННЫЕ%`. Там же `taskTimeoutMinutes` — лимит на одну задачу. В [`bridge-prompt.md`](bridge-prompt.md) заполните таблицу маршрутизации — по ней Claude выбирает, в каком проекте работать. В [`voice2text.py`](voice2text.py) впишите в `DOMAIN_HINT` названия своих проектов и технологий, иначе Whisper будет калечить латиницу в русской речи.

### 5. Запустите

```powershell
.\bridge-start.ps1     # поднять мост
.\status.ps1           # что запущено, модель, хвост лога
.\stop.ps1             # погасить всё
.\autostart.ps1 -Install   # поднимать при входе в систему (по желанию)
```

Первая голосовая скачает модель Whisper (~1.6 ГБ) — это один раз.

> **Важно:** если у вас включён официальный плагин `telegram@claude-plugins-official`, выключите его: `claude plugin disable telegram`. Telegram допускает **одного** потребителя `getUpdates` на токен, иначе плагин и мост дерутся за слот и оба получают 409 Conflict. `bridge-start.ps1` это проверяет и не запустится.

---

## Команды в чате

| Команда | Что делает |
|---|---|
| `/status` | сколько живёт мост, модель, идёт ли задача, что в очереди — и команда, чтобы открыть этот же диалог в терминале |
| `/stop` | отменить текущую задачу (то же, что кнопка ⛔); «стоп» и «отмена» тоже работают |
| `/new` | начать разговор с чистого листа (идущая задача останавливается) |
| `/model` | сменить модель — кнопками; можно и сразу: `/model sonnet` или полный id `claude-…` |
| `/effort` | глубина раздумий: `low` … `max`, тоже кнопками |
| `/help` | список команд |

Команды видны в меню Telegram (кнопка «/» у поля ввода) — мост регистрирует их сам. Незнакомые мосту команды уходят Claude как текст, так что работают и его собственные `/команды`.

---

## Файлы

**В мост:** прикладывайте фото (можно альбомом), документы, видео — они скачиваются в `~/.claude/channels/telegram/inbox/`, пути уходят в задачу, Claude читает их сам. Кириллица в именах файлов сохраняется. Лимит на скачивание у ботов — 20 МБ, о файле побольше мост скажет сразу.

**Из моста:** Claude заканчивает ответ блоком, а мост его вырезает и отправляет файлы:

```
@@FILES@@
C:\путь\инструкция.md
C:\путь\install.sh
```

Документами, а не фото — файл сохраняется байт-в-байт, и его можно **переслать заказчику прямо из чата**. Конвенция явная, а не выковыривание путей из текста: пути упоминаются в ответах постоянно, и угадывание превратилось бы в рассылку случайных файлов. До 10 файлов, каждый до 50 МБ. Если Claude обернёт блок в ``` или допишет что-то после него, мост это переживёт.

---

## Очередь, отмена и повтор

**Очередь.** Пока задача идёт, новые сообщения не отбрасываются, а копятся и уходят Claude **одним ходом** сразу после текущей — как ввод во время работы в CLI. На первое такое сообщение бот ответит «Принял 📥» с кнопкой **⛔ Прервать текущую и взять сразу**. Правка сообщения, которое ещё ждёт в очереди, подхватывается. Альбом фото, «пересланное + комментарий» и несколько сообщений подряд склеиваются в одну задачу.

**Отмена.** Под сообщением о прогрессе — кнопка **⛔ Отменить**. Дубль на случай, когда сообщение уехало вверх по истории: `/stop`. Работает и во время расшифровки голосового.

Ключевое: **контекст сохраняется.** Сессия та же, следующее сообщение продолжает диалог — можно отменить, дополнить задачу и продолжить с того же места. Ровно как `Esc` в CLI. В чат возвращается текст отменённой задачи (нажатие копирует его), чтобы её дополнять, а не набирать заново с телефона. Если в очереди уже есть уточнение, оно уходит в работу сразу.

**Повтор.** Если задача упала — перегружен API, оборвалась сеть, мост перезапускался посреди работы — под сообщением об ошибке будет кнопка **🔁 Повторить**.

Задача убивается **по маркеру**, а не обходом дерева процессов: к моменту отмены `claude` уже развернул рабочие процессы, и при исчезновении промежуточного родителя они переподвешиваются и выпадают из дерева. `taskkill /T` оставлял сирот — проверено.

---

## Права доступа

По умолчанию `permissionMode: bypassPermissions` — Claude работает автономно и ничего не спрашивает.

Это не небрежность, а следствие архитектуры: подтверждать запросы разрешений из Telegram негде, и задача просто встанет насмерть в ожидании ответа, которого никто не даст. (Официальный плагин это умеет — у него есть permission relay с инлайн-кнопками. Ещё один повод предпочесть его, если Channels вам доступны.)

**Отсюда серьёзное предупреждение.** Кто попал в `allowFrom`, тот получает автономное выполнение кода на вашей машине с доступом к вашим файлам, ключам и продакшн-доступам. Держите там только себя. В групповом чате задачи может ставить только тот, кто есть в общем `allowFrom`; `allowFrom` внутри группы этот список дополнительно сужает, но никогда не расширяет.

---

## Грабли Windows

Собраны дорогой ценой — если пишете что-то похожее, сэкономят вам вечер.

**`.env` только с LF.** Официальный плагин парсит его регуляркой `^(\w+)=(.*)$` после `split('\n')`. От CRLF остаётся `\r`, который в JavaScript не матчится ни точкой, ни `$` — токен теряется молча. `Set-Content` в PowerShell пишет именно CRLF, а `-Encoding UTF8` в PowerShell 5.1 добавляет ещё и BOM, на котором ломается `^\w`. Мост терпит и то и другое, плагин — нет.

**`.ps1` с кириллицей — только UTF-8 с BOM.** PowerShell 5.1 иначе читает файл в системной ANSI-кодировке и падает на парсинге. Особенно коварно, когда вывод скрипта подавлен: выглядит как «функция просто не работает». То же для JSON, который читают скрипты — читайте явно: `[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)`.

**`claude -p` с открытым stdin ждёт 3 секунды.** Если stdin не терминал, CLI ждёт из него данные для промпта и сдаётся только по таймауту: «no stdin data received in 3s». `spawn` по умолчанию даёт именно открытый пайп — каждая задача стартовала на 3 с позже. Лечится `stdio: ['ignore', …]`.

**Long poll без таймаута зависает навсегда.** После сна или смены сети TCP-соединение умирает молча, и `fetch` к `getUpdates` ждёт ответа вечно: процесс жив, в логе чисто, бот молчит. Таймаут на HTTP-запрос обязан быть длиннее `timeout` самого long poll, но конечным.

**`2>&1` и `2>$null` при `$ErrorActionPreference = 'Stop'`.** В PowerShell 5.1 любая строка, которую нативная программа пишет в stderr, становится прерывающей ошибкой — скрипт падает на безобидном предупреждении. Вызов нативной команды надо оборачивать в область с `'Continue'`.

**`spawn(..., { shell: true })` разрывает промпт.** Аргументы склеиваются через пробел и уходят в `cmd.exe` без квотинга — до Claude доезжает первое слово. Симптом: он отвечает «договори мысль, приходят обрывки». Запускать надо `claude.exe` напрямую с `shell: false`; `claude` в `PATH` — это `claude.ps1`, который без шелла не запустится, поэтому путь к exe резолвится в [`bridge/claude.ts`](bridge/claude.ts) и переопределяется переменной `CLAUDE_EXE`. Та же беда у `Start-Process -ArgumentList` с массивом: элементы не квотируются.

**Python пишет stdout в локальной кодовой странице.** Кириллица в транскрипте приезжает как `?`. Лечится `PYTHONUTF8=1` при запуске плюс `reconfigure(encoding='utf-8')` в скрипте.

**CUDA-библиотеки под `uv run` не находятся через `site.getsitepackages()`.** Он возвращает эфемерный каталог сборки, а колёса `nvidia-*` лежат в контент-кеше uv и подключаются через `sys.path`. Итог — `cublas64_12.dll is not found`. Сканировать надо `sys.path` плюс `nvidia.__path__`.

**`model.transcribe()` в faster-whisper возвращает ленивый генератор.** Вычисления идут при обходе сегментов, поэтому ошибка загрузки CUDA вылетает **после** конструктора. Фолбэк на CPU обязан оборачивать и обход генератора, иначе он бесполезен.

**Процесс, запущенный с `-NoNewWindow`, умирает вместе с консолью родителя.** Для фонового демона нужен `-WindowStyle Hidden` — своя консоль отвязывает его от родителя.

---

## Ограничения

- **Лончеры — только Windows.** Скрипты запуска на PowerShell. Сам мост (`bridge/*.ts`) кросс-платформенный: на Linux и macOS он запускается как `bun bridge/bridge.ts`, отмена задач там работает через группы процессов. PR с лончерами приветствуются.
- **Одна задача на чат за раз.** `--resume` одной сессии двумя процессами недопустим. Пока занят, новые сообщения ждут в очереди.
- **Компьютер должен быть включён,** и мост запущен. Пока машина спит, бот не отвечает — выставьте «никогда не засыпать», если работаете в дороге. После пробуждения мост переподключается сам; задача, шедшая в момент сна, может оборваться. Сообщения не теряются: Telegram держит очередь и отдаст накопленное.
- **Лимиты Bot API:** входящие файлы до 20 МБ, исходящие до 50 МБ, истории и поиска нет.
- **Лимит на задачу** — 30 минут по умолчанию (`taskTimeoutMinutes` в `workspaces.json`), потом процесс останавливается, а контекст сохраняется — можно написать «продолжай».

---

## Для разработчиков

```powershell
bun test bridge/          # юнит-тесты: разметка, нарезка, разбор конфигов, доступ
.\bridge-start.ps1 -Foreground   # мост в текущем окне, лог прямо в консоль
```

Переменные окружения: `CLAUDE_EXE` — путь к `claude.exe`, если мост не нашёл его сам (ищет в `PATH`, `~\.local\bin`, глобальных пакетах npm и сборке десктопного приложения); `CLAUDE_TG_HOME` — где лежат `workspaces.json` и `bridge-prompt.md`; `TELEGRAM_API_URL` (можно и в `.env`) — свой адрес Bot API, например зеркало или прокси.

Состояние моста — `bridge/state.json`: offset обновлений, сессии чатов, выбранные в чате модель и effort, задачи в работе (по ним после перезапуска приходит «прервано» с кнопкой повтора). Лог — `bridge/bridge.log`, лог прошлого запуска — `bridge/bridge.log.prev`.

---

## English

Telegram bot that turns text, files and voice notes into Claude Code tasks running on your own machine against your real project files.

**Why not the official plugin?** Anthropic ships [`telegram@claude-plugins-official`](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram), and it is better than this bridge — use it if you can. But Channels are a research preview, **disabled by default on Team and Enterprise plans** until an org owner flips a server-side toggle. `channelsEnabled` is a managed setting users cannot override.

The failure signature is confusing: the plugin's MCP server reports **Connected**, its tools work (`reply` actually sends messages), the port listens — but channel events are silently dropped. This bridge sidesteps Channels entirely: it long-polls the Bot API itself and drives Claude Code through headless `claude -p --resume` calls, so conversation context carries across messages.

Features: local Whisper transcription of voice notes and video notes (Russian-tuned, GPU-accelerated), a per-chat message queue instead of "busy" (albums and forward+comment become one task), file attachments both ways, markdown rendered as Telegram formatting, task cancellation that **preserves context** (the `Esc` equivalent), one-tap retry of failed tasks, recovery of tasks interrupted by a restart, live progress, project routing by task content, `/model` and `/effort` via inline buttons, sender allowlist with group support, automatic reconnect after sleep or network loss, crash notification.

Requires Windows, Claude Code, [Bun](https://bun.sh), [uv](https://docs.astral.sh/uv/). See [Быстрый старт](#быстрый-старт) — the commands are copy-pasteable regardless of language. The launchers are PowerShell; the TypeScript core also runs on Linux/macOS via `bun bridge/bridge.ts`. Tests: `bun test bridge/`.

**Security:** default permission mode is `bypassPermissions`, because there is nowhere to approve prompts from Telegram. Anyone in `allowFrom` gets autonomous code execution on your machine. Keep it to yourself.

---

## Лицензия

[MIT](LICENSE)

Проект не связан с Anthropic. Claude и Claude Code — товарные знаки Anthropic.
