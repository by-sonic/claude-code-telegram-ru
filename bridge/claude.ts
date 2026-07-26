/**
 * Запуск Claude Code в headless-режиме и разбор потока событий.
 *
 * Непрерывность диалога держится на session id: первое сообщение чата создаёт
 * сессию через --session-id, каждое следующее продолжает её через --resume.
 * Проверено: контекст переносится между вызовами.
 */

import { spawn } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

/**
 * Путь к claude.exe для запуска БЕЗ шелла.
 *
 * Через шелл запускать нельзя: на Windows `claude` в PATH — это claude.ps1, и
 * spawn с shell:true склеивает аргументы через пробел без квотинга. Промпт с
 * пробелами разваливается по первому же, и Claude получает одно слово вместо
 * задачи. Поэтому нужен именно исполняемый файл, тогда аргументы уходят как есть.
 */
function resolveClaudeExe(): string {
  if (process.platform !== 'win32') return 'claude'

  const fromEnv = process.env.CLAUDE_EXE
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const candidates: string[] = []

  // Рядом с node, из которого установлен пакет. Раскладка бывает двух видов.
  const nodeDir = dirname(process.execPath)
  const pkgTail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  candidates.push(join(nodeDir, 'bin', pkgTail), join(nodeDir, pkgTail))
  const scoopNode = join(homedir(), 'scoop', 'apps', 'nodejs-lts', 'current')
  candidates.push(join(scoopNode, 'bin', pkgTail), join(scoopNode, pkgTail))

  // Сборка, которую тянет за собой десктопное приложение — берём самую новую версию.
  const appRoot = join(homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code')
  try {
    const versions = readdirSync(appRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse()
    for (const v of versions) candidates.push(join(appRoot, v, 'claude.exe'))
  } catch {}

  for (const c of candidates) if (existsSync(c)) return c

  throw new Error(
    'не нашёл claude.exe — укажи путь через переменную CLAUDE_EXE. ' +
    `Искал: ${candidates.join(' | ')}`,
  )
}

const CLAUDE_EXE = resolveClaudeExe()

export type ClaudeEvent =
  /** Приходит первым, как только Claude сообщил id сессии. Нужен, чтобы сохранить
   *  сессию ДО завершения задачи: иначе отмена первой задачи в чате теряет контекст. */
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; hint: string }
  | { kind: 'done'; text: string; sessionId: string; isError: boolean; costUsd?: number }

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
  onEvent: (e: ClaudeEvent) => void
  /** Отдаёт наружу функцию досрочного убийства — для отмены задачи из чата. */
  onSpawn?: (kill: () => void) => void
}

/**
 * Убивает задачу целиком, находя процессы по уникальному маркеру.
 *
 * Дерево процессов для этого не годится: к моменту отмены claude.exe уже развернул
 * рабочие процессы, и при исчезновении промежуточного родителя они
 * переподвешиваются, выпадая из дерева. Проверено — так остаются сироты.
 * Маркером служит id сессии: он уникален и всегда есть в аргументах.
 */
function killTask(marker: string, fallbackPid?: number): void {
  if (process.platform !== 'win32') {
    if (fallbackPid) {
      try { process.kill(-fallbackPid, 'SIGKILL') } catch {
        try { process.kill(fallbackPid, 'SIGKILL') } catch {}
      }
    }
    return
  }

  const script = join(import.meta.dir, 'kill-task.ps1')
  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Marker', marker],
    { windowsHide: true, stdio: 'ignore' },
  )
  ps.on('error', () => {
    // Если PowerShell почему-то недоступен — хотя бы прямой потомок.
    if (fallbackPid) { try { process.kill(fallbackPid, 'SIGKILL') } catch {} }
  })
}

/** Короткая подсказка о том, что именно делает инструмент — для строки прогресса. */
function toolHint(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const first = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'Bash': return (first('description') || first('command')).slice(0, 60)
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit':
      return first('file_path').split(/[\\/]/).pop() ?? ''
    case 'Grep': case 'Glob': return first('pattern').slice(0, 40)
    case 'Task': case 'Agent': return first('description').slice(0, 50)
    case 'WebFetch': case 'WebSearch': return (first('url') || first('query')).slice(0, 50)
    default: return ''
  }
}

export function runClaude(opts: RunOptions): Promise<void> {
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

  return new Promise((resolve, reject) => {
    // Никакого shell: он бы склеил аргументы в одну строку и разорвал промпт по
    // первому пробелу. Прямой запуск exe отдаёт аргументы дословно.
    const child = spawn(CLAUDE_EXE, args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    let stdoutTail = ''
    let stderr = ''
    let finished = false
    let sessionSeen = false

    // Маркер — id сессии: он присутствует в аргументах как --session-id или --resume.
    const marker = opts.sessionId ?? opts.newSessionId
    opts.onSpawn?.(() => killTask(marker, child.pid))

    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      killTask(marker, child.pid)
      reject(new Error(`превышен лимит времени (${Math.round(opts.timeoutMs / 1000)} c)`))
    }, opts.timeoutMs)

    const settle = (err?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      err ? reject(err) : resolve()
    }

    child.stdout.on('data', (buf: Buffer) => {
      stdoutTail += buf.toString('utf8')
      // Событие — одна строка JSON. Последний, возможно неполный, фрагмент оставляем в буфере.
      const lines = stdoutTail.split('\n')
      stdoutTail = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let ev: any
        try { ev = JSON.parse(trimmed) } catch { continue }

        // id сессии приходит уже в первом system-событии. Отдаём его сразу, чтобы
        // сессию можно было сохранить до завершения задачи — тогда отмена не
        // обнуляет контекст и следующее сообщение продолжает тот же диалог.
        if (typeof ev.session_id === 'string' && !sessionSeen) {
          sessionSeen = true
          opts.onEvent({ kind: 'session', sessionId: ev.session_id })
        }

        if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text?.trim()) {
              opts.onEvent({ kind: 'text', text: block.text })
            } else if (block.type === 'tool_use') {
              opts.onEvent({ kind: 'tool', name: block.name, hint: toolHint(block.name, block.input) })
            }
          }
        } else if (ev.type === 'result') {
          opts.onEvent({
            kind: 'done',
            text: typeof ev.result === 'string' ? ev.result : '',
            sessionId: ev.session_id ?? opts.sessionId ?? opts.newSessionId,
            isError: Boolean(ev.is_error) || ev.subtype !== 'success',
            costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
          })
        }
      }
    })

    child.stderr.on('data', (buf: Buffer) => { stderr += buf.toString('utf8') })
    child.on('error', err => settle(new Error(`не удалось запустить claude: ${err.message}`)))
    child.on('close', code => {
      if (code === 0) return settle()
      settle(new Error(`claude вышел с кодом ${code}${stderr ? `: ${stderr.slice(0, 400)}` : ''}`))
    })
  })
}
