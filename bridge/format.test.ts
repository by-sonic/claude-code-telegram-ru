import { describe, expect, test } from 'bun:test'

import {
  clip, extractFiles, formatDuration, renderMarkdown, splitMarkdown, splitPlain, TG_TEXT_LIMIT,
} from './format.ts'

/** Telegram отвергает сообщение целиком, если теги перекрываются. */
function expectBalanced(html: string): void {
  const stack: string[] = []
  for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (m[1]) expect(stack.pop()).toBe(m[2])
    else stack.push(m[2])
  }
  expect(stack).toEqual([])
}

describe('splitPlain', () => {
  test('короткий текст — один кусок', () => {
    expect(splitPlain('привет')).toEqual(['привет'])
  })

  test('пустой текст не отправляется пустым', () => {
    expect(splitPlain('   \n ')).toEqual(['(пустой ответ)'])
  })

  test('строка ровно в лимит не порождает пустой кусок', () => {
    const line = 'x'.repeat(TG_TEXT_LIMIT)
    const chunks = splitPlain(`${line}\n${line}`)
    expect(chunks).toEqual([line, line])
  })

  test('режет по строкам и не превышает лимит', () => {
    const text = Array.from({ length: 500 }, (_, i) => `строка номер ${i}`).join('\n')
    const chunks = splitPlain(text, 1000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000)
    expect(chunks.join('\n')).toBe(text)
  })

  test('не рвёт эмодзи пополам', () => {
    const text = '😀'.repeat(3000) // 6000 UTF-16 единиц одной строкой
    for (const c of splitPlain(text)) {
      expect(c.length).toBeLessThanOrEqual(TG_TEXT_LIMIT)
      expect(c).not.toMatch(/[\uD800-\uDBFF]$/)
    }
  })

  test('куски из одних пробелов выбрасываются', () => {
    const text = `${'a'.repeat(100)}\n${'\n'.repeat(50)}\n${'b'.repeat(100)}`
    for (const c of splitPlain(text, 110)) expect(c.trim()).not.toBe('')
  })
})

describe('splitMarkdown', () => {
  test('блок кода на границе закрывается и открывается заново', () => {
    const code = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i}`).join('\n')
    const md = `Вот код:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nГотово.`
    const chunks = splitMarkdown(md, 1000)
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000)
      const fences = c.split('\n').filter(l => l.startsWith('```')).length
      expect(fences % 2).toBe(0)
      expectBalanced(renderMarkdown(c))
    }
    // Каждая строка кода дошла ровно один раз.
    const all = chunks.join('\n')
    expect(all.match(/const x199 = 199/g)?.length).toBe(1)
    expect(all.match(/const x0 = 0/g)?.length).toBe(1)
  })

  test('короткий текст не режется', () => {
    expect(splitMarkdown('**жирный**')).toEqual(['**жирный**'])
  })

  test('пустой текст — пустой список', () => {
    expect(splitMarkdown('  \n  ')).toEqual([])
  })
})

describe('renderMarkdown', () => {
  test('экранирует HTML', () => {
    expect(renderMarkdown('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d')
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('выделения', () => {
    expect(renderMarkdown('**жирный** и *курсив* и ~~нет~~')).toBe('<b>жирный</b> и <i>курсив</i> и <s>нет</s>')
  })

  test('код внутри строки не размечается', () => {
    expect(renderMarkdown('запусти `a **b** <c>`')).toBe('запусти <code>a **b** &lt;c&gt;</code>')
  })

  test('код не оказывается внутри выделения — Bot API такое запрещает', () => {
    expect(renderMarkdown('**Поправил `config.ts` сегодня**'))
      .toBe('<b>Поправил </b><code>config.ts</code><b> сегодня</b>')
    expect(renderMarkdown('**`config.ts`**')).toBe('<code>config.ts</code>')
    expect(renderMarkdown('*см. `x`*')).toBe('<i>см. </i><code>x</code>')
  })

  test('не ломает идентификаторы, пути и арифметику', () => {
    for (const s of ['snake_case_name', '__init__', 'C:\\Users\\my_dir\\_tmp_\\x', '2 * 3 * 4', 'файлы *.ts и *.js', 'a*b*c']) {
      expect(renderMarkdown(s)).toBe(s.replace(/&/g, '&amp;'))
    }
  })

  test('заголовки, списки, задачи, черта', () => {
    expect(renderMarkdown('## Итог')).toBe('<b>Итог</b>')
    expect(renderMarkdown('- пункт\n  * вложенный')).toBe('• пункт\n  • вложенный')
    expect(renderMarkdown('- [ ] сделать\n- [x] готово')).toBe('☐ сделать\n☑ готово')
    expect(renderMarkdown('---')).toBe('———')
  })

  test('блок кода с языком, содержимое экранируется', () => {
    const html = renderMarkdown('```ts\nif (a < b) {}\n```')
    expect(html).toBe('<pre><code class="language-ts">if (a &lt; b) {}</code></pre>')
  })

  test('незакрытый блок кода не ломает разметку', () => {
    const html = renderMarkdown('текст\n```\nкод')
    expect(html).toBe('текст\n<pre>код</pre>')
  })

  test('пустой блок кода пропускается', () => {
    expect(renderMarkdown('```\n```\nтекст')).toBe('текст')
  })

  test('таблица уходит в pre', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toBe('<pre>| a | b |\n|---|---|\n| 1 | 2 |</pre>')
  })

  test('цитата', () => {
    expect(renderMarkdown('> **важно**\n> вторая')).toBe('<blockquote><b>важно</b>\nвторая</blockquote>')
  })

  test('ссылки: http — да, javascript — нет', () => {
    expect(renderMarkdown('[сайт](https://example.com/a?b=1&c="2")'))
      .toBe('<a href="https://example.com/a?b=1&amp;c=&quot;2&quot;">сайт</a>')
    expect(renderMarkdown('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))')
  })

  test('типичный ответ Claude даёт корректно вложенный HTML', () => {
    const md = [
      '## Что сделал',
      '',
      '1. Поправил **`config.ts`** — теперь *таймаут* 30 с',
      '- Запустил `npm test` → **всё зелёное**',
      '- Файл `C:\\proj\\a_b.ts`',
      '',
      '```diff',
      '- old <line>',
      '+ new & line',
      '```',
      '',
      '> Замечание: ~~старый~~ новый путь',
    ].join('\n')
    const html = renderMarkdown(md)
    expectBalanced(html)
    expect(html).toContain('<pre><code class="language-diff">- old &lt;line&gt;\n+ new &amp; line</code></pre>')
  })
})

describe('extractFiles', () => {
  test('без маркера текст не меняется', () => {
    expect(extractFiles('просто ответ')).toEqual({ text: 'просто ответ', files: [] })
  })

  test('обычный блок', () => {
    expect(extractFiles('Готово.\n\n@@FILES@@\nC:\\a\\b.md\nC:\\a\\c.sh\n')).toEqual({
      text: 'Готово.',
      files: ['C:\\a\\b.md', 'C:\\a\\c.sh'],
    })
  })

  test('блок в ограде ``` — как в примере из промпта', () => {
    expect(extractFiles('Готово.\n\n```\n@@FILES@@\nC:\\a\\b.md\n```')).toEqual({
      text: 'Готово.',
      files: ['C:\\a\\b.md'],
    })
  })

  test('закрытый блок кода перед маркером не трогается', () => {
    const r = extractFiles('Код:\n```js\nx()\n```\n@@FILES@@\n/tmp/a.js')
    expect(r.text).toBe('Код:\n```js\nx()\n```')
    expect(r.files).toEqual(['/tmp/a.js'])
  })

  test('маркеры списка, кавычки и обратные апострофы снимаются', () => {
    expect(extractFiles('@@FILES@@\n- `C:\\a b\\c.md`\n* "D:\\x.zip"\n1. ~/r.txt').files)
      .toEqual(['C:\\a b\\c.md', 'D:\\x.zip', '~/r.txt'])
  })

  test('пустые строки между путями не обрывают список', () => {
    expect(extractFiles('@@FILES@@\nC:\\a.md\n\nC:\\b.md').files).toEqual(['C:\\a.md', 'C:\\b.md'])
  })

  test('приписка после блока возвращается в текст', () => {
    expect(extractFiles('Готово.\n@@FILES@@\nC:\\a.md\n\nЕсли что — пиши.')).toEqual({
      text: 'Готово.\n\nЕсли что — пиши.',
      files: ['C:\\a.md'],
    })
  })
})

describe('мелочи', () => {
  test('formatDuration', () => {
    expect(formatDuration(5_000)).toBe('5с')
    expect(formatDuration(90_000)).toBe('1м30с')
    expect(formatDuration(120_000)).toBe('2м')
    expect(formatDuration(3_720_000)).toBe('1ч2м')
  })

  test('clip', () => {
    expect(clip('  a\n\n b  ', 10)).toBe('a b')
    expect(clip('абвгдежзик', 5)).toBe('абвг…')
  })
})
