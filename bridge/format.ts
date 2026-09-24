/**
 * Текстовые преобразования для Telegram — без сети и без состояния, чтобы их
 * можно было проверить тестами.
 *
 * Ответы Claude приходят в markdown. Telegram его не понимает, а сырые ```,
 * ** и # на телефоне читаются плохо, поэтому ответ переводится в HTML-подмножество
 * Telegram. Перевод намеренно консервативный: если Telegram всё же отвергнет
 * разметку, мост отправит тот же кусок простым текстом (см. telegram.ts).
 */

export const TG_TEXT_LIMIT = 4096

/**
 * Лимит на кусок markdown. Меньше 4096 с запасом: при переносе через границу
 * куска открытый блок кода закрывается и открывается заново, это пара строк.
 */
export const MD_CHUNK_LIMIT = 3800

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/** Схлопывает пробелы и обрезает с многоточием — для строк прогресса и подсказок. */
export function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}с`
  const min = Math.floor(total / 60)
  const sec = total % 60
  if (min < 60) return sec ? `${min}м${sec}с` : `${min}м`
  const h = Math.floor(min / 60)
  return `${h}ч${min % 60}м`
}

/** Режет строку на куски не длиннее limit, не разрывая суррогатные пары (эмодзи). */
function chunkString(s: string, limit: number): string[] {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    let end = Math.min(i + limit, s.length)
    const code = s.charCodeAt(end - 1)
    if (end < s.length && code >= 0xd800 && code <= 0xdbff) end--
    out.push(s.slice(i, end))
    i = end
  }
  return out
}

/**
 * Нарезка простого текста по границам строк с жёстким фолбэком: одна строка
 * тоже может быть длиннее лимита. Пустых кусков не бывает — Telegram отвергает
 * пустое сообщение, и ответ потерялся бы целиком.
 */
export function splitPlain(text: string, limit = TG_TEXT_LIMIT): string[] {
  const clean = text.trim() || '(пустой ответ)'
  if (clean.length <= limit) return [clean]

  const chunks: string[] = []
  let current = ''
  for (const line of clean.split('\n')) {
    if (line.length > limit) {
      if (current) { chunks.push(current); current = '' }
      chunks.push(...chunkString(line, limit))
      continue
    }
    if (current && current.length + 1 + line.length > limit) {
      chunks.push(current)
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  if (current) chunks.push(current)
  return chunks.filter(c => c.trim())
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/

function isFenceClose(line: string, open: string): boolean {
  const ch = open[0] === '`' ? '`' : '~'
  return new RegExp(`^\\s{0,3}\\${ch}{${open.length},}\\s*$`).test(line)
}

/**
 * Нарезка markdown на куски для отдельных сообщений. Если граница попала внутрь
 * блока кода, блок закрывается в конце куска и открывается заново в начале
 * следующего — иначе половина кода отрисовалась бы обычным текстом.
 */
export function splitMarkdown(md: string, limit = MD_CHUNK_LIMIT): string[] {
  const text = md.replace(/\r\n?/g, '\n').trim()
  if (!text) return []
  if (text.length <= limit) return [text]

  const budget = limit - 16 // место под закрывающую ограду
  const chunks: string[] = []
  let cur: string[] = []
  let curLen = 0
  let fence: { line: string; marker: string } | null = null

  const flush = () => {
    if (!cur.length) return
    if (fence) cur.push(fence.marker)
    chunks.push(cur.join('\n'))
    cur = fence ? [fence.line] : []
    curLen = fence ? fence.line.length + 1 : 0
  }

  for (const raw of text.split('\n')) {
    const closing = fence !== null && isFenceClose(raw, fence.marker)
    const pieces = raw.length > budget - 64 ? chunkString(raw, budget - 64) : [raw]
    for (const piece of pieces) {
      // Закрывающую ограду не отрываем от её блока: иначе следующий кусок начался
      // бы с пустого блока кода. Под неё и зарезервирован budget.
      if (!closing && cur.length && curLen + piece.length + 1 > budget) flush()
      cur.push(piece)
      curLen += piece.length + 1
    }
    if (fence) {
      if (closing) fence = null
    } else {
      const m = raw.match(FENCE_OPEN)
      if (m) fence = { line: raw.trim(), marker: m[1] }
    }
  }
  if (cur.length) chunks.push(cur.join('\n'))
  return chunks.filter(c => c.trim())
}

const CODE_SLOT = /(\d+)/

/**
 * Оборачивает текст в тег выделения, обходя вставки кода: по правилам Bot API
 * code не может лежать внутри bold/italic/strike, а «**`файл.ts`**» Claude пишет
 * постоянно. Поэтому <b>a <code>x</code></b> превращается в <b>a </b><code>x</code>.
 */
function wrapAroundCode(tag: string, inner: string): string {
  return inner
    .split(CODE_SLOT)
    .map(part => (CODE_SLOT.test(part) || !part ? part : `<${tag}>${part}</${tag}>`))
    .join('')
}

/** Строчные элементы: код, ссылки, жирный, курсив, зачёркнутый. */
function renderInline(text: string): string {
  // Код и ссылки прячем в слоты до экранирования и разбора выделений: внутри кода
  // звёздочки — это код, а не курсив, а URL нельзя трогать вообще.
  const slots: string[] = []
  const keepCode = (code: string) => `${slots.push(`<code>${escapeHtml(code)}</code>`) - 1}`
  const keepLink = (html: string) => `${slots.push(html) - 1}`

  let s = text
  s = s.replace(/``(.+?)``/g, (_, code: string) => keepCode(code.trim()))
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => keepCode(code))
  s = s.replace(
    /\[([^\]\n]+)\]\(\s*((?:https?|tg):\/\/[^\s)]+|mailto:[^\s)]+)\s*\)/g,
    (_, label: string, url: string) => keepLink(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`),
  )

  s = escapeHtml(s)
  s = s.replace(/\*\*(?=\S)(.*?\S)\*\*/g, (_, inner: string) => wrapAroundCode('b', inner))
  // Курсив только звёздочками: подчёркивания живут в snake_case и путях к файлам,
  // и _так_ размечать их опаснее, чем пропустить редкий курсив.
  s = s.replace(
    /(^|[^\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g,
    (_, lead: string, inner: string) => lead + wrapAroundCode('i', inner),
  )
  s = s.replace(/~~(?=\S)(.*?\S)~~/g, (_, inner: string) => wrapAroundCode('s', inner))
  return s.replace(/[](\d+)[]/g, (_, n: string) => slots[Number(n)])
}

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function renderLine(line: string): string {
  const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/)
  if (heading) return `<b>${renderInline(heading[1])}</b>`

  // Горизонтальная черта раньше списков: «* * *» иначе стал бы пунктом списка.
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return '———'

  const item = line.match(/^(\s*)[-*+]\s+(.*)$/)
  if (item) {
    const task = item[2].match(/^\[([ xX])\]\s+(.*)$/)
    if (task) return `${item[1]}${task[1] === ' ' ? '☐' : '☑'} ${renderInline(task[2])}`
    return `${item[1]}• ${renderInline(item[2])}`
  }
  return renderInline(line)
}

/**
 * Markdown → HTML-подмножество Telegram (b, i, s, code, pre, a, blockquote).
 *
 * Разбор построчный: выделения внутри одной строки, блоки кода, цитаты и таблицы —
 * целиком. Таблицы уходят в <pre>: моноширинный шрифт сохраняет колонки,
 * пропорциональный превращает их в кашу.
 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(FENCE_OPEN)
    if (fence) {
      const lang = (fence[2] ?? '').replace(/[^\w+#-]/g, '').slice(0, 24)
      const body: string[] = []
      i++
      while (i < lines.length && !isFenceClose(lines[i], fence[1])) body.push(lines[i++])
      i++ // закрывающая ограда (или конец текста, если блок не закрыт)
      const code = escapeHtml(body.join('\n'))
      // Пустой <pre> Telegram считает пустой сущностью — просто пропускаем блок.
      if (code.trim()) {
        out.push(lang ? `<pre><code class="language-${lang}">${code}</code></pre>` : `<pre>${code}</pre>`)
      }
      continue
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const rows: string[] = []
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(lines[i++].trim())
      out.push(`<pre>${escapeHtml(rows.join('\n'))}</pre>`)
      continue
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ''))
      }
      const body = quoted.map(renderInline).join('\n')
      if (body.trim()) out.push(`<blockquote>${body}</blockquote>`)
      continue
    }

    out.push(renderLine(line))
    i++
  }
  return out.join('\n').trim()
}

/**
 * Маркер, которым Claude перечисляет файлы для отправки в чат. Явная конвенция,
 * а не выковыривание путей из текста: пути упоминаются в ответах постоянно, и
 * угадывание превращалось бы в рассылку случайных файлов.
 */
export const FILES_MARKER = '@@FILES@@'

function cleanPathLine(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/^[`'"«]+|[`'"»]+$/g, '')
    .trim()
}

/** Абсолютный путь (C:\, \\сервер, /, ~/) или имя файла с расширением без пробелов. */
function looksLikePath(line: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/])/.test(line) || /^[^\s]+\.[\p{L}\p{N}]{1,10}$/u.test(line)
}

/**
 * Отрезает от ответа блок с путями файлов.
 *
 * Claude нередко повторяет пример из промпта буквально — вместе с оградой ```
 * вокруг блока. Без обработки ограда уезжала в список файлов («не найден: `»),
 * а в тексте ответа оставалась висящая открывающая ```. Текст, который Claude
 * всё-таки дописал после блока, возвращаем в ответ, а не считаем путями.
 */
export function extractFiles(text: string): { text: string; files: string[] } {
  const idx = text.lastIndexOf(FILES_MARKER)
  if (idx === -1) return { text, files: [] }

  let before = text.slice(0, idx).trimEnd()
  const fenceLines = before.split('\n').filter(l => /^\s{0,3}(`{3,}|~{3,})/.test(l)).length
  // Нечётное число оград значит, что последняя — открывающая, то есть обёртка блока.
  if (fenceLines % 2 === 1) before = before.replace(/\n?[ \t]*(`{3,}|~{3,})[^\n]*$/, '').trimEnd()

  const lines = text.slice(idx + FILES_MARKER.length).split('\n')
  const files: string[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const line = cleanPathLine(lines[i])
    if (!line || /^(`{3,}|~{3,})/.test(line)) continue
    // Первая строка, не похожая на путь, — это уже приписка после блока.
    if (!looksLikePath(line)) break
    files.push(line)
  }

  const after = lines.slice(i).join('\n').trim()
  if (after) before = before ? `${before}\n\n${after}` : after
  return { text: before, files }
}
