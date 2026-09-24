import { describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'

import { expandPath, parseEnv, parseJsonc } from './config.ts'

describe('parseJsonc', () => {
  test('комментарии, висящие запятые и BOM', () => {
    const src = '\uFEFF{\n  // кто может писать\n  "allowFrom": ["123",], /* мой id */\n  "ackReaction": "👀", // реакция\n}\n'
    expect(parseJsonc<Record<string, unknown>>(src)).toEqual({ allowFrom: ['123'], ackReaction: '👀' })
  })

  test('// и запятые внутри строк не трогаются', () => {
    const src = '{"url": "https://example.com/a,}", "path": "C:\\\\x\\\\y", "q": "say \\"hi\\" // no"}'
    expect(parseJsonc<Record<string, unknown>>(src)).toEqual({ url: 'https://example.com/a,}', path: 'C:\\x\\y', q: 'say "hi" // no' })
  })

  test('битый JSON бросает, а не возвращает пустоту', () => {
    expect(() => parseJsonc('{"allowFrom": [123')).toThrow()
  })
})

describe('parseEnv', () => {
  test('CRLF, BOM, пробелы и кавычки', () => {
    const raw = '\uFEFFTELEGRAM_BOT_TOKEN = "123:abc"\r\n# комментарий\r\nexport OTHER=x\r\n'
    expect(parseEnv(raw)).toEqual({ TELEGRAM_BOT_TOKEN: '123:abc', OTHER: 'x' })
  })
})

describe('expandPath', () => {
  test('~ и %VAR%', () => {
    process.env.TG_TEST_DIR = '/opt/test'
    expect(expandPath('~/projects')).toBe(join(homedir(), 'projects'))
    expect(expandPath('%TG_TEST_DIR%/x')).toBe('/opt/test/x')
    expect(expandPath('%NO_SUCH_VAR_42%/x')).toBe('%NO_SUCH_VAR_42%/x')
  })
})
