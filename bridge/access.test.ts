import { describe, expect, test } from 'bun:test'

import { callbackAllowed, gate, isAllowed, stripMention } from './access.ts'
import type { TgMessage } from './telegram.ts'

const BOT = 'my_helper_bot'

function msg(over: Partial<TgMessage> & { fromId?: number; chatId?: number; chatType?: string }): TgMessage {
  const { fromId = 111, chatId = fromId, chatType = 'private', ...rest } = over
  return { message_id: 1, date: 0, from: { id: fromId }, chat: { id: chatId, type: chatType }, ...rest }
}

describe('isAllowed', () => {
  test('ID числом и строкой равноправны', () => {
    expect(isAllowed([111], 111)).toBe(true)
    expect(isAllowed(['111'], 111)).toBe(true)
    expect(isAllowed([' 111 '], '111')).toBe(true)
    expect(isAllowed(['1111'], 111)).toBe(false)
    expect(isAllowed(undefined, 111)).toBe(false)
  })
})

describe('gate', () => {
  test('личка: только из allowFrom', () => {
    expect(gate(msg({ text: 'hi' }), { allowFrom: [111] }, BOT).ok).toBe(true)
    expect(gate(msg({ text: 'hi', fromId: 222 }), { allowFrom: [111] }, BOT).ok).toBe(false)
  })

  test('группа должна быть включена', () => {
    const m = msg({ text: `@${BOT} сделай`, chatId: -100, chatType: 'supergroup' })
    expect(gate(m, { allowFrom: ['111'] }, BOT).ok).toBe(false)
    expect(gate(m, { allowFrom: ['111'], groups: { '-100': {} } }, BOT).ok).toBe(true)
  })

  test('в группе без упоминания — мимо, ответ боту — считается', () => {
    const access = { allowFrom: ['111'], groups: { '-100': { requireMention: true } } }
    expect(gate(msg({ text: 'сделай', chatId: -100, chatType: 'group' }), access, BOT).ok).toBe(false)
    expect(gate(msg({ text: `@${BOT}_other сделай`, chatId: -100, chatType: 'group' }), access, BOT).ok).toBe(false)
    const reply = msg({ text: 'да', chatId: -100, chatType: 'group', reply_to_message: msg({ from: { id: 9, username: BOT } }) })
    expect(gate(reply, access, BOT).ok).toBe(true)
  })

  test('allowFrom группы сужает общий, но не расширяет', () => {
    const access = { allowFrom: ['111', '222'], groups: { '-100': { requireMention: false, allowFrom: ['111', '333'] } } }
    const from = (id: number) => msg({ text: 'x', fromId: id, chatId: -100, chatType: 'group' })
    expect(gate(from(111), access, BOT).ok).toBe(true)
    expect(gate(from(222), access, BOT).ok).toBe(false)
    expect(gate(from(333), access, BOT).ok).toBe(false)
  })
})

describe('callbackAllowed', () => {
  test('кнопки в группе — по тем же правилам', () => {
    const access = { allowFrom: ['111', '222'], groups: { '-100': { allowFrom: ['111'] } } }
    const cb = (id: number, chatId: number, type: string) =>
      ({ id: 'q', from: { id }, message: { message_id: 1, chat: { id: chatId, type } } })
    expect(callbackAllowed(cb(222, 222, 'private'), access)).toBe(true)
    expect(callbackAllowed(cb(111, -100, 'group'), access)).toBe(true)
    expect(callbackAllowed(cb(222, -100, 'group'), access)).toBe(false)
    expect(callbackAllowed(cb(111, -200, 'group'), access)).toBe(false)
  })
})

test('stripMention', () => {
  expect(stripMention(`@${BOT} сделай отчёт`, BOT)).toBe('сделай отчёт')
  expect(stripMention(`/status@${BOT}`, BOT)).toBe('/status')
})
