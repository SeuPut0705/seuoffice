import { describe, expect, it, vi } from 'vitest'
import { useRoundTripEditor } from './helpers/roundtrip-editor'
import { serializeDocText } from '../src/renderer/markdown/docText'
import {
  roundTripMarkdownEnabled,
  serializeMarkdown,
} from '../src/renderer/markdown/roundtripSerializer'

const open = useRoundTripEditor()

describe('opt-in Markdown round trips', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(roundTripMarkdownEnabled()).toBe(false)
    localStorage.setItem('mdapp.experimentalRoundTrip', 'true')
    expect(roundTripMarkdownEnabled()).toBe(false)
    localStorage.setItem('mdapp.experimentalRoundTrip', '1')
    expect(roundTripMarkdownEnabled()).toBe(true)
  })

  it('defaults off when browser storage is unavailable', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    expect(roundTripMarkdownEnabled()).toBe(false)
    read.mockRestore()
  })

  it.each(['eol', 'trailingNewline', 'bom'] as const)(
    'does not reuse source after changing %s',
    (key) => {
      const { editor, envelope, save } = open('Title\n=====\n')
      if (key === 'eol') envelope.eol = '\r\n'
      else envelope[key] = !envelope[key]
      expect(save()).toBe(serializeDocText(envelope, editor.getMarkdown()))
    },
  )

  it.each([
    '',
    '\uFEFF---\r\ntitle: Sample\r\n---\r\n\r\nTitle\r\n=====\r\n\r\n* item  \r\n',
    '# Mixed\r\n\nA  B\n\n\n',
    '**`inline code`** and [`link`](https://example.com)\n',
    '<details>\n<summary>Notes</summary>\n\nBody\n</details>\n\nText[^a]\n\n[^a]: Footnote\n',
    ':::callout {type="info"}\nBody\n:::\n',
  ])('preserves unedited source %j without reserializing the body', (source) => {
    const { save, body } = open(source)
    expect(Buffer.from(save())).toEqual(Buffer.from(source))
    expect(body).not.toHaveBeenCalled()
  })

  it('keeps the legacy serializer when no source snapshot is supplied', () => {
    const { editor, envelope, body } = open('Title\n=====\n')
    expect(serializeMarkdown(envelope, editor.state.doc, body)).toBe(
      serializeDocText(envelope, editor.getMarkdown()),
    )
    expect(body).toHaveBeenCalledOnce()
  })

  it('saves real edits and preserves original bytes again after undo', () => {
    const source = 'Title\n=====\n\nA paragraph.\n'
    const { editor, envelope, body, save } = open(source)
    editor.commands.insertContentAt(2, ' edited')
    expect(save()).toBe(serializeDocText(envelope, editor.getMarkdown()))
    expect(save()).toContain('edited')
    expect(body).toHaveBeenCalled()
    expect(editor.commands.undo()).toBe(true)
    expect(save()).toBe(source)
  })

  it('does not restore stale frontmatter when metadata is changed', () => {
    const { editor, envelope, save } = open('---\na: 1\n---\n\nBody\n')
    envelope.frontmatter = '---\na: 2\n---\n\n'
    expect(save()).toBe(serializeDocText(envelope, editor.getMarkdown()))
    expect(save()).toContain('a: 2')
  })

  it('does not reuse source after image paths are rewritten during Save As', () => {
    const { editor, save } = open('![sample](assets/old.png)\n')
    editor.commands.command(({ tr }) => {
      tr.setNodeMarkup(1, undefined, { src: 'assets/new.png', alt: 'sample' })
      return true
    })
    expect(save()).toContain('assets/new.png')
    expect(save()).not.toContain('assets/old.png')
  })
})
