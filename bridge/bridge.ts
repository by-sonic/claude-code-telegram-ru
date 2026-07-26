#!/usr/bin/env bun
/**
 * Мост Telegram ↔ Claude Code, не зависящий от Channels.
 *
 * Зачем: официальная фича Channels выключена политикой Team-организации, и включить
 * её может только владелец. Но сам транспорт нам не нужен — мост сам опрашивает
 * Bot API и запускает Claude headless-вызовами, как это делают сторонние решения.
 *
 * Единственное жёсткое условие: официальный плагин telegram должен быть ВЫКЛЮЧЕН
 * (claude plugin disable telegram). Telegram допускает одного getUpdates-консьюмера
 * на токен, иначе оба поллера получают 409 и дерутся за слот.
 *
 * Запуск:  bun ~/.claude/tg/bridge/bridge.ts
 */

import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

import { Telegram, type InlineKeyboard, type TgMessage } from './telegram.ts'
import { runClaude, type ClaudeEvent } from './claude.ts'

const execFileAsync = promisify(execFile)

/**
 * Корень проекта — папка, где лежат voice2text.py, bridge-prompt.md и workspaces.json.
 *
 * Считается от расположения самого файла, а не от фиксированного пути: репозиторий
 * клонируют куда угодно, и захардкоженный каталог заставлял бы всех держать его в
 * одном месте. Переопределяется переменной CLAUDE_TG_HOME.
 */
const TG_HOME = process.env.CLAUDE_TG_HOME ?? join(import.meta.dir, '..')
const STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const STATE_FILE = join(import.meta.dir, 'state.json')
const VOICE_SCRIPT = join(TG_HOME, 'voice2text.py')

const TASK_TIMEOUT_MS = 30 * 60 * 1000
const PROGRESS_EDIT_INTERVAL_MS = 2500

/**
 * Маркер, которым Claude перечисляет файлы для отправки в чат. Явная конвенция,
 * а не выковыривание путей из текста: пути упоминаются в ответах постоянно, и
 * угадывание превращалось бы в рассылку случайных файлов.
 */
const FILES_MARKER = '@@FILES@@'
const MAX_OUTBOUND_FILES = 10
const MAX_FILE_BYTES = 50 * 1024 * 1024 // лимит выгрузки у ботов

/** Отрезает от ответа блок с путями файлов. */
function extractFiles(text: string): { text: string; files: string[] } {
  const idx = text.lastIndexOf(FILES_MARKER)
  if (idx === -1) return { text, files: [] }
  const files = text
    .slice(idx + FILES_MARKER.length)
    .split('\n')
    .map(line => line.trim().replace(/^[-*•]\s*/, '').replace(/^`|`$/g, '').trim())
    .filter(Boolean)
  return { text: text.slice(0, idx).trimEnd(), files }
}

type Access = {
  allowFrom?: string[]
  groups?: Record<string, { requireMention?: boolean; allowFrom?: string[] }>
  ackReaction?: string
}

type Slot = {
  dir: string
  addDirs?: string[]
  bridgePrompt?: string
}

type Workspaces = {
  defaults: { model: string; effort: string; permissionMode: string }
  slots: Record<string, Slot>
}

type State = {
  offset: number
  sessions: Record<string, string>
  /** Переопределения, выставленные командами из чата. Переживают перезапуск моста. */
  settings?: { model?: string; effort?: string }
}

const MODELS = ['opus', 'sonnet', 'haiku', 'fable']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const HELP = [
  'Что я понимаю:',
  '',
  '/status — что запущено, модель, текущая задача',
  '/new — начать разговор с чистого листа',
  '/model opus|sonnet|haiku|fable — сменить модель',
  '/effort low|medium|high|xhigh|max — глубина раздумий',
  '/stop — отменить текущую задачу (то же, что кнопка)',
  '/help — это сообщение',
  '',
  'Голосовые расшифровываются автоматически. Файлы и фото можно прикладывать.',
  'Результаты-файлы приходят документами — их можно пересылать дальше.',
].join('\n')

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}с`
  const min = Math.floor(total / 60)
  const sec = total % 60
  return sec ? `${min}м${sec}с` : `${min}м`
}

function log(msg: string): void {
  // Местное время, а не UTC: лог сопоставляют с временем сообщений в Telegram,
  // и расхождение на часовой пояс превращает это в загадку.
  const stamp = new Date().toLocaleTimeString('ru-RU', { hour12: false })
  console.log(`[${stamp}] ${msg}`)
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

function loadToken(): string {
  const envFile = join(STATE_DIR, '.env')
  const raw = readFileSync(envFile, 'utf8')
  // \r обязателен к удалению: на CRLF регулярка не сматчится и токен потеряется.
  for (const line of raw.split('\n')) {
    const m = line.replace(/\r$/, '').match(/^(\w+)=(.*)$/)
    if (m && m[1] === 'TELEGRAM_BOT_TOKEN') return m[2].trim()
  }
  throw new Error(`нет TELEGRAM_BOT_TOKEN в ${envFile}`)
}

function saveState(state: State): void {
  mkdirSync(import.meta.dir, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

/**
 * Пропускать сообщение или нет. Гейт всегда по личности отправителя (from.id),
 * никогда по чату: в группе это разные вещи, и гейт по чату пустил бы задачи
 * от любого её участника.
 */
function gate(msg: TgMessage, access: Access, botUsername: string): { ok: boolean; why?: string } {
  const senderId = String(msg.from?.id ?? '')
  if (!senderId) return { ok: false, why: 'нет отправителя' }

  const allowFrom = access.allowFrom ?? []
  if (!allowFrom.includes(senderId)) return { ok: false, why: `отправитель ${senderId} не в allowlist` }

  if (msg.chat.type === 'private') return { ok: true }

  const group = access.groups?.[String(msg.chat.id)]
  if (!group) return { ok: false, why: `группа ${msg.chat.id} не включена` }

  const groupAllow = group.allowFrom ?? []
  if (groupAllow.length && !groupAllow.includes(senderId)) {
    return { ok: false, why: `${senderId} не в allowlist группы` }
  }

  if (group.requireMention !== false) {
    const text = msg.text ?? msg.caption ?? ''
    const mentioned = text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)
    const repliedToBot = msg.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase()
    if (!mentioned && !repliedToBot) return { ok: false, why: 'в группе нужно упоминание' }
  }
  return { ok: true }
}

/** Расшифровка голосового. Модель не принимает аудио, поэтому шаг обязателен. */
async function transcribe(path: string): Promise<string> {
  const { stdout } = await execFileAsync('uv', ['run', VOICE_SCRIPT, path], {
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
    // Без этого Python под Windows кодирует вывод локальной кодовой страницей,
    // и кириллица в транскрипте приезжает как '?'. Скрипт страхуется сам через
    // reconfigure(), но переменные надёжнее: они действуют до импорта чего-либо.
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  return stdout.trim()
}

/**
 * Приводит сообщение к тексту задачи, попутно скачивая вложения.
 * Возвращает null, если из сообщения нечего собрать.
 */
async function buildPrompt(
  msg: TgMessage, tg: Telegram, botUsername: string,
): Promise<{ prompt: string; note?: string } | null> {
  let text = (msg.text ?? msg.caption ?? '').trim()
  // Убираем упоминание бота — оно адресация, а не часть задачи.
  text = text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim()

  const attachments: string[] = []
  let note: string | undefined

  if (msg.voice || msg.audio) {
    const a = msg.voice ?? msg.audio!
    const path = await tg.download(a.file_id, 'voice')
    const transcript = await transcribe(path)
    if (!transcript) return null
    note = `услышал: ${transcript}`
    text = text ? `${text}\n\n${transcript}` : transcript
  }

  if (msg.photo?.length) {
    // Последний элемент — максимальное разрешение.
    const best = msg.photo[msg.photo.length - 1]
    attachments.push(await tg.download(best.file_id, 'photo'))
  }
  if (msg.document) attachments.push(await tg.download(msg.document.file_id, msg.document.file_name ?? 'doc'))
  if (msg.video) attachments.push(await tg.download(msg.video.file_id, msg.video.file_name ?? 'video'))

  if (!text && !attachments.length) return null

  let prompt = text || 'Разбери приложенный файл и скажи, что с ним делать.'
  if (attachments.length) {
    prompt += `\n\nПриложенные файлы (прочитай их сам):\n${attachments.map(p => `- ${p}`).join('\n')}`
  }
  return { prompt, note }
}

async function main(): Promise<void> {
  const token = loadToken()
  const tg = new Telegram(token, INBOX_DIR)
  const me = await tg.getMe()
  const botUsername = me.username

  const workspaces = readJson<Workspaces>(join(TG_HOME, 'workspaces.json'), {
    defaults: { model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' },
    slots: {},
  })
  const slot: Slot = workspaces.slots.office ?? { dir: join(homedir(), 'Desktop') }
  const promptFile = join(TG_HOME, 'bridge-prompt.md')
  const addDirs = (slot.addDirs ?? []).filter(d => existsSync(d))

  const state = readJson<State>(STATE_FILE, { offset: 0, sessions: {} })

  /**
   * Текущая задача чата. Одна за раз: --resume одной сессии двумя процессами
   * одновременно недопустим. token нужен, чтобы кнопка «Отменить» от прошлого
   * сообщения не убила уже следующую задачу.
   */
  type Running = {
    token: string
    kill: () => void
    prompt: string
    statusId: number
    cancelled: boolean
    steps: number
  }
  const running = new Map<string, Running>()

  const bootTime = Date.now()
  // Команды /model и /effort пишут переопределения в state, дефолты — из workspaces.json.
  const currentModel = () => state.settings?.model ?? workspaces.defaults.model
  const currentEffort = () => state.settings?.effort ?? workspaces.defaults.effort

  /** Чаты, где предыдущая задача была прервана вручную — сообщаем это следующей. */
  const interrupted = new Set<string>()

  const cancelTask = async (chatId: number | string, chatKey: string, token?: string): Promise<boolean> => {
    const task = running.get(chatKey)
    if (!task) return false
    if (token && task.token !== token) return false
    task.cancelled = true
    task.kill()
    return true
  }

  log(`мост поднят: @${botUsername}, папка ${slot.dir}`)
  log(`модель ${workspaces.defaults.model}/${workspaces.defaults.effort}, права ${workspaces.defaults.permissionMode}`)
  log(`доп. папки: ${addDirs.length}`)

  for (;;) {
    let updates
    try {
      updates = await tg.getUpdates(state.offset, 30)
    } catch (err) {
      const text = String(err)
      if (text.includes('409')) {
        log('409 Conflict — токен опрашивает кто-то ещё. Выключи плагин: claude plugin disable telegram')
      } else {
        log(`getUpdates: ${text}`)
      }
      await new Promise(r => setTimeout(r, 5000))
      continue
    }

    for (const upd of updates) {
      state.offset = Math.max(state.offset, upd.update_id + 1)
      saveState(state)

      const access = readJson<Access>(join(STATE_DIR, 'access.json'), {})

      // Нажатие инлайн-кнопки. Гейтим по отправителю так же строго, как сообщения:
      // иначе любой участник группы смог бы отменять чужие задачи.
      const cb = upd.callback_query
      if (cb) {
        const senderOk = (access.allowFrom ?? []).includes(String(cb.from.id))
        if (!senderOk) { await tg.answerCallback(cb.id, 'Нет доступа'); continue }
        const [action, token] = (cb.data ?? '').split(':')
        if (action !== 'cancel' || !cb.message) { await tg.answerCallback(cb.id); continue }
        const key = String(cb.message.chat.id)
        const stopped = await cancelTask(cb.message.chat.id, key, token)
        await tg.answerCallback(cb.id, stopped ? 'Отменяю…' : 'Эта задача уже завершилась')
        if (!stopped) await tg.edit(cb.message.chat.id, cb.message.message_id, '✅ уже завершено', null)
        continue
      }

      const msg = upd.message
      if (!msg) continue

      const verdict = gate(msg, access, botUsername)
      if (!verdict.ok) { log(`отброшено: ${verdict.why}`); continue }

      const chatKey = String(msg.chat.id)
      const plain = (msg.text ?? '').replace(new RegExp(`@${botUsername}`, 'gi'), '').trim()

      // Текстовая отмена — дубль кнопки: работает из любого клиента и когда
      // сообщение с кнопкой уже уехало вверх по истории.
      if (/^\/(stop|cancel)\b/i.test(plain) || /^(отмена|стоп)$/i.test(plain)) {
        const stopped = await cancelTask(msg.chat.id, chatKey)
        if (!stopped) await tg.send(msg.chat.id, 'Сейчас ничего не выполняется.', msg.message_id)
        continue
      }

      // Команды обрабатываются до проверки занятости: /status и /stop нужны как раз
      // тогда, когда задача идёт.
      if (plain.startsWith('/')) {
        const handled = await handleCommand(msg, chatKey, plain)
        if (handled) continue
      }

      if (running.has(chatKey)) {
        const task = running.get(chatKey)!
        await tg.send(
          msg.chat.id,
          'Занят предыдущей задачей. Отменить её и взять новую?',
          msg.message_id,
          { inline_keyboard: [[{ text: '⛔ Отменить текущую', callback_data: `cancel:${task.token}` }]] },
        )
        continue
      }

      // Ошибка внутри обработчика не должна ни валить цикл опроса, ни оставлять
      // владельца в тишине: он в дороге и не увидит, что что-то отвалилось.
      void handle(msg, chatKey).catch(err => {
        log(`чат ${chatKey}: необработанная ошибка ${err}`)
        void tg.send(msg.chat.id, `Внутренняя ошибка моста: ${err}`, msg.message_id).catch(() => {})
      })
    }
  }

  async function handle(msg: TgMessage, chatKey: string): Promise<void> {
    const access = readJson<Access>(join(STATE_DIR, 'access.json'), {})
    const ack = access.ackReaction
    if (ack) void tg.react(msg.chat.id, msg.message_id, ack)
    void tg.typing(msg.chat.id)

    // Регистрируем задачу сразу, ещё до расшифровки голоса и запуска Claude.
    // Иначе на те несколько секунд, что идёт whisper, чат считался бы свободным
    // и следующее сообщение запустило бы вторую задачу параллельно первой.
    const token = crypto.randomUUID().slice(0, 8)
    const task: Running = { token, kill: () => {}, prompt: '', statusId: 0, cancelled: false, steps: 0 }
    running.set(chatKey, task)

    try {
      await runTask(msg, chatKey, task)
    } finally {
      running.delete(chatKey)
    }
  }

  /** Возвращает true, если сообщение было командой и обработано. */
  async function handleCommand(msg: TgMessage, chatKey: string, plain: string): Promise<boolean> {
    const [cmd, ...rest] = plain.slice(1).split(/\s+/)
    const arg = rest.join(' ').trim().toLowerCase()
    const name = cmd.toLowerCase().split('@')[0] // Telegram дописывает @имябота в группах

    switch (name) {
      case 'help':
      case 'start':
        await tg.send(msg.chat.id, HELP)
        return true

      case 'status': {
        const task = running.get(chatKey)
        const lines = [
          `Мост живёт ${formatDuration(Date.now() - bootTime)}`,
          `Модель: ${currentModel()} / effort ${currentEffort()}`,
          `Папка: ${slot.dir}`,
          `Диалог: ${state.sessions[chatKey] ? 'продолжается' : 'новый'}`,
          task
            ? `Сейчас выполняется задача, шагов ${task.steps} — отменить: /stop`
            : 'Задач в работе нет',
        ]
        await tg.send(msg.chat.id, lines.join('\n'))
        return true
      }

      case 'new':
      case 'reset': {
        if (running.has(chatKey)) {
          await tg.send(msg.chat.id, 'Сначала отмени текущую задачу: /stop', msg.message_id)
          return true
        }
        delete state.sessions[chatKey]
        interrupted.delete(chatKey)
        saveState(state)
        await tg.send(msg.chat.id, 'Начал с чистого листа — прошлый контекст забыт.', msg.message_id)
        return true
      }

      case 'model': {
        if (!MODELS.includes(arg)) {
          await tg.send(msg.chat.id, `Сейчас ${currentModel()}. Доступно: ${MODELS.join(', ')}`, msg.message_id)
          return true
        }
        state.settings = { ...state.settings, model: arg }
        saveState(state)
        // Применится со следующей задачи: у текущей модель уже зафиксирована при запуске.
        await tg.send(msg.chat.id, `Модель: ${arg}. Применится к следующей задаче.`, msg.message_id)
        return true
      }

      case 'effort': {
        if (!EFFORTS.includes(arg)) {
          await tg.send(msg.chat.id, `Сейчас ${currentEffort()}. Доступно: ${EFFORTS.join(', ')}`, msg.message_id)
          return true
        }
        state.settings = { ...state.settings, effort: arg }
        saveState(state)
        await tg.send(msg.chat.id, `Effort: ${arg}. Применится к следующей задаче.`, msg.message_id)
        return true
      }

      default:
        // Не наша команда — пусть уходит в Claude как обычный текст.
        return false
    }
  }

  /**
   * Отправляет файлы, перечисленные Claude. Проблемы по каждому файлу сообщаем
   * в чат отдельной строкой: молча пропустить файл хуже, чем сказать почему —
   * владелец рассчитывает переслать их клиенту и обнаружит пропажу не сразу.
   */
  async function sendFiles(chatId: number | string, files: string[]): Promise<void> {
    if (!files.length) return
    const problems: string[] = []
    const batch = files.slice(0, MAX_OUTBOUND_FILES)

    for (const raw of batch) {
      const path = raw.replace(/^"|"$/g, '')
      try {
        if (!existsSync(path)) { problems.push(`не найден: ${path}`); continue }
        const size = statSync(path).size
        if (size === 0) { problems.push(`пустой: ${path}`); continue }
        if (size > MAX_FILE_BYTES) {
          problems.push(`больше 50 МБ, Telegram не примет: ${path}`)
          continue
        }
        await tg.sendDocument(chatId, path)
      } catch (err) {
        problems.push(`${path} — ${err}`)
      }
    }

    if (files.length > batch.length) {
      problems.push(`отправил первые ${MAX_OUTBOUND_FILES} из ${files.length}, остальные — попроси отдельно`)
    }
    if (problems.length) {
      await tg.send(chatId, `С файлами не всё гладко:\n${problems.map(p => `• ${p}`).join('\n')}`)
    }
  }

  async function runTask(msg: TgMessage, chatKey: string, task: Running): Promise<void> {
    let built
    try {
      built = await buildPrompt(msg, tg, botUsername)
    } catch (err) {
      await tg.send(msg.chat.id, `Не смог обработать вложение: ${err}`, msg.message_id)
      return
    }
    if (task.cancelled) {
      await tg.send(msg.chat.id, 'Отменено до запуска.', msg.message_id)
      return
    }
    if (!built) {
      await tg.send(msg.chat.id, 'Пусто — не понял, что нужно сделать.', msg.message_id)
      return
    }
    task.prompt = built.prompt
    if (built.note) await tg.send(msg.chat.id, built.note, msg.message_id)

    // Сессия продолжается, поэтому Claude увидит в истории оборванный ход. Без
    // пояснения он может решить, что должен молча дописать прерванное; с ним —
    // понимает, что задачу уточнили осознанно.
    let promptToSend = built.prompt
    if (interrupted.has(chatKey)) {
      interrupted.delete(chatKey)
      promptToSend =
        'Предыдущий ход был прерван мной вручную — не продолжай его, ' +
        'ориентируйся на уточнённую задачу ниже.\n\n' + promptToSend
    }

    const keyboard: InlineKeyboard = {
      inline_keyboard: [[{ text: '⛔ Отменить', callback_data: `cancel:${task.token}` }]],
    }
    const statusIds = await tg.send(msg.chat.id, '⏳ взял в работу…', undefined, keyboard)
    const statusId = statusIds[0]
    task.statusId = statusId
    let lastEdit = 0
    let steps = 0
    let lastLine = ''
    let costUsd: number | undefined
    const startedAt = Date.now()

    const paint = async (force = false) => {
      const now = Date.now()
      if (!force && now - lastEdit < PROGRESS_EDIT_INTERVAL_MS) return
      lastEdit = now
      // Кнопку передаём при каждой правке: без reply_markup Telegram её снимет.
      await tg.edit(msg.chat.id, statusId, `⏳ работаю · шагов ${steps}\n${lastLine}`.trim(), keyboard)
    }

    const onEvent = (e: ClaudeEvent) => {
      if (e.kind === 'tool') {
        steps++
        task.steps = steps // чтобы /status мог показать прогресс, пока задача идёт
        lastLine = e.hint ? `${e.name}: ${e.hint}` : e.name
        void paint()
      }
    }

    const existing = state.sessions[chatKey]
    const newId = crypto.randomUUID()

    try {
      let finalText = ''
      let failed = false
      await runClaude({
        prompt: promptToSend,
        cwd: slot.dir,
        sessionId: existing,
        newSessionId: newId,
        model: currentModel(),
        effort: currentEffort(),
        permissionMode: workspaces.defaults.permissionMode,
        systemPromptFile: existsSync(promptFile) ? promptFile : undefined,
        addDirs,
        timeoutMs: TASK_TIMEOUT_MS,
        onSpawn: kill => { task.kill = kill },
        onEvent: e => {
          onEvent(e)
          // Пишем сессию сразу, а не по завершении: иначе отмена первой задачи в
          // чате обнулила бы контекст, и уточнённое сообщение начало бы с нуля.
          if (e.kind === 'session' && !state.sessions[chatKey]) {
            state.sessions[chatKey] = e.sessionId
            saveState(state)
          }
          if (e.kind === 'done') {
            finalText = e.text
            failed = e.isError
            costUsd = e.costUsd
            if (!state.sessions[chatKey]) { state.sessions[chatKey] = e.sessionId; saveState(state) }
          }
        },
      })

      const spent = [
        `шагов ${steps}`,
        formatDuration(Date.now() - startedAt),
        costUsd !== undefined ? `$${costUsd.toFixed(2)}` : '',
      ].filter(Boolean).join(' · ')
      // null снимает кнопку: задача закрыта, нажимать больше нечего.
      await tg.edit(msg.chat.id, statusId, failed ? `⚠️ ошибка · ${spent}` : `✅ готово · ${spent}`, null)

      const { text: answer, files } = extractFiles(finalText || '')
      // Именно НОВОЕ сообщение, а не правка: только оно даёт пуш на телефон.
      await tg.send(msg.chat.id, answer || '(пустой ответ)', msg.message_id)
      await sendFiles(msg.chat.id, files)
      log(`чат ${chatKey}: готово, шагов ${steps}, файлов ${files.length}`)
    } catch (err) {
      // Убитый нами процесс тоже выходит с ошибкой — отличаем отмену от падения
      // по собственному флагу, иначе она читалась бы как сбой.
      if (task.cancelled) {
        interrupted.add(chatKey)
        await tg.edit(msg.chat.id, statusId, `⛔ отменено на шаге ${steps}`, null)
        // Возвращаем текст задачи: отменяют, чтобы дополнить, и переписывать
        // всё заново с телефона — последнее, чего хочется.
        const shown = task.prompt.length > 600 ? `${task.prompt.slice(0, 600)}…` : task.prompt
        await tg.send(
          msg.chat.id,
          `Остановил, контекст сохранён — продолжим тот же диалог.\n\nЗадача была:\n${shown}\n\n` +
          'Присылай уточнённую версию.',
        )
        log(`чат ${chatKey}: отменено на шаге ${steps}`)
        return
      }
      await tg.edit(msg.chat.id, statusId, '❌ упало', null)
      await tg.send(msg.chat.id, `Задача не выполнена: ${err}`, msg.message_id)
      log(`чат ${chatKey}: ошибка ${err}`)
    }
  }
}

/**
 * Предсмертная записка в Telegram.
 *
 * Без неё падение моста выглядит как «бот замолчал»: сообщения копятся в очереди
 * Telegram, ошибка лежит в логе на машине, до которой владелец доберётся через
 * несколько часов. Пишем напрямую, не поднимая клиент — он мог и не создаться.
 */
async function notifyFatal(reason: string): Promise<void> {
  try {
    const raw = readFileSync(join(STATE_DIR, '.env'), 'utf8')
    const token = raw.split('\n')
      .map(l => l.replace(/\r$/, '').match(/^TELEGRAM_BOT_TOKEN=(.*)$/))
      .find(Boolean)?.[1]?.trim()
    const access = readJson<Access>(join(STATE_DIR, 'access.json'), {})
    const chatId = (access.allowFrom ?? [])[0]
    if (!token || !chatId) return

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🆘 Мост упал и больше не отвечает.\n\n${reason.slice(0, 1500)}\n\n` +
              'Сообщения не потеряются — Telegram придержит их до перезапуска. ' +
              'Подними мост скриптом bridge-start.ps1.',
      }),
    })
  } catch {}
}

process.on('unhandledRejection', reason => {
  log(`необработанное отклонение промиса: ${reason}`)
})

main().catch(async err => {
  const reason = String(err?.stack ?? err)
  console.error(`мост упал: ${reason}`)
  await notifyFatal(reason)
  process.exit(1)
})
