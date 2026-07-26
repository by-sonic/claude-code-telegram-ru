/**
 * Клиент Bot API — ровно то, что нужно мосту, без зависимостей.
 *
 * Мост владеет соединением с Telegram целиком: он единственный, кто зовёт
 * getUpdates. Официальный плагин канала для этого должен быть выключен —
 * Telegram допускает одного getUpdates-консьюмера на токен, второй получает 409.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'

const TG_TEXT_LIMIT = 4096

export type TgUser = { id: number; first_name?: string; username?: string }
export type TgChat = { id: number; type: string; title?: string }

export type TgMessage = {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  caption?: string
  entities?: Array<{ type: string; offset: number; length: number }>
  reply_to_message?: { from?: TgUser }
  photo?: Array<{ file_id: string; file_unique_id: string; file_size?: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number }
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  video?: { file_id: string; file_name?: string; file_size?: number }
}

export type TgCallbackQuery = {
  id: string
  from: TgUser
  data?: string
  message?: { message_id: number; chat: TgChat }
}

export type TgUpdate = {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  callback_query?: TgCallbackQuery
}

export type InlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

export class Telegram {
  constructor(private token: string, private inboxDir: string) {}

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
    })
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string }
    if (!body.ok) throw new Error(`${method}: ${body.description ?? res.status}`)
    return body.result as T
  }

  /** Long poll. Возвращает пустой массив по таймауту — это норма, не ошибка. */
  async getUpdates(offset: number, timeoutSec = 30): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSec,
      // callback_query обязателен: без него нажатия инлайн-кнопок Telegram не пришлёт,
      // и кнопка «Отменить» будет молча ничего не делать.
      allowed_updates: ['message', 'edited_message', 'callback_query'],
    })
  }

  async getMe(): Promise<TgUser & { username: string }> {
    return this.call('getMe')
  }

  /**
   * Отправка с автонарезкой: Telegram жёстко отклоняет всё длиннее 4096.
   * Режем по границам строк, чтобы не рвать код и списки посреди символа.
   * Возвращает id всех отправленных сообщений.
   */
  async send(
    chatId: number | string, text: string, replyTo?: number, keyboard?: InlineKeyboard,
  ): Promise<number[]> {
    const chunks = splitForTelegram(text)
    const ids: number[] = []
    for (const [i, chunk] of chunks.entries()) {
      const msg = await this.call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: chunk,
        // Тред только на первом куске: иначе каждый кусок цитирует исходник и чат превращается в кашу.
        ...(replyTo && i === 0 ? { reply_parameters: { message_id: replyTo } } : {}),
        // Кнопки — тоже только на первом: на остальных они бессмысленно дублируются.
        ...(keyboard && i === 0 ? { reply_markup: keyboard } : {}),
        link_preview_options: { is_disabled: true },
      })
      ids.push(msg.message_id)
    }
    return ids
  }

  /**
   * Правка текста. keyboard === null снимает кнопки — это нужно, чтобы после
   * завершения задачи «Отменить» нельзя было нажать повторно.
   */
  async edit(
    chatId: number | string, messageId: number, text: string, keyboard?: InlineKeyboard | null,
  ): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, TG_TEXT_LIMIT),
        ...(keyboard === null ? { reply_markup: { inline_keyboard: [] } } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
        link_preview_options: { is_disabled: true },
      })
    } catch (err) {
      // Telegram отклоняет правку, если текст не изменился — это ожидаемо и безобидно.
      const msg = String(err)
      if (!msg.includes('message is not modified')) throw err
    }
  }

  /**
   * Отправляет файл документом.
   *
   * Именно документом, а не фото: документ сохраняет исходный файл байт-в-байт,
   * и его можно переслать дальше как есть. Фото Telegram пережимает, а для .md,
   * .sh и архивов это вообще не вариант.
   *
   * Лимит на выгрузку у ботов — 50 МБ.
   */
  async sendDocument(chatId: number | string, filePath: string, caption?: string): Promise<number> {
    const bytes = readFileSync(filePath)
    const form = new FormData()
    form.append('chat_id', String(chatId))
    if (caption) form.append('caption', caption.slice(0, 1024))
    // Content-Type и boundary выставляет сам fetch — руками их задавать нельзя.
    form.append('document', new Blob([bytes]), basename(filePath))

    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, {
      method: 'POST',
      body: form,
    })
    const body = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string }
    if (!body.ok) throw new Error(`sendDocument: ${body.description ?? res.status}`)
    return body.result!.message_id
  }

  /**
   * Обязательный ответ на нажатие кнопки. Без него Telegram держит на кнопке
   * крутилку до таймаута, и кажется, будто нажатие не сработало.
   */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    try {
      await this.call('answerCallbackQuery', {
        callback_query_id: callbackId,
        ...(text ? { text, show_alert: false } : {}),
      })
    } catch {}
  }

  /** Реакция-подтверждение. Telegram принимает только свой фиксированный набор эмодзи. */
  async react(chatId: number | string, messageId: number, emoji: string): Promise<void> {
    try {
      await this.call('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
      })
    } catch {
      // Эмодзи вне разрешённого Telegram набора или сообщение слишком старое — не повод падать.
    }
  }

  async typing(chatId: number | string): Promise<void> {
    try {
      await this.call('sendChatAction', { chat_id: chatId, action: 'typing' })
    } catch {}
  }

  /**
   * Скачивает вложение в inbox и возвращает локальный путь.
   * Боты ограничены 20 МБ на скачивание — это лимит Bot API, не наш.
   */
  async download(fileId: string, hint = 'file'): Promise<string> {
    const file = await this.call<{ file_path?: string; file_unique_id?: string }>('getFile', {
      file_id: fileId,
    })
    if (!file.file_path) throw new Error('Telegram не отдал file_path — файл мог истечь')

    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`)
    if (!res.ok) throw new Error(`скачивание не удалось: HTTP ${res.status}`)

    const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin'
    // Имя файла контролирует отправитель — оставляем только безопасные символы,
    // иначе оно попадёт в промпт и в путь на диске.
    const safeHint = hint.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'file'

    mkdirSync(this.inboxDir, { recursive: true })
    const path = join(this.inboxDir, `${Date.now()}-${safeHint}.${ext}`)
    writeFileSync(path, Buffer.from(await res.arrayBuffer()))
    return path
  }
}

/** Нарезка по строкам с жёстким фолбэком: одна строка тоже может быть длиннее лимита. */
export function splitForTelegram(text: string, limit = TG_TEXT_LIMIT): string[] {
  const clean = text.trim() || '(пустой ответ)'
  if (clean.length <= limit) return [clean]

  const chunks: string[] = []
  let current = ''
  for (const line of clean.split('\n')) {
    if (line.length > limit) {
      if (current) { chunks.push(current); current = '' }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit))
      continue
    }
    if ((current + '\n' + line).length > limit) {
      chunks.push(current)
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  if (current) chunks.push(current)
  return chunks
}
