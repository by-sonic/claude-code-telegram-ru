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
 * Запуск:  bun bridge/bridge.ts   (обычно — через bridge-start.ps1)
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'

import { callbackAllowed, gate, stripMention } from './access.ts'
import {
  runClaude, SessionNotFoundError, TaskAbortedError, TaskTimeoutError,
  type ClaudeEvent, type ClaudeResult,
} from './claude.ts'
import {
  DEFAULT_WORKSPACES, expandPath, readEnvFile, readJsonFile, resolveSlot, writeJsonAtomic,
  type Access, type State, type Workspaces,
} from './config.ts'
import { clip, escapeHtml, extractFiles, formatDuration } from './format.ts'
import { killTask, spawnTask } from './proc.ts'
import {
  Telegram, TelegramError,
  type InlineKeyboard, type TgCallbackQuery, type TgMessage, type TgMessageOrigin, type TgUpdate,
} from './telegram.ts'

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
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const STATE_FILE = join(import.meta.dir, 'state.json')
const VOICE_SCRIPT = join(TG_HOME, 'voice2text.py')
const PROMPT_FILE = join(TG_HOME, 'bridge-prompt.md')

const PROGRESS_EDIT_INTERVAL_MS = 2500
/** Как часто обновлять «печатает…» и строку статуса, даже если событий нет. */
const HEARTBEAT_MS = 5000
/**
 * Сколько ждать следующих сообщений, прежде чем взять задачу. Альбом фото,
 * «пересланное + комментарий», пара сообщений подряд приходят отдельными
 * апдейтами — без паузы первое уходило в работу одно, а остальные натыкались
 * на «занят».
 */
const DEBOUNCE_MS = 1200
const TRANSCRIBE_TIMEOUT_MS = 30 * 60_000
const MAX_OUTBOUND_FILES = 10
const MAX_FILE_BYTES = 50 * 1024 * 1024 // лимит выгрузки у ботов

const MODELS = ['opus', 'sonnet', 'haiku', 'fable']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const COMMANDS = [
  { command: 'status', description: 'что происходит: задача, модель, очередь' },
  { command: 'stop', description: 'отменить текущую задачу' },
  { command: 'new', description: 'начать разговор с чистого листа' },
  { command: 'model', description: 'сменить модель' },
  { command: 'effort', description: 'глубина раздумий' },
  { command: 'help', description: 'что я умею' },
]

const HELP = [
  'Пиши задачу текстом или голосом (кружочки тоже расшифровываю), прикладывай фото и файлы.',
  '',
  '/status — что запущено, модель, текущая задача',
  '/stop — отменить текущую задачу (то же, что кнопка ⛔)',
  '/new — начать разговор с чистого листа',
  '/model — сменить модель',
  '/effort — глубина раздумий',
  '/help — это сообщение',
  '',
  'Пока я занят, новые сообщения встают в очередь и уходят следующим ходом.',
  'Результаты-файлы приходят документами — их можно пересылать дальше.',
].join('\n')

function log(msg: string): void {
  // Местное время с датой: лог сопоставляют с временем сообщений в Telegram, а мост
  // живёт неделями — без даты строки разных дней не отличить.
  const stamp = new Date().toLocaleString('ru-RU', { hour12: false })
  console.log(`[${stamp}] ${msg}`)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Текст ошибки без «Error: » — его видит человек в чате. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Готовый промпт — повтор задачи по кнопке. */
type PromptInput = { prompt: string; replyTo?: number; retry?: boolean }
type Input = { msg: TgMessage } | PromptInput

const voiceOf = (m: TgMessage) => m.voice ?? m.video_note ?? m.audio

/** Вложения, которые скачиваются и уходят Claude путями. */
function filesOf(m: TgMessage): Array<{ file: { file_id: string; file_size?: number }; name: string }> {
  const out: Array<{ file: { file_id: string; file_size?: number }; name: string }> = []
  const photo = m.photo?.[m.photo.length - 1] // последний элемент — максимальное разрешение
  if (photo) out.push({ file: photo, name: 'photo' })
  // Для GIF Telegram присылает и animation, и document — document покрывает оба.
  if (m.document) out.push({ file: m.document, name: m.document.file_name ?? 'document' })
  if (m.video) out.push({ file: m.video, name: m.video.file_name ?? 'video' })
  return out
}

function originName(o: TgMessageOrigin): string {
  switch (o.type) {
    case 'user': {
      const u = o.sender_user
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'пользователь'
      return u.username ? `${name} (@${u.username})` : name
    }
    case 'hidden_user': return o.sender_user_name
    case 'chat': return o.sender_chat.title ?? 'чат'
    case 'channel': return o.chat.title ?? 'канал'
  }
}

/** Контекст ответа: на что именно отвечает владелец. */
function quoteContext(msg: TgMessage): string {
  const reply = msg.reply_to_message
  const quoted = msg.quote?.text ?? reply?.text ?? reply?.caption
  if (!quoted) return ''
  // Ответ на строку статуса моста («✅ готово · …») смысла не несёт.
  if (!msg.quote && reply?.from?.is_bot && /^[⏳✅⚠❌⛔🎙📥⏱🤷]/u.test(quoted)) return ''
  return `(в ответ на: «${clip(quoted, 500)}»)`
}

function whisperCached(): boolean {
  const hub = process.env.HF_HUB_CACHE ?? join(process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface'), 'hub')
  try { return readdirSync(hub).some(n => n.toLowerCase().includes('whisper')) } catch { return false }
}

/**
 * Расшифровка голосового. Модель не принимает аудио, поэтому шаг обязателен.
 *
 * Отменяемая и с таймаутом: раньше «Отменить» во время расшифровки ничего не
 * делало, а зависший whisper держал чат занятым навсегда.
 */
function transcribe(path: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) return reject(new TaskAbortedError())
    const child = spawnTask('uv', ['run', VOICE_SCRIPT, path], {
      // Без этого Python под Windows кодирует вывод локальной кодовой страницей,
      // и кириллица в транскрипте приезжает как '?'. Скрипт страхуется сам через
      // reconfigure(), но переменные надёжнее: они действуют до импорта чего-либо.
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
    // Имя файла уникально (в нём метка времени) и есть в командной строке uv и python.
    const marker = basename(path)
    let stdout = ''
    let stderr = ''
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => finish(() => { killTask(marker, child.pid); reject(new TaskAbortedError()) })
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(() => {
      killTask(marker, child.pid)
      reject(new Error(`расшифровка не уложилась в ${formatDuration(TRANSCRIBE_TIMEOUT_MS)}`))
    }), TRANSCRIBE_TIMEOUT_MS)

    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString('utf8')).slice(-4000) })
    child.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(new Error(
      err.code === 'ENOENT'
        ? 'не найден uv — он нужен для расшифровки голосовых: scoop install uv'
        : `не удалось запустить расшифровку: ${err.message}`,
    ))))
    child.on('close', code => finish(() => {
      if (code === 0) return resolvePromise(stdout.trim())
      // voice2text.py пишет причину строкой «[error] …» — её и показываем, без простыни лога.
      const lines = stderr.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      const reason = lines.filter(l => l.includes('[error]')).pop()?.replace(/^.*\[error\]\s*/, '') ?? lines.pop()
      reject(new Error(`расшифровка не удалась: ${clip(reason ?? `код выхода ${code}`, 300)}`))
    }))
  })
}

type Task = {
  /** Короткий id для кнопок: «Отменить» от прошлого сообщения не убьёт следующую задачу. */
  token: string
  chat: Chat
  /** Поколение диалога: после /new поздние события старой задачи не пишут сессию. */
  generation: number
  inputs: Input[]
  replyTo?: number
  isRetry: boolean
  abort: AbortController
  cancelled: boolean
  /** Отмена через /new — без сообщения «Остановил…». */
  silent: boolean
  statusId?: number
  prompt: string
  marker?: string
  phase: string
  startedAt: number
  claudeStartedAt?: number
  steps: number
  lastTool: string
  lastText: string
  plan?: { done: number; total: number; current: string }
  noticeSent: boolean
  noticeIds: number[]
  finished: boolean
  lastPainted: string
  lastPaintAt: number
  /** Правки статуса идут строго по очереди: иначе запоздавшая правка «⏳ работаю»
   *  могла лечь поверх финального «✅ готово» и оставить вечную кнопку отмены. */
  paintChain: Promise<unknown>
}

type Chat = {
  key: string
  id: number | string
  queue: Input[]
  timer?: ReturnType<typeof setTimeout>
  task?: Task
  generation: number
  /** Пояснение для следующего хода: предыдущий был оборван. */
  interrupted?: string
}

async function main(): Promise<void> {
  const env = readEnvFile(ENV_FILE)
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error(`нет TELEGRAM_BOT_TOKEN в ${ENV_FILE}`)
  const tg = new Telegram(token, INBOX_DIR, process.env.TELEGRAM_API_URL || env.TELEGRAM_API_URL || undefined)

  // Сеть при автозапуске поднимается не сразу (VPN, Wi-Fi после сна) — раньше мост
  // в этом случае падал насовсем. Ждём связь, а не умираем.
  let me: Awaited<ReturnType<Telegram['getMe']>>
  for (let attempt = 1; ; attempt++) {
    try {
      me = await tg.getMe()
      break
    } catch (err) {
      if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
        throw new Error(`Telegram не принял токен (${err.description}) — проверь TELEGRAM_BOT_TOKEN в ${ENV_FILE}`)
      }
      const wait = Math.min(60, 5 * attempt)
      log(`нет связи с Telegram: ${errText(err)} — повтор через ${wait} с`)
      await sleep(wait * 1000)
    }
  }
  const botUsername = me.username

  const wsRead = readJsonFile<Workspaces>(join(TG_HOME, 'workspaces.json'), DEFAULT_WORKSPACES)
  if (wsRead.error) log(`⚠ workspaces.json не разобран, беру настройки по умолчанию: ${wsRead.error}`)
  const workspaces: Workspaces = {
    defaults: { ...DEFAULT_WORKSPACES.defaults, ...wsRead.value.defaults },
    slots: wsRead.value.slots ?? {},
  }
  const slot = resolveSlot(workspaces)
  const timeoutMinutes = Number(workspaces.defaults.taskTimeoutMinutes)
  const taskTimeoutMs = (timeoutMinutes > 0 ? timeoutMinutes : 30) * 60_000

  const stateRead = readJsonFile<State>(STATE_FILE, { offset: 0, sessions: {} })
  if (stateRead.error) log(`⚠ state.json повреждён, начинаю с чистого: ${stateRead.error}`)
  const loaded: Partial<State> = stateRead.value
  const state: State = { ...loaded, offset: loaded.offset ?? 0, sessions: loaded.sessions ?? {} }
  const saveState = () => {
    try { writeJsonAtomic(STATE_FILE, state) } catch (err) { log(`не смог сохранить state.json: ${errText(err)}`) }
  }

  const bootTime = Date.now()
  // Команды /model и /effort пишут переопределения в state, дефолты — из workspaces.json.
  const currentModel = () => state.settings?.model ?? workspaces.defaults.model
  const currentEffort = () => state.settings?.effort ?? workspaces.defaults.effort

  const chats = new Map<string, Chat>()
  const getChat = (id: number | string): Chat => {
    const key = String(id)
    let chat = chats.get(key)
    if (!chat) chats.set(key, chat = { key, id, queue: [], generation: 0 })
    return chat
  }

  /** Задачи, которые можно повторить кнопкой «🔁». Живут до перезапуска. */
  const retries = new Map<string, { chatId: number | string; inputs: Input[] }>()
  const rememberRetry = (task: Task): string => {
    const inputs: Input[] = task.prompt
      ? [{ prompt: task.prompt, replyTo: task.replyTo, retry: true }]
      : task.inputs
    retries.set(task.token, { chatId: task.chat.id, inputs })
    if (retries.size > 50) retries.delete(retries.keys().next().value!)
    return task.token
  }

  let shuttingDown = false

  // Последняя удачно прочитанная версия access.json: опечатка при правке файла не
  // должна запирать владельца снаружи. Ошибку пишем в лог один раз, а не на каждое сообщение.
  let lastGoodAccess: Access = {}
  let lastAccessError = ''
  const loadAccess = (): Access => {
    const r = readJsonFile<Access>(ACCESS_FILE, {})
    if (r.error) {
      if (r.error !== lastAccessError) log(`⚠ access.json не читается, работаю по последней рабочей версии: ${r.error}`)
      lastAccessError = r.error
      return lastGoodAccess
    }
    lastAccessError = ''
    if (!r.exists) return {}
    return (lastGoodAccess = r.value)
  }

  log(`мост поднят: @${botUsername}, папка ${slot.dir}`)
  log(`модель ${currentModel()}/${currentEffort()}, права ${workspaces.defaults.permissionMode}, лимит задачи ${formatDuration(taskTimeoutMs)}`)
  log(`доп. папки: ${slot.addDirs.length}`)
  for (const w of slot.warnings) log(`⚠ ${w}`)
  if (!existsSync(ACCESS_FILE)) log(`⚠ нет ${ACCESS_FILE} — никому нельзя ставить задачи`)

  await tg.setMyCommands(COMMANDS)

  const cancelKeyboard = (task: Task): InlineKeyboard =>
    ({ inline_keyboard: [[{ text: '⛔ Отменить', callback_data: `cancel:${task.token}` }]] })
  const retryKeyboard = (token: string): InlineKeyboard =>
    ({ inline_keyboard: [[{ text: '🔁 Повторить', callback_data: `retry:${token}` }]] })

  const persistInflight = (task: Task) => {
    state.inflight ??= {}
    state.inflight[task.chat.key] = {
      chatId: task.chat.id,
      token: task.token,
      statusId: task.statusId,
      replyTo: task.replyTo,
      prompt: task.prompt || undefined,
      marker: task.marker,
    }
    saveState()
  }

  // ── Строка статуса ───────────────────────────────────────────────────────────

  const statusText = (task: Task): string => {
    const min = Math.floor((Date.now() - task.startedAt) / 60_000)
    const lines = [
      task.claudeStartedAt ? `⏳ работаю${min ? ` · ${min} мин` : ''} · шагов ${task.steps}` : task.phase,
    ]
    if (task.plan) lines.push(`📋 ${task.plan.done}/${task.plan.total}${task.plan.current ? ` · ${task.plan.current}` : ''}`)
    if (task.lastTool) lines.push(`🔧 ${task.lastTool}`)
    if (task.lastText) lines.push(`💬 ${task.lastText}`)
    if (task.chat.queue.length) lines.push(`📥 в очереди сообщений: ${task.chat.queue.length}`)
    return lines.join('\n')
  }

  const paint = (task: Task, force = false) => {
    if (task.finished || !task.statusId) return
    const now = Date.now()
    if (!force && now - task.lastPaintAt < PROGRESS_EDIT_INTERVAL_MS) return
    const text = statusText(task)
    if (text === task.lastPainted) return
    task.lastPaintAt = now
    task.lastPainted = text
    // Кнопку передаём при каждой правке: без reply_markup Telegram её снимет.
    task.paintChain = task.paintChain.then(() =>
      task.finished ? undefined : tg.edit(task.chat.id, task.statusId!, text, cancelKeyboard(task)))
  }

  /** Финальная строка статуса; после неё промежуточные правки уже не пройдут. */
  const finalStatus = async (task: Task, text: string) => {
    task.finished = true
    await task.paintChain.catch(() => {})
    if (task.statusId) await tg.edit(task.chat.id, task.statusId, text, null, { retries: 2 })
  }

  const spentLabel = (task: Task, costUsd?: number) => [
    task.steps ? `шагов ${task.steps}` : '',
    formatDuration(Date.now() - task.startedAt),
    costUsd !== undefined ? `$${costUsd.toFixed(2)}` : '',
  ].filter(Boolean).join(' · ')

  // ── Жизненный цикл задачи ────────────────────────────────────────────────────

  const cancelTask = (task: Task, silent = false) => {
    if (task.cancelled) return
    task.cancelled = true
    task.silent = silent
    task.abort.abort()
  }

  const scheduleDispatch = (chat: Chat, delay: number) => {
    clearTimeout(chat.timer)
    chat.timer = setTimeout(() => {
      chat.timer = undefined
      try { dispatch(chat) } catch (err) { log(`чат ${chat.key}: ${errText(err)}`) }
    }, delay)
  }

  const dispatch = (chat: Chat) => {
    if (shuttingDown || chat.task || !chat.queue.length) return
    clearTimeout(chat.timer)
    chat.timer = undefined
    const inputs = chat.queue.splice(0)
    const lastMsg = [...inputs].reverse().find((i): i is { msg: TgMessage } => 'msg' in i)
    const promptInput = inputs.find((i): i is PromptInput => 'prompt' in i)
    const task: Task = {
      token: crypto.randomUUID().slice(0, 8),
      chat,
      generation: chat.generation,
      inputs,
      // Ответ — на последнее сообщение пачки: оно ближе всего к низу чата.
      replyTo: lastMsg?.msg.message_id ?? promptInput?.replyTo,
      isRetry: Boolean(promptInput?.retry),
      abort: new AbortController(),
      cancelled: false,
      silent: false,
      prompt: '',
      phase: '',
      startedAt: Date.now(),
      steps: 0,
      lastTool: '',
      lastText: '',
      noticeSent: false,
      noticeIds: [],
      finished: false,
      lastPainted: '',
      lastPaintAt: 0,
      paintChain: Promise.resolve(),
    }
    chat.task = task

    // Ошибка внутри задачи не должна ни валить мост, ни оставлять владельца в
    // тишине: он в дороге и не увидит, что что-то отвалилось.
    void runTask(task)
      .catch(async err => {
        log(`чат ${chat.key}: необработанная ошибка ${errText(err)}`)
        await finalStatus(task, '❌ внутренняя ошибка моста')
        try { await tg.send(chat.id, `Внутренняя ошибка моста: ${errText(err)}`, { replyTo: task.replyTo }) } catch {}
      })
      .finally(() => {
        if (chat.task === task) chat.task = undefined
        if (shuttingDown) return
        for (const id of task.noticeIds) void tg.clearButtons(chat.id, id)
        if (state.inflight?.[chat.key]?.token === task.token) {
          delete state.inflight[chat.key]
          saveState()
        }
        // Всё, что пришло, пока задача шла, — следующим ходом, без паузы: оно и так ждало.
        if (chat.queue.length) dispatch(chat)
      })
  }

  const runTask = async (task: Task): Promise<void> => {
    const { chat } = task
    const heartbeat = setInterval(() => {
      void tg.typing(chat.id)
      paint(task)
    }, HEARTBEAT_MS)
    try {
      void tg.typing(chat.id)
      const msgs = task.inputs.flatMap(i => ('msg' in i ? [i.msg] : []))
      const hasVoice = msgs.some(m => voiceOf(m))
      const hasFiles = msgs.some(m => filesOf(m).length)
      const many = task.inputs.length > 1 ? ` (${task.inputs.length} сообщения)` : ''
      task.phase = hasVoice
        ? `🎙 расшифровываю голосовое…${whisperCached() ? '' : '\nпервый раз качаю модель Whisper (~1.6 ГБ) — это несколько минут'}`
        : hasFiles ? `📥 скачиваю вложения${many}…` : `⏳ взял в работу${many}…`
      // Статус с кнопкой отмены — сразу, ещё до расшифровки и скачивания: раньше
      // первые секунды (а на CPU — минуты) владелец видел только тишину.
      task.statusId = (await tg.send(chat.id, task.phase, { keyboard: cancelKeyboard(task) }))[0]
      task.lastPainted = task.phase
      persistInflight(task)

      let built: Awaited<ReturnType<typeof buildPrompt>>
      try {
        built = await buildPrompt(task)
      } catch (err) {
        if (task.cancelled) return await onCancelled(task)
        log(`чат ${chat.key}: вложение — ${errText(err)}`)
        await finalStatus(task, '❌ не смог обработать вложение')
        await tg.send(chat.id, `Не смог обработать вложение: ${errText(err)}`, {
          replyTo: task.replyTo, keyboard: retryKeyboard(rememberRetry(task)),
        })
        return
      }
      if (task.cancelled) return await onCancelled(task)
      if (!built.prompt) {
        await finalStatus(task, '🤷 нечего выполнять')
        await tg.send(chat.id, built.emptyVoice
          ? 'Не разобрал речь в голосовом — попробуй ещё раз или напиши текстом.'
          : 'Такое я пока не понимаю — пришли текст, голосовое, фото или файл.', { replyTo: task.replyTo })
        return
      }
      task.prompt = built.prompt
      persistInflight(task)
      for (const t of built.transcripts) {
        await tg.send(chat.id, `🎙 услышал: ${clip(t.text, 3500)}`, { replyTo: t.replyTo })
      }
      await executeClaude(task)
    } finally {
      clearInterval(heartbeat)
      task.finished = true
    }
  }

  /**
   * Приводит сообщения к тексту задачи, попутно скачивая вложения и расшифровывая
   * голос. Несколько сообщений (альбом, пересланное с комментарием, очередь)
   * склеиваются в один ход.
   */
  const buildPrompt = async (task: Task) => {
    const parts: string[] = []
    const attachments: string[] = []
    const transcripts: Array<{ replyTo: number; text: string }> = []
    let emptyVoice = false
    const { signal } = task.abort

    for (const input of task.inputs) {
      if ('prompt' in input) { parts.push(input.prompt); continue }
      const msg = input.msg
      let text = stripMention(msg.text ?? msg.caption ?? '', botUsername)

      const voice = voiceOf(msg)
      if (voice) {
        const hint = msg.audio ? (msg.audio.file_name ?? 'audio') : msg.video_note ? 'videonote' : 'voice'
        const heard = await transcribe(await tg.download(voice, hint, signal), signal)
        if (heard) {
          transcripts.push({ replyTo: msg.message_id, text: heard })
          // Голосовое владельца — это его задача. Аудиофайл — чужая запись, то есть данные.
          const body = msg.audio ? `Расшифровка приложенной аудиозаписи:\n${heard}` : heard
          text = text ? `${text}\n\n${body}` : body
        } else {
          emptyVoice = true
        }
      }

      const files = filesOf(msg)
      for (const f of files) attachments.push(await tg.download(f.file, f.name, signal))

      const lines = [quoteContext(msg)]
      if (msg.forward_origin) {
        // Пересланное — чужой текст: помечаем, чтобы Claude не принял его за указание владельца.
        lines.push(`[Переслано от: ${originName(msg.forward_origin)}]`)
      }
      if (text) lines.push(text)
      const part = lines.filter(Boolean).join('\n')
      // Цитата или пометка пересылки без текста и без файлов (стикер в ответ) — не задача.
      if (part && (text || files.length)) parts.push(part)
    }

    if (!parts.length && !attachments.length) return { prompt: '', transcripts, emptyVoice }
    let prompt = parts.join('\n\n')
    if (!prompt.trim()) {
      prompt = attachments.length > 1
        ? 'Разбери приложенные файлы и скажи, что с ними делать.'
        : 'Разбери приложенный файл и скажи, что с ним делать.'
    }
    if (attachments.length) {
      prompt += `\n\nПриложенные файлы (прочитай их сам):\n${attachments.map(p => `- ${p}`).join('\n')}`
    }
    return { prompt, transcripts, emptyVoice }
  }

  const onClaudeEvent = (task: Task, e: ClaudeEvent) => {
    const { chat } = task
    switch (e.kind) {
      case 'session':
        // Пишем сессию сразу, а не по завершении: иначе отмена первой задачи в
        // чате обнулила бы контекст, и уточнённое сообщение начало бы с нуля.
        if (task.generation === chat.generation && !state.sessions[chat.key]) {
          state.sessions[chat.key] = e.sessionId
          saveState()
        }
        return
      case 'tool':
        task.steps++
        task.lastTool = e.hint ? `${e.name}: ${e.hint}` : e.name
        break
      case 'text': {
        const line = e.text.split('\n').map(l => l.replace(/\*\*|`|^#+\s*|^>\s*/g, '').trim()).find(Boolean)
        if (line) task.lastText = clip(line, 120)
        break
      }
      case 'plan':
        task.plan = e
        break
    }
    paint(task)
  }

  const runOnce = (task: Task, prompt: string, sessionId?: string): Promise<ClaudeResult> => {
    const newSessionId = crypto.randomUUID()
    task.marker = sessionId ?? newSessionId
    persistInflight(task)
    return runClaude({
      prompt,
      cwd: slot.dir,
      sessionId,
      newSessionId,
      model: currentModel(),
      effort: currentEffort(),
      permissionMode: workspaces.defaults.permissionMode,
      systemPromptFile: existsSync(PROMPT_FILE) ? PROMPT_FILE : undefined,
      addDirs: slot.addDirs,
      timeoutMs: taskTimeoutMs,
      signal: task.abort.signal,
      onEvent: e => onClaudeEvent(task, e),
    })
  }

  const describeFailure = (r: ClaudeResult): string => {
    if (r.errors.length) return `Claude завершился с ошибкой:\n${r.errors.join('\n')}`
    const known: Record<string, string> = {
      error_max_turns: 'исчерпан лимит ходов',
      error_during_execution: 'ошибка во время выполнения',
      error_max_budget_usd: 'исчерпан бюджет',
    }
    return `Claude завершился с ошибкой${r.subtype ? ` (${known[r.subtype] ?? r.subtype})` : ''}.`
  }

  const executeClaude = async (task: Task): Promise<void> => {
    const { chat } = task
    // Сессия продолжается, поэтому Claude увидит в истории оборванный ход. Без
    // пояснения он может решить, что должен молча дописать прерванное.
    const notes: string[] = []
    if (chat.interrupted) notes.push(chat.interrupted)
    chat.interrupted = undefined
    if (task.isRetry) notes.push('Повторяю предыдущую задачу — прошлая попытка оборвалась ошибкой.')
    const prompt = notes.length ? `${notes.join('\n')}\n\n${task.prompt}` : task.prompt

    task.claudeStartedAt = Date.now()
    paint(task, true)

    let result: ClaudeResult
    let sessionRestarted = false
    try {
      try {
        result = await runOnce(task, prompt, state.sessions[chat.key])
      } catch (err) {
        if (!(err instanceof SessionNotFoundError)) throw err
        // История сессии пропала (Claude Code чистит старые через 30 дней, или сменилась
        // рабочая папка). Раньше чат после этого был сломан до ручного /new.
        log(`чат ${chat.key}: ${err.message} — начинаю новую`)
        if (task.generation === chat.generation) {
          delete state.sessions[chat.key]
          saveState()
        }
        sessionRestarted = true
        result = await runOnce(task, prompt, undefined)
      }
    } catch (err) {
      // Убитый нами процесс тоже выходит с ошибкой — отличаем отмену от падения
      // по собственному флагу, иначе она читалась бы как сбой.
      if (task.cancelled || err instanceof TaskAbortedError) return onCancelled(task)
      if (err instanceof TaskTimeoutError) {
        chat.interrupted = 'Предыдущий ход оборвался по лимиту времени — он мог остаться недоделанным.'
        await finalStatus(task, `⏱ остановлено по лимиту · ${spentLabel(task)}`)
        await tg.send(chat.id,
          `Задача не уложилась в ${formatDuration(taskTimeoutMs)} и остановлена. Контекст сохранён — ` +
          'напиши «продолжай», чтобы доделать, или раздели задачу на части. ' +
          'Лимит задаётся в workspaces.json (taskTimeoutMinutes).', { replyTo: task.replyTo })
        log(`чат ${chat.key}: таймаут, шагов ${task.steps}`)
        return
      }
      await finalStatus(task, `❌ не выполнено · ${spentLabel(task)}`)
      await tg.send(chat.id, `Задача не выполнена: ${errText(err)}`, {
        replyTo: task.replyTo, keyboard: retryKeyboard(rememberRetry(task)),
      })
      log(`чат ${chat.key}: ошибка ${errText(err)}`)
      return
    }

    // Всегда последняя сессия из результата: при --resume она та же, но так надёжнее.
    if (task.generation === chat.generation) {
      state.sessions[chat.key] = result.sessionId
      saveState()
    }
    const spent = spentLabel(task, result.costUsd)
    // null снимает кнопку: задача закрыта, нажимать больше нечего.
    await finalStatus(task, result.isError ? `⚠️ завершилось с ошибкой · ${spent}` : `✅ готово · ${spent}`)

    const { text: answer, files } = extractFiles(result.text)
    let body = answer.trim() || (result.isError ? describeFailure(result) : '')
    if (sessionRestarted) {
      body = `⚠️ Прошлый диалог не нашёлся (история удалена или сменилась рабочая папка) — ответил в новом.\n\n${body}`
    }
    // Именно НОВОЕ сообщение, а не правка: только оно даёт пуш на телефон.
    await tg.sendMarkdown(chat.id, body || '(пустой ответ)', {
      replyTo: task.replyTo,
      keyboard: result.isError ? retryKeyboard(rememberRetry(task)) : undefined,
    })
    await sendFiles(chat.id, files)
    log(`чат ${chat.key}: ${result.isError ? 'ошибка Claude' : 'готово'}, шагов ${task.steps}, файлов ${files.length}`)
  }

  const onCancelled = async (task: Task): Promise<void> => {
    if (shuttingDown) return
    const { chat } = task
    await finalStatus(task, `⛔ отменено${task.steps ? ` на шаге ${task.steps}` : ''} · ${formatDuration(Date.now() - task.startedAt)}`)
    log(`чат ${chat.key}: отменено на шаге ${task.steps}`)
    if (task.silent) return
    if (task.claudeStartedAt) {
      chat.interrupted = 'Предыдущий ход был прерван мной вручную — не продолжай его, ориентируйся на новое сообщение ниже.'
    }
    // Если в очереди есть сообщения — они и есть уточнение, следующая задача стартует сама.
    if (chat.queue.length) return
    if (!task.prompt) return
    // Возвращаем текст задачи: отменяют, чтобы дополнить, и переписывать всё
    // заново с телефона — последнее, чего хочется. В <pre> — копируется одним нажатием.
    const shown = task.prompt.length > 3000 ? `${task.prompt.slice(0, 3000)}…` : task.prompt
    const head = 'Остановил, контекст сохранён — следующее сообщение продолжит этот диалог.'
    await tg.sendHtml(chat.id,
      `${head}\n\nЗадача была (нажми, чтобы скопировать):\n<pre>${escapeHtml(shown)}</pre>`,
      `${head}\n\nЗадача была:\n${shown}`)
  }

  /**
   * Отправляет файлы, перечисленные Claude. Проблемы по каждому файлу сообщаем
   * в чат отдельной строкой: молча пропустить файл хуже, чем сказать почему —
   * владелец рассчитывает переслать их клиенту и обнаружит пропажу не сразу.
   */
  const sendFiles = async (chatId: number | string, files: string[]): Promise<void> => {
    if (!files.length) return
    const problems: string[] = []
    const batch = files.slice(0, MAX_OUTBOUND_FILES)

    for (const raw of batch) {
      // Относительный путь — от рабочей папки Claude, а не от папки моста.
      const path = resolve(slot.dir, expandPath(raw))
      try {
        if (!existsSync(path)) { problems.push(`не найден: ${raw}`); continue }
        const st = statSync(path)
        if (st.isDirectory()) { problems.push(`это папка, а не файл: ${raw} — попроси упаковать в архив`); continue }
        if (st.size === 0) { problems.push(`пустой: ${raw}`); continue }
        if (st.size > MAX_FILE_BYTES) { problems.push(`больше 50 МБ, Telegram не примет: ${raw}`); continue }
        await tg.sendDocument(chatId, path)
      } catch (err) {
        problems.push(`${raw} — ${errText(err)}`)
      }
    }

    if (files.length > batch.length) {
      problems.push(`отправил первые ${MAX_OUTBOUND_FILES} из ${files.length}, остальные — попроси отдельно или архивом`)
    }
    if (problems.length) {
      await tg.send(chatId, `С файлами не всё гладко:\n${problems.map(p => `• ${p}`).join('\n')}`)
    }
  }

  // ── Входящие ─────────────────────────────────────────────────────────────────

  const onIncoming = async (chat: Chat, msg: TgMessage, access: Access): Promise<void> => {
    if (access.ackReaction) void tg.react(chat.id, msg.message_id, access.ackReaction)
    chat.queue.push({ msg })
    const task = chat.task
    if (!task) return scheduleDispatch(chat, DEBOUNCE_MS)

    paint(task, true) // «📥 в очереди: N» в строке статуса
    // Альбом приходит пачкой сообщений — уведомления хватит одного на задачу.
    if (task.noticeSent) return
    task.noticeSent = true
    const [id] = await tg.send(chat.id, 'Принял 📥 Возьму следующим ходом, когда закончу текущую задачу.', {
      replyTo: msg.message_id,
      keyboard: { inline_keyboard: [[{ text: '⛔ Прервать текущую и взять сразу', callback_data: `cancel:${task.token}` }]] },
    })
    if (id) task.noticeIds.push(id)
  }

  const onEdited = async (chat: Chat, msg: TgMessage): Promise<void> => {
    // Сообщение ещё ждёт в очереди — просто подменяем его исправленной версией.
    const queued = chat.queue.findIndex(i => 'msg' in i && i.msg.message_id === msg.message_id)
    if (queued !== -1) {
      chat.queue[queued] = { msg }
      return
    }
    const running = chat.task?.inputs.some(i => 'msg' in i && i.msg.message_id === msg.message_id)
    if (running && !chat.task!.finished) {
      await tg.send(chat.id, '✏️ Правка не попадёт в задачу, которая уже идёт. Если важно — пришли уточнение отдельным сообщением.', {
        replyTo: msg.message_id,
      })
    }
  }

  const onStop = async (chat: Chat, msg: TgMessage): Promise<void> => {
    if (chat.task) {
      // Статус и сообщение об отмене пишет сама задача, когда процесс остановлен.
      cancelTask(chat.task)
      return
    }
    if (chat.queue.length) {
      chat.queue = []
      clearTimeout(chat.timer)
      chat.timer = undefined
      await tg.send(chat.id, 'Отменил — ещё не начинал.', { replyTo: msg.message_id })
      return
    }
    await tg.send(chat.id, 'Сейчас ничего не выполняется.', { replyTo: msg.message_id })
  }

  const settingKeyboard = (kind: 'model' | 'effort'): InlineKeyboard => {
    const list = kind === 'model' ? MODELS : EFFORTS
    const current = kind === 'model' ? currentModel() : currentEffort()
    const buttons = list.map(v => ({ text: v === current ? `✓ ${v}` : v, callback_data: `${kind}:${v}` }))
    const rows: InlineKeyboard['inline_keyboard'] = []
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3))
    return { inline_keyboard: rows }
  }

  const settingText = (kind: 'model' | 'effort') => kind === 'model'
    ? `Модель: ${currentModel()}. Смена применится со следующей задачи.`
    : `Effort: ${currentEffort()} — насколько глубоко думать. Смена применится со следующей задачи.`

  const setSetting = (kind: 'model' | 'effort', value: string) => {
    state.settings = { ...state.settings, [kind]: value }
    saveState()
    log(`${kind} → ${value}`)
  }

  const sendStatus = async (chat: Chat): Promise<void> => {
    const html: string[] = []
    const plain: string[] = []
    const add = (text: string, markup = escapeHtml(text)) => { plain.push(text); html.push(markup) }

    add(`🟢 Мост работает ${formatDuration(Date.now() - bootTime)}`)
    add(`Модель: ${currentModel()} · effort ${currentEffort()}`)
    add(`Папка: ${slot.dir}`)
    for (const w of slot.warnings) add(`⚠️ ${w}`)
    const session = state.sessions[chat.key]
    if (session) {
      // Продолжить тот же диалог за компьютером: сессии Claude Code привязаны к папке.
      const cmd = `cd "${slot.dir}"; claude --resume ${session}`
      add(`Диалог продолжается. Открыть его в терминале:\n${cmd}`,
        `Диалог продолжается. Открыть его в терминале:\n<code>${escapeHtml(cmd)}</code>`)
    } else {
      add('Диалог: новый')
    }
    const task = chat.task
    if (task) {
      const what = task.lastTool ? ` (${task.lastTool})` : ''
      add(`Сейчас: задача идёт ${formatDuration(Date.now() - task.startedAt)}, шагов ${task.steps}${what} — отменить: /stop`)
    } else {
      add('Задач в работе нет')
    }
    if (chat.queue.length) add(`В очереди сообщений: ${chat.queue.length}`)
    await tg.sendHtml(chat.id, html.join('\n'), plain.join('\n'))
  }

  /** Возвращает true, если сообщение было командой и обработано. */
  const handleCommand = async (chat: Chat, msg: TgMessage, plain: string): Promise<boolean> => {
    const [cmdRaw, ...rest] = plain.slice(1).split(/\s+/)
    const name = cmdRaw.toLowerCase().split('@')[0] // Telegram дописывает @имябота в группах
    const arg = rest.join(' ').trim().toLowerCase()

    switch (name) {
      case 'help':
      case 'start':
        await tg.send(chat.id, HELP)
        return true

      case 'status':
        await sendStatus(chat)
        return true

      case 'new':
      case 'reset': {
        const wasRunning = Boolean(chat.task)
        if (chat.task) cancelTask(chat.task, true)
        chat.queue = []
        clearTimeout(chat.timer)
        chat.timer = undefined
        chat.generation++
        chat.interrupted = undefined
        delete state.sessions[chat.key]
        saveState()
        await tg.send(chat.id, wasRunning
          ? 'Остановил задачу и начал с чистого листа — прошлый контекст забыт.'
          : 'Начал с чистого листа — прошлый контекст забыт.', { replyTo: msg.message_id })
        return true
      }

      case 'model':
      case 'effort': {
        if (!arg) {
          await tg.send(chat.id, settingText(name), { keyboard: settingKeyboard(name) })
          return true
        }
        const list = name === 'model' ? MODELS : EFFORTS
        // Кроме коротких имён принимаем и полный id модели: claude-…
        const valid = list.includes(arg) || (name === 'model' && /^claude-[a-z0-9.-]+(\[1m\])?$/.test(arg))
        if (!valid) {
          await tg.send(chat.id, `Не знаю «${arg}». ${settingText(name)}`, { keyboard: settingKeyboard(name) })
          return true
        }
        setSetting(name, arg)
        await tg.send(chat.id, `${name === 'model' ? 'Модель' : 'Effort'}: ${arg}. Применится со следующей задачи.`, {
          replyTo: msg.message_id,
        })
        return true
      }

      default:
        // Не наша команда — пусть уходит в Claude как обычный текст (там свои /команды).
        return false
    }
  }

  const onCallback = async (cb: TgCallbackQuery): Promise<void> => {
    const access = loadAccess()
    if (!cb.message || !callbackAllowed(cb, access)) {
      await tg.answerCallback(cb.id, 'Нет доступа')
      return
    }
    const chat = getChat(cb.message.chat.id)
    const messageId = cb.message.message_id
    const sep = (cb.data ?? '').indexOf(':')
    const action = sep === -1 ? cb.data ?? '' : cb.data!.slice(0, sep)
    const arg = sep === -1 ? '' : cb.data!.slice(sep + 1)

    switch (action) {
      case 'cancel': {
        if (chat.task && chat.task.token === arg && !chat.task.finished) {
          cancelTask(chat.task)
          await tg.answerCallback(cb.id, 'Отменяю…')
        } else {
          await tg.answerCallback(cb.id, 'Эта задача уже не выполняется')
          await tg.clearButtons(chat.id, messageId)
        }
        return
      }
      case 'retry': {
        const saved = retries.get(arg)
        await tg.clearButtons(chat.id, messageId)
        if (!saved) {
          await tg.answerCallback(cb.id, 'Уже неактуально — пришли задачу заново')
          return
        }
        retries.delete(arg)
        await tg.answerCallback(cb.id, chat.task ? 'Повторю после текущей задачи' : 'Повторяю')
        chat.queue.push(...saved.inputs)
        if (chat.task) paint(chat.task, true)
        else dispatch(chat)
        return
      }
      case 'model':
      case 'effort': {
        const list = action === 'model' ? MODELS : EFFORTS
        if (!list.includes(arg)) { await tg.answerCallback(cb.id); return }
        setSetting(action, arg)
        await tg.answerCallback(cb.id, `${action === 'model' ? 'Модель' : 'Effort'}: ${arg}`)
        await tg.edit(chat.id, messageId, settingText(action), settingKeyboard(action))
        return
      }
      default:
        await tg.answerCallback(cb.id)
    }
  }

  /** Кому ещё не подсказывали его ID — чтобы не отвечать на каждое сообщение. */
  const hinted = new Set<number>()

  const processUpdate = async (upd: TgUpdate): Promise<void> => {
    if (upd.callback_query) return onCallback(upd.callback_query)
    const msg = upd.message ?? upd.edited_message
    if (!msg) return

    const access = loadAccess()
    const verdict = gate(msg, access, botUsername)
    if (!verdict.ok) {
      log(`отброшено: ${verdict.why}`)
      // Первичная настройка: allowFrom ещё пуст — подсказываем ID прямо в чате,
      // чтобы не искать его через сторонних ботов. Кого-то уже пустили — молчим.
      const from = msg.from
      if (msg.chat.type === 'private' && from && !(access.allowFrom ?? []).length && !hinted.has(from.id)) {
        hinted.add(from.id)
        await tg.send(msg.chat.id,
          `Мост ещё не настроен: в access.json пустой allowFrom.\n\nТвой ID: ${from.id}\n` +
          'Впиши его в allowFrom в %USERPROFILE%\\.claude\\channels\\telegram\\access.json — перезапуск не нужен.')
      }
      return
    }

    const chat = getChat(msg.chat.id)
    if (upd.edited_message) return onEdited(chat, msg)

    const plain = stripMention(msg.text ?? '', botUsername)
    // Текстовая отмена — дубль кнопки: работает из любого клиента и когда
    // сообщение с кнопкой уже уехало вверх по истории.
    if (/^\/(stop|cancel)\b/i.test(plain) || /^(отмена|стоп|stop)[.!]*$/i.test(plain)) return onStop(chat, msg)

    // Команды обрабатываются сразу, мимо очереди: /status и /stop нужны как раз
    // тогда, когда задача идёт.
    if (plain.startsWith('/') && (await handleCommand(chat, msg, plain))) return

    await onIncoming(chat, msg, access)
  }

  /**
   * Задачи, которые шли, когда мост остановился (перезапуск, сон, падение). Без
   * этого в чате навсегда оставалось «⏳ работаю» с живой кнопкой, а осиротевший
   * claude мог дописывать ту же сессию параллельно с новой задачей.
   */
  const recoverInflight = async () => {
    const entries = Object.entries(state.inflight ?? {})
    if (!entries.length) return
    state.inflight = {}
    saveState()
    for (const [, inf] of entries) {
      try {
        if (inf.marker) killTask(inf.marker)
        const chat = getChat(inf.chatId)
        if (inf.statusId) await tg.edit(inf.chatId, inf.statusId, '⚠️ прервано: мост перезапускался', null)
        if (inf.prompt) {
          chat.interrupted = 'Предыдущий ход оборвался из-за перезапуска моста — он мог остаться недоделанным.'
          retries.set(inf.token, { chatId: inf.chatId, inputs: [{ prompt: inf.prompt, replyTo: inf.replyTo, retry: true }] })
          await tg.send(inf.chatId, 'Задача прервалась: мост перезапускался. Контекст сохранён — повторить?', {
            replyTo: inf.replyTo, keyboard: retryKeyboard(inf.token),
          })
        } else {
          await tg.send(inf.chatId, 'Задача прервалась: мост перезапускался. Пришли её ещё раз.', { replyTo: inf.replyTo })
        }
      } catch (err) {
        log(`восстановление после перезапуска: ${errText(err)}`)
      }
    }
  }

  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`получен ${signal} — останавливаю задачи и выхожу`)
    // inflight не чистим: при следующем старте владелец получит «прервано» и кнопку повтора.
    for (const chat of chats.values()) chat.task?.abort.abort()
    setTimeout(() => process.exit(0), 1000)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await recoverInflight()

  let failures = 0
  for (;;) {
    let updates: TgUpdate[]
    try {
      updates = await tg.getUpdates(state.offset, 30)
      if (failures) log('связь с Telegram восстановлена')
      failures = 0
    } catch (err) {
      failures++
      if (err instanceof TelegramError && err.code === 409) {
        log('409 Conflict — токен опрашивает кто-то ещё. Выключи плагин (claude plugin disable telegram) или второй экземпляр моста')
      } else if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
        throw new Error(`Telegram отозвал токен (${err.description}) — выпусти новый у @BotFather и положи в ${ENV_FILE}`)
      } else if (failures === 1 || failures % 10 === 0) {
        log(`getUpdates: ${errText(err)}`)
      }
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)))
      continue
    }

    for (const upd of updates) {
      state.offset = Math.max(state.offset, upd.update_id + 1)
      saveState()
      // Сбой на одном апдейте (сеть моргнула, сообщение удалили) не должен ронять мост.
      try {
        await processUpdate(upd)
      } catch (err) {
        log(`апдейт ${upd.update_id}: ${errText(err)}`)
      }
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
    const env = readEnvFile(ENV_FILE)
    const token = env.TELEGRAM_BOT_TOKEN
    const access = readJsonFile<Access>(ACCESS_FILE, {}).value
    const chatId = (access.allowFrom ?? [])[0]
    if (!token || !chatId) return
    const api = (process.env.TELEGRAM_API_URL || env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '')

    await fetch(`${api}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        chat_id: String(chatId),
        text: `🆘 Мост упал и больше не отвечает.\n\n${reason.slice(0, 1500)}\n\n` +
              'Сообщения не потеряются — Telegram придержит их до перезапуска. ' +
              'Подними мост скриптом bridge-start.ps1.',
      }),
    })
  } catch {}
}

process.on('unhandledRejection', reason => {
  log(`необработанное отклонение промиса: ${reason instanceof Error ? reason.stack : reason}`)
})
// Исключение в таймере или обработчике не должно гасить мост целиком: владелец
// в дороге и поднять его не сможет. Пишем в лог и работаем дальше.
process.on('uncaughtException', err => {
  log(`необработанное исключение: ${err?.stack ?? err}`)
})

main().catch(async err => {
  const reason = String(err?.stack ?? err)
  console.error(`мост упал: ${reason}`)
  await notifyFatal(errText(err))
  process.exit(1)
})
