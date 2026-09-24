/**
 * Запуск и принудительная остановка процессов задач — Claude и расшифровки голоса.
 */

import { spawn } from 'child_process'
import { join } from 'path'

const IS_WINDOWS = process.platform === 'win32'

/**
 * Запускает процесс задачи.
 *
 * - Без шелла: на Windows spawn с shell:true склеивает аргументы через пробел без
 *   квотинга, и промпт разваливается по первому же пробелу.
 * - stdin закрыт: `claude -p` с неинтерактивным stdin ждёт из него данные 3 секунды
 *   («no stdin data received in 3s») — открытый пайп стоил каждой задаче лишних 3 с.
 * - На POSIX — своя группа процессов: отмена убивает группу, а не только claude,
 *   иначе его потомки (сборка, тесты) остались бы сиротами.
 */
export function spawnTask(exe: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawn(exe, args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    windowsHide: true,
    detached: !IS_WINDOWS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal) } catch {
    try { process.kill(pid, signal) } catch {}
  }
}

/**
 * Убивает задачу целиком.
 *
 * На Windows — по уникальному маркеру в командной строке (kill-task.ps1): дерево
 * процессов для этого не годится, к моменту отмены claude.exe уже развернул рабочие
 * процессы, и при исчезновении промежуточного родителя они выпадают из дерева.
 * На POSIX — сигналом всей группе; если pid неизвестен (мост перезапускался),
 * процесс ищется по маркеру через pkill.
 */
export function killTask(marker: string, pid?: number): void {
  // Короткий маркер совпал бы с чужими процессами.
  if (marker.length < 8) return

  if (!IS_WINDOWS) {
    if (pid) {
      signalGroup(pid, 'SIGTERM')
      setTimeout(() => signalGroup(pid, 'SIGKILL'), 3000).unref?.()
    } else {
      spawn('pkill', ['-KILL', '-f', '--', marker], { stdio: 'ignore' }).on('error', () => {})
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
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
  })
}
