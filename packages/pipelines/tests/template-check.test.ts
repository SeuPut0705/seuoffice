/**
 * The template validator: one template in, a list of problems out. The base
 * fixture is valid; every case below breaks exactly one rule of it.
 */
import { describe, expect, it } from 'vitest'
import type { PageSpec } from '../src/slides/page-spec'
import {
  SLIDE_TEMPLATE_BANNED_WORDS,
  validateSlideTemplate,
  type TemplateProblem,
} from '../src/slides/template-check'
import {
  listSlideTemplates,
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  SLIDE_TEMPLATE_STYLE_MAX_CHARS,
  type SlideTemplate,
} from '../src/slides/templates/index'

const run = (text: string, sizePt: number, font = 'Pretendard') => ({
  text,
  sizePt,
  color: '#1A1A1A',
  font,
})

const cover = (title: string, subtitle: string): PageSpec => ({
  background: '#F5F0E8',
  elements: [
    { type: 'shape', shape: 'rect', x: 0, y: 0, w: 1280, h: 200, fill: '#E85D5D' },
    { type: 'text', x: 80, y: 280, w: 1000, h: 100, paragraphs: [{ runs: [run(title, 44)] }] },
    { type: 'text', x: 80, y: 420, w: 1000, h: 60, paragraphs: [{ runs: [run(subtitle, 20)] }] },
  ],
})

const STYLE = [
  'Backgrounds: cover #E85D5D; content, data and closing #F5F0E8.',
  'Colors: main text #1A1A1A; primary accent #E85D5D.',
  'Fonts: Korean title Pretendard, Latin title Bebas Neue, 32-48pt; body Pretendard 12-15pt.',
].join('\n')

const base = (): SlideTemplate => ({
  id: 'sample',
  name: 'Sample',
  scheme: 'light',
  description: 'A plain fixture used by the validator tests.',
  fonts: { title: 'Pretendard', body: 'Pretendard', latinTitle: 'Bebas Neue' },
  palette: ['#E85D5D', '#F5F0E8', '#1A1A1A'],
  styleSheet: STYLE,
  sampleCover: {
    ko: cover('분기 성과 보고', '세 가지 숫자로 보는 한 해'),
    en: cover('Quarterly results', 'One year in three numbers'),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/sample',
  },
})

/** The fixture with both covers rewritten the same way. */
const withCovers = (edit: (spec: PageSpec) => void): SlideTemplate => {
  const t = base()
  edit(t.sampleCover.ko)
  edit(t.sampleCover.en)
  return t
}

const withStyle = (extra: string): SlideTemplate => ({
  ...base(),
  styleSheet: `${STYLE}\n${extra}`,
})

const codes = (problems: TemplateProblem[]): string[] => [...new Set(problems.map((p) => p.code))]

const titleOf = (spec: PageSpec) =>
  spec.elements[1] as Extract<PageSpec['elements'][number], { type: 'text' }>

describe('validateSlideTemplate', () => {
  it('accepts the valid fixture', async () => {
    expect(await validateSlideTemplate(base())).toEqual([])
  })

  it('accepts every template of the catalog', async () => {
    for (const t of listSlideTemplates()) {
      expect({ id: t.id, problems: await validateSlideTemplate(t) }).toEqual({
        id: t.id,
        problems: [],
      })
    }
  }, 60_000)

  it('says where each problem is and what to fix', async () => {
    const problems = await validateSlideTemplate(withStyle('Card background #123456.'))
    expect(problems).toEqual([
      {
        code: 'style_color',
        where: 'styleSheet',
        message: expect.stringContaining('#123456'),
      },
    ])
  })
})

describe('validateSlideTemplate: style text', () => {
  it('rejects a style text over the length cap and accepts one exactly at it', async () => {
    const pad = (length: number) => STYLE + ' '.repeat(length - STYLE.length - 1) + '.'
    expect(pad(SLIDE_TEMPLATE_STYLE_MAX_CHARS)).toHaveLength(SLIDE_TEMPLATE_STYLE_MAX_CHARS)
    expect(
      await validateSlideTemplate({ ...base(), styleSheet: pad(SLIDE_TEMPLATE_STYLE_MAX_CHARS) }),
    ).toEqual([])
    const over = await validateSlideTemplate({
      ...base(),
      styleSheet: pad(SLIDE_TEMPLATE_STYLE_MAX_CHARS + 1),
    })
    expect(codes(over)).toEqual(['style_length'])
    expect(over[0]!.message).toContain(String(SLIDE_TEMPLATE_STYLE_MAX_CHARS + 1))
  })

  it.each(['#FFF', '#E85D5D80', '#E85D5', '#GGGGGG', 'rgba(0, 0, 0, 0.12)', 'hsl(0 75% 64%)'])(
    'rejects the color %s for not being #RRGGBB',
    async (color) => {
      const problems = await validateSlideTemplate(withStyle(`Border ${color}.`))
      expect(codes(problems)).toEqual(['style_color'])
      expect(problems[0]!.message).toContain('#RRGGBB')
    },
  )

  it('rejects a color outside the palette, in any letter case', async () => {
    expect(codes(await validateSlideTemplate(withStyle('Border #123456.')))).toEqual([
      'style_color',
    ])
    expect(codes(await validateSlideTemplate(withStyle('Border #abcdef.')))).toEqual([
      'style_color',
    ])
  })

  it('accepts palette colors in any letter case, and white and black always', async () => {
    expect(
      await validateSlideTemplate(withStyle('Card #FFFFFF, text #000000, accent #e85d5d.')),
    ).toEqual([])
  })

  it.each(['Playfair Display', 'Inter', 'noto serif kr', 'Helvetica'])(
    'rejects the font %s, which is not one of the template fonts',
    async (font) => {
      const problems = await validateSlideTemplate(withStyle(`Quotes are set in ${font}.`))
      expect(codes(problems)).toEqual(['style_font'])
      expect(problems[0]!.message.toLowerCase()).toContain(font.toLowerCase())
    },
  )

  it('does not mistake ordinary words for font names', async () => {
    expect(
      await validateSlideTemplate(withStyle('Keep an interval of 24px; jostle nothing.')),
    ).toEqual([])
  })

  it.each([
    ...SLIDE_TEMPLATE_BANNED_WORDS,
    'Gradient',
    'GLOWING',
    'blurred',
    'textured',
    'shadows',
    'rotation',
    'rotated',
    'animated',
  ])('rejects the banned word "%s"', async (word) => {
    const problems = await validateSlideTemplate(withStyle(`Cards carry a soft ${word}.`))
    expect(codes(problems)).toEqual(['style_banned_word'])
    expect(problems[0]!.message).toContain(word)
  })

  it('lists exactly the seven banned words of the spec', () => {
    expect([...SLIDE_TEMPLATE_BANNED_WORDS]).toEqual([
      'gradient',
      'glow',
      'blur',
      'texture',
      'shadow',
      'rotate',
      'animation',
    ])
  })

  it('rejects a style text that is not written in English', async () => {
    expect(codes(await validateSlideTemplate(withStyle('제목은 크게.')))).toEqual(['field'])
  })
})

describe('validateSlideTemplate: sample cover', () => {
  it('rejects a cover with an image element', async () => {
    const problems = await validateSlideTemplate(
      withCovers((spec) => {
        spec.elements.push({
          type: 'image',
          x: 900,
          y: 300,
          w: 300,
          h: 300,
          url: 'https://example.com/photo.jpg',
        })
      }),
    )
    expect(codes(problems)).toEqual(['cover_image'])
    expect(problems.map((p) => p.where)).toEqual(['sampleCover.ko', 'sampleCover.en'])
  })

  it('rejects a cover whose text does not fit its box (geometry audit)', async () => {
    const problems = await validateSlideTemplate(
      withCovers((spec) => {
        titleOf(spec).h = 24
      }),
    )
    expect(codes(problems)).toEqual(['cover_audit'])
    expect(problems[0]!.message).toContain('Text overflow')
  })

  it('rejects a cover whose text boxes overlap (geometry audit)', async () => {
    const problems = await validateSlideTemplate(
      withCovers((spec) => {
        spec.elements[2]!.y = 300
      }),
    )
    expect(codes(problems)).toEqual(['cover_audit'])
    expect(problems[0]!.message).toContain('Overlap')
  })

  it('rejects a cover color outside the palette, also when it carries alpha', async () => {
    for (const fill of ['#123456', '#12345680']) {
      const problems = await validateSlideTemplate(
        withCovers((spec) => {
          spec.elements.splice(1, 0, {
            type: 'shape',
            shape: 'rect',
            x: 0,
            y: 600,
            w: 400,
            h: 8,
            fill,
          })
        }),
      )
      expect(codes(problems)).toEqual(['cover_color'])
      expect(problems[0]!.message).toContain('#123456')
    }
  })

  it('accepts a palette color with alpha, and white and black', async () => {
    const problems = await validateSlideTemplate(
      withCovers((spec) => {
        spec.elements.splice(
          1,
          0,
          { type: 'shape', shape: 'rect', x: 0, y: 600, w: 400, h: 8, fill: '#1A1A1A26' },
          { type: 'shape', shape: 'rect', x: 0, y: 620, w: 400, h: 8, fill: '#FFFFFF' },
          { type: 'shape', shape: 'rect', x: 0, y: 640, w: 400, h: 8, fill: '#000000' },
        )
      }),
    )
    expect(problems).toEqual([])
  })

  it('rejects a text run color that carries alpha, in a text box or inside a shape', async () => {
    const inTextBox = await validateSlideTemplate(
      withCovers((spec) => {
        titleOf(spec).paragraphs[0]!.runs[0]!.color = '#1A1A1A1F'
      }),
    )
    expect(inTextBox.map((p) => [p.code, p.where])).toEqual([
      ['cover_text_alpha', 'sampleCover.ko'],
      ['cover_text_alpha', 'sampleCover.en'],
    ])
    expect(inTextBox[0]!.message).toContain('#1A1A1A1F')
    expect(inTextBox[0]!.message).toContain('element 1')
    const inShape = await validateSlideTemplate(
      withCovers((spec) => {
        spec.elements[0] = {
          type: 'shape',
          shape: 'rect',
          x: 0,
          y: 0,
          w: 1280,
          h: 200,
          fill: '#E85D5D',
          paragraphs: [{ runs: [{ ...run('2026', 44, 'Bebas Neue'), color: '#1A1A1AFF' }] }],
        }
      }),
    )
    expect(codes(inShape)).toEqual(['cover_text_alpha'])
    expect(inShape[0]!.message).toContain('#1A1A1AFF')
    // the same label in a 6-digit color is fine
    const opaque = await validateSlideTemplate(
      withCovers((spec) => {
        spec.elements[0] = {
          type: 'shape',
          shape: 'rect',
          x: 0,
          y: 0,
          w: 1280,
          h: 200,
          fill: '#E85D5D',
          paragraphs: [{ runs: [run('2026', 44, 'Bebas Neue')] }],
        }
      }),
    )
    expect(opaque).toEqual([])
  })

  it('rejects a cover font outside the template fonts, and a run that names no font', async () => {
    const foreign = await validateSlideTemplate(
      withCovers((spec) => {
        titleOf(spec).paragraphs[0]!.runs[0]!.font = 'Playfair Display'
      }),
    )
    expect(codes(foreign)).toEqual(['cover_font'])
    expect(foreign[0]!.message).toContain('Playfair Display')
    const unnamed = await validateSlideTemplate(
      withCovers((spec) => {
        delete titleOf(spec).paragraphs[0]!.runs[0]!.font
      }),
    )
    expect(codes(unnamed)).toEqual(['cover_font'])
  })

  it('rejects a cover that page-spec validation drops from or changes', async () => {
    const dropped = await validateSlideTemplate(
      withCovers((spec) => {
        spec.elements.push({ type: 'shape', shape: 'rect', x: 0, y: 700, w: 100, h: 10 })
      }),
    )
    expect(codes(dropped)).toEqual(['cover_spec'])
    expect(dropped[0]!.message).toContain('shape without fill or stroke')
    const clamped = await validateSlideTemplate(
      withCovers((spec) => {
        spec.elements[0]!.w = 1400
      }),
    )
    expect(codes(clamped)).toEqual(['cover_spec'])
    expect(clamped[0]!.message).toContain('element 0')
    const unknownShape = await validateSlideTemplate(
      withCovers((spec) => {
        ;(spec.elements[0] as { shape: string }).shape = 'blob'
      }),
    )
    expect(codes(unknownShape)).toEqual(['cover_spec'])
  })

  it('rejects a cover that is not a page spec at all', async () => {
    const t = base()
    ;(t.sampleCover as { en: unknown }).en = { elements: [] }
    const problems = await validateSlideTemplate(t)
    expect(problems.map((p) => [p.code, p.where])).toEqual([['cover_spec', 'sampleCover.en']])
  })

  it('rejects a Korean cover without Korean text and an English cover with Korean text', async () => {
    const t = base()
    t.sampleCover.ko = cover('Quarterly results', 'One year in three numbers')
    expect((await validateSlideTemplate(t)).map((p) => [p.code, p.where])).toEqual([
      ['cover_text', 'sampleCover.ko'],
    ])
    const u = base()
    u.sampleCover.en = cover('분기 성과 보고', '세 가지 숫자로 보는 한 해')
    expect((await validateSlideTemplate(u)).map((p) => [p.code, p.where])).toEqual([
      ['cover_text', 'sampleCover.en'],
    ])
  })

  it.each(['Sample', 'Preview', 'templates', '미리보기', '템플릿'])(
    'rejects a cover that shows the word "%s"',
    async (word) => {
      const t = base()
      t.sampleCover.ko = cover('분기 성과 보고', `한 해의 기록 ${word}`)
      const problems = await validateSlideTemplate(t)
      expect(problems.map((p) => [p.code, p.where])).toEqual([['cover_text', 'sampleCover.ko']])
      expect(problems[0]!.message).toContain(word)
    },
  )

  it('rejects covers that are not the same composition', async () => {
    const t = base()
    t.sampleCover.en.elements.splice(1, 0, {
      type: 'shape',
      shape: 'rect',
      x: 80,
      y: 240,
      w: 80,
      h: 4,
      fill: '#E85D5D',
    })
    const problems = await validateSlideTemplate(t)
    expect(problems.map((p) => [p.code, p.where])).toEqual([['cover_composition', 'sampleCover']])
  })
})

describe('validateSlideTemplate: fields', () => {
  const fieldProblem = async (edit: (t: Record<string, any>) => void, where: string) => {
    const t = base() as unknown as Record<string, any>
    edit(t)
    const problems = await validateSlideTemplate(t)
    expect(problems.map((p) => [p.code, p.where])).toEqual([['field', where]])
    return problems[0]!
  }

  it.each(['Coral', 'has space', 'under_score', 'é', ''])('rejects the id "%s"', async (id) => {
    await fieldProblem((t) => (t.id = id), 'id')
  })

  it.each(['sepia', 'Light', '', undefined])('rejects the scheme %s', async (scheme) => {
    const problem = await fieldProblem((t) => (t.scheme = scheme), 'scheme')
    expect(problem.message).toContain('light')
  })

  it('rejects a missing name, description, style text, cover or source', async () => {
    await fieldProblem((t) => delete t.name, 'name')
    await fieldProblem((t) => (t.name = '  '), 'name')
    await fieldProblem((t) => delete t.description, 'description')
    await fieldProblem((t) => (t.description = '따뜻한 포스터 느낌.'), 'description')
    await fieldProblem((t) => (t.styleSheet = ''), 'styleSheet')
    await fieldProblem((t) => delete t.sampleCover, 'sampleCover')
    await fieldProblem((t) => delete t.sampleCover.en, 'sampleCover.en')
    await fieldProblem((t) => delete t.source, 'source')
    await fieldProblem((t) => (t.source.commit = 'main'), 'source.commit')
    await fieldProblem((t) => (t.source.path = ''), 'source.path')
  })

  it('rejects fonts that are missing or not bundled with the app', async () => {
    await fieldProblem((t) => delete t.fonts, 'fonts')
    await fieldProblem((t) => delete t.fonts.body, 'fonts.body')
    const problem = await fieldProblem((t) => (t.fonts.latinTitle = 'Inter'), 'fonts.latinTitle')
    expect(problem.message).toContain('Inter')
  })

  it('accepts a template without a Latin title font', async () => {
    const withoutLatin = {
      ...base(),
      fonts: { title: 'Pretendard', body: 'Pretendard' },
      styleSheet: STYLE.replace(', Latin title Bebas Neue', ''),
    }
    expect(await validateSlideTemplate(withoutLatin)).toEqual([])
    // the style sheet still naming the dropped font is a problem
    expect(codes(await validateSlideTemplate({ ...withoutLatin, styleSheet: STYLE }))).toEqual([
      'style_font',
    ])
  })

  it('rejects a palette that is empty or holds a value that is not #RRGGBB', async () => {
    await fieldProblem((t) => (t.palette = []), 'palette')
    await fieldProblem((t) => delete t.palette, 'palette')
    const problem = await fieldProblem((t) => t.palette.push('#FFF'), 'palette')
    expect(problem.message).toContain('#FFF')
  })

  it('rejects a value that is not a template object', async () => {
    for (const value of [null, 'coral', 42, []]) {
      expect((await validateSlideTemplate(value)).map((p) => p.code)).toEqual(['field'])
    }
  })

  it('reports every problem of a template, not only the first', async () => {
    const t = withStyle('A soft shadow in #123456.')
    t.id = 'Bad Id'
    expect(codes(await validateSlideTemplate(t)).sort()).toEqual([
      'field',
      'style_banned_word',
      'style_color',
    ])
  })
})
