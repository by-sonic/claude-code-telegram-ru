Быстрый VPN для России — YouTube без буферизации, Discord/Instagram/ChatGPT снова работают.
_Подключение в Telegram через [@rosevpnru_bot](https://t.me/rosevpnru_bot) — бесплатный пробный период, без регистрации, без карты._

---

# Claude Code в Telegram — ставьте задачи с телефона голосом

**Телеграм-бот для Claude Code: текст, файлы и голосовые сообщения превращаются в задачи, которые выполняются на вашем компьютере с реальными файлами проектов.** Работает без официальной фичи Channels — а значит и на корпоративном тарифе Claude Team, где каналы выключены политикой организации и включить их может только владелец.

Написали задачу голосом из машины — вернулись домой к готовому результату.

> **EN:** Telegram bot for Claude Code. Send text, files or voice notes from your phone; tasks run on your own machine against your real project files. Works **without** the official Channels research preview — so it also works on Claude Team, where Channels are disabled by org policy. Russian voice transcription via local Whisper. [English section below](#english).

---

## Что умеет

| | |
|---|---|
| 🎙 **Голосовые сообщения** | расшифровка локальным Whisper (faster-whisper `large-v3-turbo`), русский язык, ~4 с на голосовуху на CUDA |
| 💬 **Непрерывный диалог** | бот помнит контекст между сообщениями, а не отвечает разрозненными запросами |
| 📎 **Файлы в обе стороны** | фото и документы уходят в задачу; результаты приходят **документами**, готовыми к пересылке клиенту |
| ⛔ **Отмена задачи** | кнопка в чате, аналог `Esc` в CLI — **контекст сохраняется**, можно уточнить задачу и продолжить |
| 📊 **Прогресс в реальном времени** | видно, какой инструмент выполняется, сколько шагов, сколько потрачено |
| 🧭 **Маршрутизация по проектам** | проект определяется по смыслу задачи, папку указывать не нужно |
| ⚙️ **Управление из чата** | `/model`, `/effort`, `/new`, `/status` — модель и глубину раздумий можно менять с телефона |
| 🔒 **Allowlist** | гейт по ID отправителя, поддержка групповых чатов с обязательным упоминанием бота |
| 🆘 **Не молчит при падении** | если мост упал, вы получите сообщение с причиной, а не тишину |

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
                                     │  голос → Whisper → текст
                                     │  фото/документы → inbox, пути в промпт
                                     ▼
                       claude -p --resume <session-id>
                       --output-format stream-json
                                     │  события инструментов → строка прогресса
                                     ▼
                       Telegram sendMessage / sendDocument
```

Непрерывность диалога держится на id сессии: первое сообщение чата создаёт сессию через `--session-id`, каждое следующее продолжает её через `--resume`. Поэтому мосту не нужно, чтобы окно терминала висело открытым, — в отличие от Channels, которые доставляют события только в уже запущенную сессию.

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

Файл **обязательно с переводом строки LF**, без CRLF — иначе токен не прочитается (см. [Грабли](#грабли-windows)):

```powershell
$dir = "$env:USERPROFILE\.claude\channels\telegram"
New-Item -ItemType Directory -Force $dir | Out-Null
[System.IO.File]::WriteAllText("$dir\.env", "TELEGRAM_BOT_TOKEN=ВАШ_ТОКЕН`n", (New-Object System.Text.ASCIIEncoding))
```

### 3. Разрешите себе писать боту

Свой числовой ID узнайте у [@userinfobot](https://t.me/userinfobot). Создайте `%USERPROFILE%\.claude\channels\telegram\access.json` — **UTF-8 без BOM**, иначе `JSON.parse` его не съест:

```jsonc
{
  "allowFrom": ["ВАШ_ЧИСЛОВОЙ_ID"],
  "ackReaction": "👀",

  // Групповые чаты — необязательно. ID супергруппы отрицательный, с префиксом -100.
  // requireMention: бот реагирует только на @упоминание или ответ на его сообщение.
  // allowFrom внутри группы: кто из участников может ставить задачи.
  "groups": {
    "-100XXXXXXXXXX": { "requireMention": true, "allowFrom": ["ВАШ_ЧИСЛОВОЙ_ID"] }
  }
}
```

Файл читается на каждом сообщении — правки применяются без перезапуска.

### 4. Настройте проекты

В [`workspaces.json`](workspaces.json) укажите рабочую папку и папки проектов. В [`bridge-prompt.md`](bridge-prompt.md) заполните таблицу маршрутизации — по ней Claude выбирает, в каком проекте работать. В [`voice2text.py`](voice2text.py) впишите в `DOMAIN_HINT` названия своих проектов и технологий, иначе Whisper будет калечить латиницу в русской речи.

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
| `/status` | сколько живёт мост, модель, идёт ли задача и на каком шаге |
| `/new` | начать разговор с чистого листа |
| `/model opus\|sonnet\|haiku\|fable` | сменить модель |
| `/effort low\|medium\|high\|xhigh\|max` | глубина раздумий |
| `/stop` | отменить текущую задачу (то же, что кнопка) |
| `/help` | список команд |

---

## Файлы

**В мост:** прикладывайте фото, документы, видео — они скачиваются в `~/.claude/channels/telegram/inbox/`, пути уходят в задачу, Claude читает их сам. Лимит на скачивание у ботов — 20 МБ.

**Из моста:** Claude заканчивает ответ блоком, а мост его вырезает и отправляет файлы:

```
@@FILES@@
C:\путь\инструкция.md
C:\путь\install.sh
```

Документами, а не фото — файл сохраняется байт-в-байт, и его можно **переслать заказчику прямо из чата**. Конвенция явная, а не выковыривание путей из текста: пути упоминаются в ответах постоянно, и угадывание превратилось бы в рассылку случайных файлов. До 10 файлов, каждый до 50 МБ.

---

## Отмена задачи

Под сообщением о прогрессе — кнопка **⛔ Отменить**. Дубль на случай, когда сообщение уехало вверх по истории: `/stop`.

Ключевое: **контекст сохраняется.** Сессия та же, следующее сообщение продолжает диалог — можно отменить, дополнить задачу и продолжить с того же места. Ровно как `Esc` в CLI. В чат возвращается текст отменённой задачи, чтобы её дополнять, а не набирать заново с телефона.

Задача убивается **по маркеру**, а не обходом дерева процессов: к моменту отмены `claude` уже развернул рабочие процессы, и при исчезновении промежуточного родителя они переподвешиваются и выпадают из дерева. `taskkill /T` оставлял сирот — проверено.

---

## Права доступа

По умолчанию `permissionMode: bypassPermissions` — Claude работает автономно и ничего не спрашивает.

Это не небрежность, а следствие архитектуры: подтверждать запросы разрешений из Telegram негде, и задача просто встанет насмерть в ожидании ответа, которого никто не даст. (Официальный плагин это умеет — у него есть permission relay с инлайн-кнопками. Ещё один повод предпочесть его, если Channels вам доступны.)

**Отсюда серьёзное предупреждение.** Кто попал в `allowFrom`, тот получает автономное выполнение кода на вашей машине с доступом к вашим файлам, ключам и продакшн-доступам. Держите там только себя. В групповых чатах обязательно указывайте `allowFrom` внутри группы, иначе задачи сможет ставить любой участник.

---

## Грабли Windows

Собраны дорогой ценой — если пишете что-то похожее, сэкономят вам вечер.

**`.env` только с LF.** Плагин и мост парсят его регуляркой `^(\w+)=(.*)$` после `split('\n')`. От CRLF остаётся `\r`, который в JavaScript не матчится ни точкой, ни `$` — токен теряется молча. `Set-Content` в PowerShell пишет именно CRLF.

**`.ps1` с кириллицей — только UTF-8 с BOM.** PowerShell 5.1 иначе читает файл в системной ANSI-кодировке и падает на парсинге. Особенно коварно, когда вывод скрипта подавлен: выглядит как «функция просто не работает». То же для JSON, который читают скрипты — читайте явно: `[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)`.

**`spawn(..., { shell: true })` разрывает промпт.** Аргументы склеиваются через пробел и уходят в `cmd.exe` без квотинга — до Claude доезжает первое слово. Симптом: он отвечает «договори мысль, приходят обрывки». Запускать надо `claude.exe` напрямую с `shell: false`; `claude` в `PATH` — это `claude.ps1`, который без шелла не запустится, поэтому путь к exe резолвится в [`bridge/claude.ts`](bridge/claude.ts) и переопределяется переменной `CLAUDE_EXE`. Та же беда у `Start-Process -ArgumentList` с массивом: элементы не квотируются.

**Python пишет stdout в локальной кодовой странице.** Кириллица в транскрипте приезжает как `?`. Лечится `PYTHONUTF8=1` при запуске плюс `reconfigure(encoding='utf-8')` в скрипте.

**CUDA-библиотеки под `uv run` не находятся через `site.getsitepackages()`.** Он возвращает эфемерный каталог сборки, а колёса `nvidia-*` лежат в контент-кеше uv и подключаются через `sys.path`. Итог — `cublas64_12.dll is not found`. Сканировать надо `sys.path` плюс `nvidia.__path__`.

**`model.transcribe()` в faster-whisper возвращает ленивый генератор.** Вычисления идут при обходе сегментов, поэтому ошибка загрузки CUDA вылетает **после** конструктора. Фолбэк на CPU обязан оборачивать и обход генератора, иначе он бесполезен.

**Процесс, запущенный с `-NoNewWindow`, умирает вместе с консолью родителя.** Для фонового демона нужен `-WindowStyle Hidden` — своя консоль отвязывает его от родителя.

---

## Ограничения

- **Только Windows.** Отмена задач и лончеры — на PowerShell. Логика моста (`bridge/*.ts`) кросс-платформенная, портирование сводится к переписыванию `kill-task.ps1` и трёх скриптов запуска. PR приветствуются.
- **Одна задача на чат за раз.** `--resume` одной сессии двумя процессами недопустим. Пока занят, мост предложит отменить текущую.
- **Компьютер должен быть включён,** и мост запущен. Сон Windows его убивает — выставьте «никогда не засыпать», если работаете в дороге. Сообщения при этом не теряются: Telegram держит очередь и отдаст накопленное после перезапуска.
- **Лимиты Bot API:** входящие файлы до 20 МБ, исходящие до 50 МБ, истории и поиска нет.
- **Лимит на задачу** — 30 минут, потом процесс убивается.

---

## English

Telegram bot that turns text, files and voice notes into Claude Code tasks running on your own machine against your real project files.

**Why not the official plugin?** Anthropic ships [`telegram@claude-plugins-official`](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram), and it is better than this bridge — use it if you can. But Channels are a research preview, **disabled by default on Team and Enterprise plans** until an org owner flips a server-side toggle. `channelsEnabled` is a managed setting users cannot override.

The failure signature is confusing: the plugin's MCP server reports **Connected**, its tools work (`reply` actually sends messages), the port listens — but channel events are silently dropped. This bridge sidesteps Channels entirely: it long-polls the Bot API itself and drives Claude Code through headless `claude -p --resume` calls, so conversation context carries across messages.

Features: local Whisper transcription (Russian-tuned, GPU-accelerated), file attachments both ways, task cancellation that **preserves context** (the `Esc` equivalent), live progress, project routing by task content, `/model` and `/effort` from chat, sender allowlist with group support, crash notification.

Requires Windows, Claude Code, [Bun](https://bun.sh), [uv](https://docs.astral.sh/uv/). See [Быстрый старт](#быстрый-старт) — the commands are copy-pasteable regardless of language. Windows-only for now; the TypeScript core is portable, only PowerShell launchers need porting.

**Security:** default permission mode is `bypassPermissions`, because there is nowhere to approve prompts from Telegram. Anyone in `allowFrom` gets autonomous code execution on your machine. Keep it to yourself.

---

## Лицензия

[MIT](LICENSE)

Проект не связан с Anthropic. Claude и Claude Code — товарные знаки Anthropic.
