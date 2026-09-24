/**
 * Конфиги моста: токен, allowlist, рабочие папки, состояние.
 *
 * Все читатели терпимы к тому, что на Windows получается само собой: BOM от
 * Блокнота и PowerShell 5.1, CRLF, комментарии в JSON (пример в README — jsonc).
 * Раньше каждая из этих мелочей молча превращала конфиг в пустой — и бот просто
 * переставал отвечать без единой ошибки.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

/** Строковый сканер JSON: вызывает onChar для всего, что вне строковых литералов. */
function mapOutsideStrings(src: string, onChar: (text: string, i: number) => { skip: number; emit: string }): string {
  let out = ''
  for (let i = 0; i < src.length;) {
    if (src[i] === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    const { skip, emit } = onChar(src, i)
    out += emit
    i += skip
  }
  return out
}

/** JSON с комментариями (// и /* *\/), висящими запятыми и BOM. */
export function parseJsonc<T>(src: string): T {
  const noComments = mapOutsideStrings(src.replace(/^﻿/, ''), (s, i) => {
    if (s[i] === '/' && s[i + 1] === '/') {
      const end = s.indexOf('\n', i)
      return { skip: (end === -1 ? s.length : end) - i, emit: '' }
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      return { skip: (end === -1 ? s.length : end + 2) - i, emit: ' ' }
    }
    return { skip: 1, emit: s[i] }
  })
  const noTrailingCommas = mapOutsideStrings(noComments, (s, i) => {
    if (s[i] === ',' && /^\s*[}\]]/.test(s.slice(i + 1))) return { skip: 1, emit: '' }
    return { skip: 1, emit: s[i] }
  })
  return JSON.parse(noTrailingCommas) as T
}

export type JsonRead<T> = { value: T; exists: boolean; error?: string }

export function readJsonFile<T>(path: string, fallback: T): JsonRead<T> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { value: fallback, exists: false }
  }
  try {
    return { value: parseJsonc<T>(raw), exists: true }
  } catch (err) {
    return { value: fallback, exists: true, error: `${path}: ${err instanceof Error ? err.message : err}` }
  }
}

/**
 * Запись через временный файл: если мост упадёт посреди записи, state.json не
 * окажется обрезанным (а с ним не пропадут все сессии чатов).
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const body = JSON.stringify(data, null, 2)
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, body)
    renameSync(tmp, path)
  } catch {
    // На Windows rename поверх файла иногда блокирует антивирус — пишем напрямую.
    writeFileSync(path, body)
    try { rmSync(tmp, { force: true }) } catch {}
  }
}

/** KEY=value построчно; терпит CRLF, BOM, пробелы вокруг «=», кавычки и export. */
export function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let value = m[2]
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1)
    out[m[1]] = value
  }
  return out
}

export function readEnvFile(path: string): Record<string, string> {
  try { return parseEnv(readFileSync(path, 'utf8')) } catch { return {} }
}

/** ~ и %ПЕРЕМЕННЫЕ% в путях — чтобы пример конфига работал без правки имени пользователя. */
export function expandPath(p: string): string {
  let s = p.trim().replace(/%([^%\\/]+)%/g, (whole, name: string) => process.env[name] ?? whole)
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = join(homedir(), s.slice(1))
  return s
}

export type Access = {
  allowFrom?: Array<string | number>
  groups?: Record<string, { requireMention?: boolean; allowFrom?: Array<string | number> }>
  ackReaction?: string
}

export type Slot = { label?: string; dir: string; addDirs?: string[] }

export type Workspaces = {
  defaults: {
    model: string
    effort: string
    permissionMode: string
    /** Лимит на одну задачу, минуты. По умолчанию 30. */
    taskTimeoutMinutes?: number
  }
  slots: Record<string, Slot>
}

export const DEFAULT_WORKSPACES: Workspaces = {
  defaults: { model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' },
  slots: {},
}

export type ResolvedSlot = {
  name: string
  dir: string
  addDirs: string[]
  /** Что пошло не так при разборе, чтобы показать в логе и в /status. */
  warnings: string[]
}

/**
 * Рабочая папка и доп. папки из workspaces.json.
 *
 * Слот «office» — по старой памяти; если его нет, берётся первый. Несуществующая
 * папка раньше давала spawn ENOENT, который читался как «не найден claude», —
 * теперь мост работает в домашней папке и прямо говорит, что с конфигом не так.
 */
export function resolveSlot(ws: Workspaces): ResolvedSlot {
  const warnings: string[] = []
  const entries = Object.entries(ws.slots ?? {})
  const [name, slot] = entries.find(([n]) => n === 'office') ?? entries[0] ?? ['default', { dir: '~/Desktop' }]

  let dir = expandPath(slot.dir || '~')
  if (!existsSync(dir)) {
    warnings.push(`рабочая папка не существует: ${dir} — работаю в ${homedir()}, поправь dir в workspaces.json`)
    dir = homedir()
  }
  const addDirs: string[] = []
  for (const raw of slot.addDirs ?? []) {
    const d = expandPath(raw)
    if (existsSync(d)) addDirs.push(d)
    else warnings.push(`папка проекта не найдена и пропущена: ${d}`)
  }
  return { name, dir, addDirs, warnings }
}

/** Задача, которая шла в момент остановки моста. Нужна, чтобы после перезапуска
 *  не оставить в чате вечное «⏳ работаю» и предложить повтор. */
export type Inflight = {
  chatId: number | string
  token: string
  statusId?: number
  replyTo?: number
  prompt?: string
  /** Маркер процесса claude (id сессии) — добить осиротевший процесс. */
  marker?: string
}

export type State = {
  offset: number
  sessions: Record<string, string>
  /** Переопределения, выставленные командами из чата. Переживают перезапуск моста. */
  settings?: { model?: string; effort?: string }
  inflight?: Record<string, Inflight>
}
