/**
 * Запуск Claude Code в headless-режиме и разбор потока событий.
 *
 * Непрерывность диалога держится на session id: первое сообщение чата создаёт
 * сессию через --session-id, каждое следующее продолжает её через --resume.
 * Проверено: контекст переносится между вызовами.
 */

import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'

import { clip, formatDuration } from './format.ts'
import { killTask, spawnTask } from './proc.ts'

let resolvedExe: string | undefined

/**
 * Путь к claude.exe для запуска БЕЗ шелла.
 *
 * Через шелл запускать нельзя: на Windows `claude` в PATH — это чаще всего
 * claude.ps1/claude.cmd, и spawn с shell:true склеивает аргументы через пробел
 * без квотинга. Поэтому нужен именно исполняемый файл.
 *
 * Ищется лениво, при первой задаче, а не при старте: если claude не найден, мост
 * всё равно поднимется и скажет об этом в чат, а не упадёт молча в лог.
 */
export function resolveClaudeExe(): string {
  if (resolvedExe) return resolvedExe

  const fromEnv = process.env.CLAUDE_EXE
  if (fromEnv) {
    if (existsSync(fromEnv)) return (resolvedExe = fromEnv)
    throw new Error(`CLAUDE_EXE указывает на несуществующий файл: ${fromEnv}`)
  }
  if (process.platform !== 'win32') return (resolvedExe = 'claude')

  const pkgTail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  const candidates: string[] = []

  // PATH: нативный установщик кладёт claude.exe в ~/.local/bin, а рядом с npm-шимом
  // claude.cmd лежит node_modules с самим пакетом.
  for (const raw of (process.env.PATH ?? '').split(delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, '')
    if (dir) candidates.push(join(dir, 'claude.exe'), join(dir, pkgTail))
  }
  // Те же места на случай, если PATH процесса старый (автозапуск раньше перелогина).
  candidates.push(join(homedir(), '.local', 'bin', 'claude.exe'))
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', pkgTail))
  for (const app of ['nodejs-lts', 'nodejs']) {
    const scoopNode = join(homedir(), 'scoop', 'apps', app, 'current')
    candidates.push(join(scoopNode, 'bin', pkgTail), join(scoopNode, pkgTail))
  }

  // Сборка, которую тянет за собой десктопное приложение, — самая новая версия.
  // Сортировка числовая: строковая поставила бы 1.9 выше 1.10.
  const appRoot = join(homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code')
  try {
    const versions = readdirSync(appRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const v of versions) candidates.push(join(appRoot, v, 'claude.exe'))
  } catch {}

  for (const c of candidates) if (existsSync(c)) return (resolvedExe = c)

  throw new Error(
    'не нашёл claude.exe — укажи полный путь в переменной окружения CLAUDE_EXE ' +
    '(узнать его: where.exe claude в cmd или (Get-Command claude).Source в PowerShell).',
  )
}

export type ClaudeEvent =
  /** Приходит первым, как только Claude сообщил id сессии. Нужен, чтобы сохранить
   *  сессию ДО завершения задачи: иначе отмена первой задачи в чате теряет контекст. */
  | { kind: 'session'; sessionId: string }
  /** Промежуточный текст основной сессии — «мысли вслух» между вызовами инструментов. */
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; hint: string }
  /** Прогресс по плану из TodoWrite. */
  | { kind: 'plan'; done: number; total: number; current: string }

export type ClaudeResult = {
  text: string
  sessionId: string
  isError: boolean
  /** success, error_max_turns, error_during_execution… */
  subtype: string
  errors: string[]
  costUsd?: number
}

export class TaskAbortedError extends Error {
  constructor() { super('задача отменена'); this.name = 'TaskAbortedError' }
}

export class TaskTimeoutError extends Error {
  constructor(readonly limitMs: number) {
    super(`превышен лимит времени на задачу (${formatDuration(limitMs)})`)
    this.name = 'TaskTimeoutError'
  }
}

/**
 * Сессия для --resume не нашлась. Так бывает, когда Claude Code удалил старую
 * историю (cleanupPeriodDays, по умолчанию 30 дней) или сменилась рабочая папка —
 * сессии хранятся по папкам. Без особой обработки чат ломался насовсем: каждое
 * сообщение падало с одной и той же ошибкой до ручного /new.
 */
export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`сессия ${sessionId} не найдена`)
    this.name = 'SessionNotFoundError'
  }
}

export type RunOptions = {
  prompt: string
  cwd: string
  /** Существующая сессия для --resume, либо undefined для новой. */
  sessionId?: string
  /** UUID для новой сессии (--session-id). Игнорируется, если задан sessionId. */
  newSessionId: string
  model: string
  effort: string
  permissionMode: string
  systemPromptFile?: string
  addDirs: string[]
  timeoutMs: number
  /** Отмена задачи из чата: процесс убивается, промис отклоняется TaskAbortedError. */
  signal?: AbortSignal
  onEvent: (e: ClaudeEvent) => void
}

/** mcp__github__create_issue → github/create_issue: в строке прогресса так читаемее. */
function toolLabel(name: string): string {
  return name.startsWith('mcp__') ? name.slice(5).replace('__', '/') : name
}

/** Короткая подсказка о том, что именно делает инструмент — для строки прогресса. */
export function toolHint(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const fileName = (p: string) => p.split(/[\\/]/).pop() ?? ''
  switch (name) {
    case 'Bash': case 'PowerShell': return clip(str('description') || str('command'), 60)
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return fileName(str('file_path'))
    case 'NotebookEdit': return fileName(str('notebook_path') || str('file_path'))
    case 'Grep': case 'Glob': return clip(str('pattern'), 40)
    case 'Task': case 'Agent': return clip(str('description'), 50)
    case 'WebFetch': return clip(str('url'), 50)
    case 'WebSearch': return clip(str('query'), 50)
    case 'Skill': return clip(str('skill') || str('command'), 40)
    case 'TodoWrite': return '' // прогресс плана показывается отдельной строкой
    default:
      return clip(
        str('description') || str('subject') || str('query') || str('url') || str('file_path') || str('pattern'),
        50,
      )
  }
}

function planProgress(name: string, input: any): ClaudeEvent | undefined {
  if (name !== 'TodoWrite' || !Array.isArray(input?.todos) || !input.todos.length) return
  const todos: any[] = input.todos
  const active = todos.find(t => t?.status === 'in_progress')
  return {
    kind: 'plan',
    done: todos.filter(t => t?.status === 'completed').length,
    total: todos.length,
    current: active ? clip(String(active.activeForm || active.content || ''), 80) : '',
  }
}

export function runClaude(opts: RunOptions): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new TaskAbortedError())

    let exe: string
    try { exe = resolveClaudeExe() } catch (err) { return reject(err) }

    const args = [
      '-p', opts.prompt,
      '--output-format', 'stream-json',
      // stream-json без --verbose отдаёт только финал: прогресс по инструментам пропадёт.
      '--verbose',
      '--model', opts.model,
      '--effort', opts.effort,
      '--permission-mode', opts.permissionMode,
    ]
    if (opts.sessionId) args.push('--resume', opts.sessionId)
    else args.push('--session-id', opts.newSessionId)
    if (opts.systemPromptFile) args.push('--append-system-prompt-file', opts.systemPromptFile)
    if (opts.addDirs.length) args.push('--add-dir', ...opts.addDirs)

    const child = spawnTask(exe, args, { cwd: opts.cwd, env: { ...process.env, FORCE_COLOR: '0' } })
    // Маркер для убийства — id сессии: он есть в аргументах как --session-id или --resume.
    const marker = opts.sessionId ?? opts.newSessionId

    let stdoutTail = ''
    let stderrTail = ''
    let sessionSeen = false
    let result: ClaudeResult | undefined
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let exitTimer: ReturnType<typeof setTimeout> | undefined

    const onAbort = () => settle(() => { killTask(marker, child.pid); reject(new TaskAbortedError()) })
    const settle = (fn: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(exitTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => settle(() => {
      killTask(marker, child.pid)
      reject(new TaskTimeoutError(opts.timeoutMs))
    }), opts.timeoutMs)

    const emit = (e: ClaudeEvent) => {
      try { opts.onEvent(e) } catch {}
    }

    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let ev: any
      try { ev = JSON.parse(trimmed) } catch { return }

      // id сессии приходит уже в первом system-событии. Отдаём его сразу, чтобы
      // сессию можно было сохранить до завершения задачи.
      if (typeof ev.session_id === 'string' && !sessionSeen) {
        sessionSeen = true
        emit({ kind: 'session', sessionId: ev.session_id })
      }

      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        // События сабагентов помечены parent_tool_use_id: их инструменты — тоже шаги
        // работы, но их текст не выдаём за мысли основной сессии.
        const nested = Boolean(ev.parent_tool_use_id)
        for (const block of ev.message.content) {
          if (block?.type === 'text' && !nested && typeof block.text === 'string' && block.text.trim()) {
            emit({ kind: 'text', text: block.text })
          } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
            emit({ kind: 'tool', name: toolLabel(block.name), hint: toolHint(block.name, block.input) })
            const plan = planProgress(block.name, block.input)
            if (plan) emit(plan)
          }
        }
      } else if (ev.type === 'result') {
        result = {
          text: typeof ev.result === 'string' ? ev.result : '',
          sessionId: typeof ev.session_id === 'string' ? ev.session_id : marker,
          isError: Boolean(ev.is_error) || (typeof ev.subtype === 'string' && ev.subtype !== 'success'),
          subtype: typeof ev.subtype === 'string' ? ev.subtype : '',
          errors: Array.isArray(ev.errors) ? ev.errors.map(String) : [],
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        }
      }
    }

    child.stdout.on('data', (buf: Buffer) => {
      stdoutTail += buf.toString('utf8')
      // Событие — одна строка JSON. Последний, возможно неполный, фрагмент оставляем в буфере.
      const lines = stdoutTail.split('\n')
      stdoutTail = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    })
    child.stderr.on('data', (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString('utf8')).slice(-4000)
    })

    const finish = (code: number | null) => settle(() => {
      if (stdoutTail.trim()) handleLine(stdoutTail)
      stdoutTail = ''
      const stderr = stderrTail.trim()
      const missing = /No conversation found/i
      if (opts.sessionId && (result?.errors.some(e => missing.test(e)) || (!result && missing.test(stderr)))) {
        return reject(new SessionNotFoundError(opts.sessionId))
      }
      // Код выхода не главное: при ошибке claude выходит с 1, но настоящая причина
      // (API недоступен, кончился лимит…) лежит в result-событии — её и показываем.
      if (result) return resolve(result)
      reject(new Error(`claude завершился без ответа (код ${code})${stderr ? `: ${clip(stderr, 400)}` : ''}`))
    })

    child.on('error', err => settle(() => reject(new Error(`не удалось запустить claude (${exe}): ${err.message}`))))
    child.on('close', code => finish(code))
    // Страховка: если stdout унаследовал фоновый потомок, 'close' может не прийти
    // никогда, а задача — висеть «в работе» вечно. Процесс вышел — ждём хвост 3 с.
    child.on('exit', code => { exitTimer = setTimeout(() => finish(code), 3000) })
  })
}
