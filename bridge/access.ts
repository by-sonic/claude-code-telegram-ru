/**
 * Кому можно ставить задачи. Гейт всегда по личности отправителя (from.id),
 * никогда по чату: в группе это разные вещи, и гейт по чату пустил бы задачи
 * от любого её участника.
 *
 * Правило для групп: отправитель должен быть в общем allowFrom И (если он задан)
 * в allowFrom группы. Групповой список только сужает общий, но не расширяет его.
 */

import type { Access } from './config.ts'
import type { TgCallbackQuery, TgMessage } from './telegram.ts'

/** ID в конфиге бывают и строкой, и числом — сравниваем как строки. */
export function isAllowed(list: Array<string | number> | undefined, userId: number | string): boolean {
  const id = String(userId).trim()
  return (list ?? []).some(entry => String(entry).trim() === id)
}

export function mentionPattern(botUsername: string): RegExp {
  return new RegExp(`@${botUsername}\\b`, 'gi')
}

/** Убирает упоминание бота — оно адресация, а не часть задачи. */
export function stripMention(text: string, botUsername: string): string {
  return text.replace(mentionPattern(botUsername), '').trim()
}

function addressedToBot(msg: TgMessage, botUsername: string): boolean {
  const text = msg.text ?? msg.caption ?? ''
  if (mentionPattern(botUsername).test(text)) return true
  return msg.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase()
}

export function gate(msg: TgMessage, access: Access, botUsername: string): { ok: boolean; why?: string } {
  const senderId = msg.from?.id
  if (!senderId) return { ok: false, why: 'нет отправителя' }
  if (!isAllowed(access.allowFrom, senderId)) return { ok: false, why: `отправитель ${senderId} не в allowFrom` }

  if (msg.chat.type === 'private') return { ok: true }

  const group = access.groups?.[String(msg.chat.id)]
  if (!group) return { ok: false, why: `группа ${msg.chat.id} не включена в access.json` }
  if (group.allowFrom?.length && !isAllowed(group.allowFrom, senderId)) {
    return { ok: false, why: `${senderId} не в allowFrom группы ${msg.chat.id}` }
  }
  if (group.requireMention !== false && !addressedToBot(msg, botUsername)) {
    return { ok: false, why: 'в группе нужно упоминание или ответ на сообщение бота' }
  }
  return { ok: true }
}

/**
 * Нажатие инлайн-кнопки гейтится так же строго, как сообщения: иначе любой
 * участник группы смог бы отменять чужие задачи.
 */
export function callbackAllowed(cb: TgCallbackQuery, access: Access): boolean {
  if (!isAllowed(access.allowFrom, cb.from.id)) return false
  const chat = cb.message?.chat
  if (!chat || chat.type === 'private') return true
  const group = access.groups?.[String(chat.id)]
  if (!group) return false
  return !group.allowFrom?.length || isAllowed(group.allowFrom, cb.from.id)
}
