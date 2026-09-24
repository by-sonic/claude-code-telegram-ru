/**
 * Клиент Bot API — ровно то, что нужно мосту, без зависимостей.
 *
 * Мост владеет соединением с Telegram целиком: он единственный, кто зовёт
 * getUpdates. Официальный плагин канала для этого должен быть выключен —
 * Telegram допускает одного getUpdates-консьюмера на токен, второй получает 409.
 *
 * Надёжность здесь важнее краткости: владелец в дороге, и любая сетевая икота,
 * которая роняет мост или теряет ответ, для него выглядит как «бот сломался».
 * Поэтому у каждого запроса есть таймаут, а важные отправки повторяются.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'

import { renderMarkdown, splitMarkdown, splitPlain, TG_TEXT_LIMIT } from './format.ts'

/** Лимит Bot API на скачивание файлов ботом. */
export const DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024

export type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
export type TgChat = { id: number; type: string; title?: string; username?: string }

type TgFile = { file_id: string; file_unique_id?: string; file_size?: number }

export type TgMessageOrigin =
  | { type: 'user'; sender_user: TgUser }
  | { type: 'hidden_user'; sender_user_name: string }
  | { type: 'chat'; sender_chat: TgChat }
  | { type: 'channel'; chat: TgChat }

export type TgMessage = {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  media_group_id?: string
  forward_origin?: TgMessageOrigin
  text?: string
  caption?: string
  reply_to_message?: TgMessage
  /** Фрагмент, который пользователь выделил, отвечая на сообщение. */
  quote?: { text: string }
  photo?: Array<TgFile & { width?: number; height?: number }>
  document?: TgFile & { file_name?: string; mime_type?: string }
  voice?: TgFile & { duration?: number; mime_type?: string }
  audio?: TgFile & { duration?: number; file_name?: string; mime_type?: string }
  video?: TgFile & { file_name?: string; mime_type?: string }
  /** «Кружочек» — видеосообщение. Для моста это то же голосовое, только с картинкой. */
  video_note?: TgFile & { duration?: number }
  animation?: TgFile & { file_name?: string }
  sticker?: TgFile & { emoji?: string }
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

export type InlineButton = { text: string; callback_data: string }
export type InlineKeyboard = { inline_keyboard: InlineButton[][] }

/** Ошибка, которую вернул сам Telegram. code — error_code (400, 403, 409, 429…). */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`${method}: ${description}`)
    this.name = 'TelegramError'
  }
}

/** До Telegram не достучались: нет сети, таймаут, обрыв соединения. */
export class NetworkError extends Error {
  constructor(readonly method: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`${method}: нет связи с Telegram (${reason})`)
    this.name = 'NetworkError'
  }
}

type CallOptions = {
  timeoutMs?: number
  /** Сколько раз повторить при 429, 5xx и сетевых ошибках. По умолчанию — ни разу. */
  retries?: number
  signal?: AbortSignal
}

export type SendOptions = {
  replyTo?: number
  keyboard?: InlineKeyboard
  retries?: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function isRetryable(err: unknown): boolean {
  if (err instanceof NetworkError) return true
  if (err instanceof TelegramError) return err.code === 429 || err.code >= 500
  return false
}

/**
 * Сигнал, который срабатывает по таймауту или по внешней отмене. Не полагаемся на
 * AbortSignal.any: в старых версиях Bun его нет, а мост не должен требовать свежий рантайм.
 */
function timeoutSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(`таймаут ${Math.round(ms / 1000)} с`)), ms)
  const onOuter = () => ctrl.abort(outer?.reason)
  if (outer?.aborted) ctrl.abort(outer.reason)
  else outer?.addEventListener('abort', onOuter, { once: true })
  return {
    signal: ctrl.signal,
    dispose: () => { clearTimeout(timer); outer?.removeEventListener('abort', onOuter) },
  }
}

function replyParams(replyTo?: number): Record<string, unknown> {
  // allow_sending_without_reply: если владелец успел удалить своё сообщение,
  // ответ всё равно должен дойти, а не упасть с «message to be replied not found».
  return replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}
}

export class Telegram {
  private readonly base: string
  private readonly fileBase: string

  constructor(token: string, private readonly inboxDir: string, apiUrl = 'https://api.telegram.org') {
    const root = apiUrl.replace(/\/+$/, '')
    this.base = `${root}/bot${token}`
    this.fileBase = `${root}/file/bot${token}`
  }

  private async once<T>(method: string, init: RequestInit, opts: CallOptions): Promise<T> {
    const { signal, dispose } = timeoutSignal(opts.timeoutMs ?? 30_000, opts.signal)
    try {
      let res: Response
      let raw: string
      try {
        res = await fetch(`${this.base}/${method}`, { ...init, signal })
        raw = await res.text()
      } catch (err) {
        if (opts.signal?.aborted) throw err
        throw new NetworkError(method, err)
      }
      let body: { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }
      try {
        body = JSON.parse(raw)
      } catch {
        // Не JSON — значит ответил не Telegram, а прокси или балансировщик (502, страница блокировки).
        throw new TelegramError(method, res.status, `HTTP ${res.status}, ответ не от Bot API: ${raw.slice(0, 120)}`)
      }
      if (!body.ok) {
        throw new TelegramError(
          method, body.error_code ?? res.status, body.description ?? `HTTP ${res.status}`, body.parameters?.retry_after,
        )
      }
      return body.result as T
    } finally {
      dispose()
    }
  }

  private async request<T>(method: string, init: () => RequestInit, opts: CallOptions = {}): Promise<T> {
    const retries = opts.retries ?? 0
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, init(), opts)
      } catch (err) {
        if (attempt >= retries || !isRetryable(err) || opts.signal?.aborted) throw err
        const hinted = err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : 0
        await sleep(Math.min(hinted || 1000 * 2 ** attempt, 60_000))
      }
    }
  }

  private call<T>(method: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    return this.request<T>(method, () => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }), opts)
  }

  /**
   * Long poll. Возвращает пустой массив по таймауту — это норма, не ошибка.
   *
   * Свой таймаут на HTTP-запрос обязателен: после сна или смены сети соединение
   * умирает молча, и fetch без таймаута ждал бы ответа вечно — бот просто замолкал.
   */
  getUpdates(offset: number, timeoutSec = 30): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSec,
      // callback_query обязателен: без него нажатия инлайн-кнопок Telegram не пришлёт,
      // и кнопка «Отменить» будет молча ничего не делать.
      allowed_updates: ['message', 'edited_message', 'callback_query'],
    }, { timeoutMs: (timeoutSec + 15) * 1000 })
  }

  getMe(): Promise<TgUser & { username: string }> {
    return this.call('getMe', {}, { timeoutMs: 15_000 })
  }

  /** Меню команд в клиенте Telegram (кнопка «/» у поля ввода). */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    try { await this.call('setMyCommands', { commands }) } catch {}
  }

  private async sendOne(
    chatId: number | string, text: string, extra: Record<string, unknown>, retries: number,
  ): Promise<number> {
    const msg = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...extra,
    }, { retries })
    return msg.message_id
  }

  /**
   * Простой текст с автонарезкой: Telegram жёстко отклоняет всё длиннее 4096.
   * Тред — только у первого куска (иначе каждый цитирует исходник), кнопки —
   * только у последнего (под ответом, а не посреди него).
   */
  async send(chatId: number | string, text: string, opts: SendOptions = {}): Promise<number[]> {
    const chunks = splitPlain(text)
    const ids: number[] = []
    for (const [i, chunk] of chunks.entries()) {
      ids.push(await this.sendOne(chatId, chunk, {
        ...(i === 0 ? replyParams(opts.replyTo) : {}),
        ...(opts.keyboard && i === chunks.length - 1 ? { reply_markup: opts.keyboard } : {}),
      }, opts.retries ?? 3))
    }
    return ids
  }

  /**
   * Короткое сообщение в HTML. Если Telegram не принял разметку — отправляет
   * plain-вариант: сообщение важнее форматирования.
   */
  async sendHtml(chatId: number | string, html: string, plain: string, opts: SendOptions = {}): Promise<number> {
    const extra = { ...replyParams(opts.replyTo), ...(opts.keyboard ? { reply_markup: opts.keyboard } : {}) }
    try {
      // Лимит 4096 Telegram считает после разбора разметки, поэтому длину HTML не проверяем.
      return await this.sendOne(chatId, html, { ...extra, parse_mode: 'HTML' }, opts.retries ?? 3)
    } catch (err) {
      if (!(err instanceof TelegramError) || err.code !== 400) throw err
    }
    return this.sendOne(chatId, plain.slice(0, TG_TEXT_LIMIT), extra, opts.retries ?? 3)
  }

  /**
   * Ответ Claude: markdown переводится в HTML Telegram. Кусок, чью разметку
   * Telegram не принял, уходит как есть простым текстом — ответ не теряется.
   */
  async sendMarkdown(chatId: number | string, md: string, opts: SendOptions = {}): Promise<number[]> {
    const chunks = splitMarkdown(md)
    if (!chunks.length) return this.send(chatId, '(пустой ответ)', opts)
    const ids: number[] = []
    for (const [i, chunk] of chunks.entries()) {
      ids.push(await this.sendHtml(chatId, renderMarkdown(chunk), chunk, {
        replyTo: i === 0 ? opts.replyTo : undefined,
        keyboard: i === chunks.length - 1 ? opts.keyboard : undefined,
        retries: opts.retries,
      }))
    }
    return ids
  }

  /**
   * Правка текста. keyboard === null снимает кнопки — чтобы после завершения
   * задачи «Отменить» нельзя было нажать повторно.
   *
   * Никогда не бросает: правка статуса косметическая, и её сбой (сообщение удалили,
   * слишком старое, 429) не должен превращать выполненную задачу в «упала».
   */
  async edit(
    chatId: number | string, messageId: number, text: string,
    keyboard?: InlineKeyboard | null, opts: { retries?: number; html?: boolean } = {},
  ): Promise<boolean> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, TG_TEXT_LIMIT),
        ...(opts.html ? { parse_mode: 'HTML' } : {}),
        ...(keyboard === null ? { reply_markup: { inline_keyboard: [] } } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
        link_preview_options: { is_disabled: true },
      }, { retries: opts.retries ?? 0 })
      return true
    } catch (err) {
      // «message is not modified» — текст не изменился, это безобидно.
      return err instanceof TelegramError && err.description.includes('message is not modified')
    }
  }

  /** Снимает кнопки, не трогая текст. */
  async clearButtons(chatId: number | string, messageId: number): Promise<void> {
    try {
      await this.call('editMessageReplyMarkup', {
        chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
      })
    } catch {}
  }

  /**
   * Отправляет файл документом.
   *
   * Именно документом, а не фото: документ сохраняет исходный файл байт-в-байт,
   * и его можно переслать дальше как есть. Фото Telegram пережимает, а для .md,
   * .sh и архивов это вообще не вариант. Лимит на выгрузку у ботов — 50 МБ.
   */
  async sendDocument(chatId: number | string, filePath: string, caption?: string): Promise<number> {
    const msg = await this.request<{ message_id: number }>('sendDocument', () => {
      const form = new FormData()
      form.append('chat_id', String(chatId))
      if (caption) form.append('caption', caption.slice(0, 1024))
      // Content-Type и boundary выставляет сам fetch — руками их задавать нельзя.
      form.append('document', new Blob([readFileSync(filePath)]), basename(filePath))
      return { method: 'POST', body: form }
    }, { timeoutMs: 10 * 60_000, retries: 2 })
    return msg.message_id
  }

  /**
   * Обязательный ответ на нажатие кнопки. Без него Telegram держит на кнопке
   * крутилку до таймаута, и кажется, будто нажатие не сработало.
   */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    try {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) })
    } catch {}
  }

  /** Реакция-подтверждение. Telegram принимает только свой фиксированный набор эмодзи. */
  async react(chatId: number | string, messageId: number, emoji: string): Promise<void> {
    try {
      await this.call('setMessageReaction', {
        chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }],
      })
    } catch {
      // Эмодзи вне разрешённого набора или сообщение слишком старое — не повод падать.
    }
  }

  async typing(chatId: number | string): Promise<void> {
    try { await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }, { timeoutMs: 10_000 }) } catch {}
  }

  /**
   * Скачивает вложение в inbox и возвращает локальный путь.
   * Боты ограничены 20 МБ на скачивание — это лимит Bot API, не наш.
   */
  async download(file: { file_id: string; file_size?: number }, hint: string, signal?: AbortSignal): Promise<string> {
    if (file.file_size && file.file_size > DOWNLOAD_LIMIT_BYTES) {
      throw new Error(
        `файл ${(file.file_size / 1024 / 1024).toFixed(1)} МБ — ботам Telegram отдаёт только до 20 МБ. ` +
        'Положи его на компьютер или в облако и пришли путь или ссылку.',
      )
    }
    let meta: { file_path?: string }
    try {
      meta = await this.call<{ file_path?: string }>('getFile', { file_id: file.file_id }, { retries: 2, signal })
    } catch (err) {
      if (err instanceof TelegramError && /too big/i.test(err.description)) {
        throw new Error('файл больше 20 МБ — ботам Telegram такие не отдаёт. Положи его на компьютер и пришли путь.')
      }
      throw err
    }
    if (!meta.file_path) throw new Error('Telegram не отдал file_path — файл мог истечь')

    const { signal: dl, dispose } = timeoutSignal(5 * 60_000, signal)
    let bytes: ArrayBuffer
    try {
      const res = await fetch(`${this.fileBase}/${meta.file_path}`, { signal: dl })
      if (!res.ok) throw new Error(`скачивание не удалось: HTTP ${res.status}`)
      bytes = await res.arrayBuffer()
    } finally {
      dispose()
    }

    const rawExt = meta.file_path.includes('.') ? meta.file_path.split('.').pop()! : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin'
    // Имя файла контролирует отправитель — оставляем буквы (включая кириллицу),
    // цифры и ._- : оно попадёт в промпт и в путь на диске. Точки по краям срезаем —
    // Windows молча отбрасывает завершающие точки, и путь разошёлся бы с файлом.
    const safe = hint.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 60) || 'file'
    const name = safe.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? safe : `${safe}.${ext}`

    mkdirSync(this.inboxDir, { recursive: true })
    const path = join(this.inboxDir, `${Date.now()}-${name}`)
    writeFileSync(path, Buffer.from(bytes))
    return path
  }
}
