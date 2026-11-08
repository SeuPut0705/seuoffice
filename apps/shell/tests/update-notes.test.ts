import { describe, expect, it } from 'vitest'
import { normalizeReleaseNotes } from '../src/main/update-notes'
import type { UpdateNoteBlock } from '../src/shared/update-api'

/**
 * Release-note conversion (src/main/update-notes.ts): the GitHub update feed
 * hands the release body over as GitHub's own HTML rendering, and this module
 * turns it into the safe block tree the update window draws. Remote text must
 * never survive as markup: links, images, scripts and unknown wrappers are
 * stripped to their text (or dropped), and the size caps bound what reaches
 * the UI state (docs/plans/update-details.md).
 */

/** the real v0.12.1 release body (2026-10-17), trimmed to the shapes that matter */
const RELEASE_0_12_1 = `<p>이음오피스 0.12.1입니다. 아직 <strong>베타</strong>입니다. 일부 기능은 바뀌거나 제대로 동작하지 않을 수 있습니다.</p>
<h2>설치</h2>
<p><strong>Windows</strong></p>
<ol>
<li>아래 <strong>Assets</strong>에서 <code>IeumOffice-Setup-0.12.1.exe</code>를 내려받아 실행합니다.</li>
<li>설치 파일에 서명이 없어 Windows가 "Windows의 PC 보호" 창을 띄웁니다. <strong>추가 정보 → 실행</strong>을 누르면 설치가 시작됩니다.</li>
</ol>
<h2>새로 들어간 것</h2>
<ul>
<li><strong>에이전트 모드</strong>: 사이드바의 "AI에게 묻기" 아래에 <strong>에이전트</strong>가 생겼습니다.</li>
<li><strong>ODT 문서</strong>: <code>.odt</code> 파일을 워드 편집기에서 열고, 고치고, 다시 <code>.odt</code>로 저장합니다.</li>
</ul>
<h2>고친 것</h2>
<ul>
<li>워드 탭을 닫으면 쓰던 메모리를 돌려줍니다.</li>
</ul>`

function textOf(blocks: UpdateNoteBlock[]): string {
  const pieces: string[] = []
  for (const block of blocks) {
    if (block.kind === 'list') {
      for (const item of block.items) for (const run of item) pieces.push(run.text)
    } else {
      for (const run of block.runs) pieces.push(run.text)
    }
  }
  return pieces.join('\u0000')
}

describe('normalizeReleaseNotes — real feed body', () => {
  it('converts the v0.12.1 body into headings, paragraphs and lists', () => {
    const notes = normalizeReleaseNotes(RELEASE_0_12_1)!
    expect(notes.truncated).toBe(false)
    expect(notes.sections).toHaveLength(1)
    expect(notes.sections[0]!.version).toBeNull()
    const blocks = notes.sections[0]!.blocks

    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      runs: [
        { text: '이음오피스 0.12.1입니다. 아직 ' },
        { text: '베타', strong: true },
        { text: '입니다. 일부 기능은 바뀌거나 제대로 동작하지 않을 수 있습니다.' },
      ],
    })
    const headings = blocks.filter((block) => block.kind === 'heading')
    expect(headings.map((block) => (block.kind === 'heading' ? block.runs : []).flat())).toEqual([
      [{ text: '설치' }],
      [{ text: '새로 들어간 것' }],
      [{ text: '고친 것' }],
    ])

    const lists = blocks.filter((block) => block.kind === 'list')
    expect(lists).toHaveLength(3)
    const [install, added] = lists
    expect(install).toMatchObject({ kind: 'list', ordered: true })
    expect(added).toMatchObject({ kind: 'list', ordered: false })
    const installText = JSON.stringify(install)
    expect(installText).toContain('"text":"IeumOffice-Setup-0.12.1.exe","code":true')
    expect(installText).toContain('Windows의 PC 보호')
    expect(textOf(blocks)).toContain('워드 탭을 닫으면 쓰던 메모리를 돌려줍니다.')
  })

  it('does not turn the newlines between block tags into blank paragraphs', () => {
    const blocks = normalizeReleaseNotes(RELEASE_0_12_1)!.sections[0]!.blocks
    expect(blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'heading',
      'paragraph',
      'list',
      'heading',
      'list',
      'heading',
      'list',
    ])
  })
})

describe('normalizeReleaseNotes — safe text only', () => {
  it('decodes entities into plain text', () => {
    expect(normalizeReleaseNotes('<p>a &amp; b &lt;tag&gt; &quot;q&quot;</p>')).toEqual({
      sections: [
        {
          version: null,
          blocks: [{ kind: 'paragraph', runs: [{ text: 'a & b <tag> "q"' }] }],
        },
      ],
      truncated: false,
    })
  })

  it('drops script, style and img content whole', () => {
    const notes = normalizeReleaseNotes(
      '<p>앞<img src="x" alt="IMG">뒤</p><script>alert(1)</script><style>p{color:red}</style>',
    )!
    const serialized = JSON.stringify(notes)
    expect(serialized).toContain('앞뒤')
    expect(serialized).not.toContain('alert')
    expect(serialized).not.toContain('IMG')
    expect(serialized).not.toContain('color:red')
  })

  it('keeps link text but never the href', () => {
    const notes = normalizeReleaseNotes(
      '<p><a href="https://attacker.example/x">글자</a> 링크</p>',
    )!
    expect(textOf(notes.sections[0]!.blocks)).toBe('글자 링크')
    expect(JSON.stringify(notes)).not.toContain('attacker.example')
  })

  it('keeps text of unknown wrappers and the newlines of br', () => {
    const notes = normalizeReleaseNotes('<p>가<br>나<del>다</del></p>')!
    expect(notes.sections[0]!.blocks).toEqual([{ kind: 'paragraph', runs: [{ text: '가\n나다' }] }])
  })

  it('flattens nested lists into the owning item', () => {
    const notes = normalizeReleaseNotes('<ul><li>부모<ul><li>자식</li></ul></li></ul>')!
    expect(notes.sections[0]!.blocks).toEqual([
      { kind: 'list', ordered: false, items: [[{ text: '부모\n자식' }]] },
    ])
  })

  it('treats deeper headings as level 3 and blockquote as a paragraph', () => {
    const notes = normalizeReleaseNotes('<h4>깊은 제목</h4><blockquote>인용</blockquote>')!
    expect(notes.sections[0]!.blocks).toEqual([
      { kind: 'heading', level: 3, runs: [{ text: '깊은 제목' }] },
      { kind: 'paragraph', runs: [{ text: '인용' }] },
    ])
  })

  it('keeps a code block as one monospace run with its newlines', () => {
    const notes = normalizeReleaseNotes('<pre><code>line1\nline2</code></pre>')!
    expect(notes.sections[0]!.blocks).toEqual([
      { kind: 'paragraph', runs: [{ text: 'line1\nline2', code: true }] },
    ])
  })

  it('merges both flags when strong wraps code', () => {
    const notes = normalizeReleaseNotes('<p><strong><code>b</code></strong></p>')!
    expect(notes.sections[0]!.blocks).toEqual([
      { kind: 'paragraph', runs: [{ text: 'b', strong: true, code: true }] },
    ])
  })

  it('collapses whitespace and trims the block edges', () => {
    const notes = normalizeReleaseNotes('<p>  a\n   b  </p>')!
    expect(notes.sections[0]!.blocks).toEqual([{ kind: 'paragraph', runs: [{ text: 'a b' }] }])
  })
})

describe('normalizeReleaseNotes — nothing to show', () => {
  for (const input of [null, undefined, '', ' ', 'No content.', '<p> </p>', [], {}]) {
    it(`returns null for ${JSON.stringify(input)}`, () => {
      expect(normalizeReleaseNotes(input)).toBeNull()
    })
  }
})

describe('normalizeReleaseNotes — versioned feed entries', () => {
  it('keeps the given order and drops entries without a body', () => {
    const notes = normalizeReleaseNotes([
      { version: '0.13.0', note: '<p>새 버전</p>' },
      { version: '0.12.1', note: '<p>이전 버전</p>' },
      { version: '0.12.0', note: 'No content.' },
      { version: 42, note: '<p>번호가 아닌 버전</p>' },
    ])!
    expect(notes.sections.map((section) => section.version)).toEqual(['0.13.0', '0.12.1', null])
  })
})

describe('normalizeReleaseNotes — size caps', () => {
  it('keeps at most 12 sections and flags the cut', () => {
    const many = Array.from({ length: 13 }, (_, index) => ({
      version: `0.${13 - index}.0`,
      note: '<p>x</p>',
    }))
    const notes = normalizeReleaseNotes(many)!
    expect(notes.sections).toHaveLength(12)
    expect(notes.truncated).toBe(true)
  })

  it('drops trailing blocks once the total text exceeds the cap', () => {
    const body = (letter: string) => `<p>${letter.repeat(20_000)}</p>`
    const notes = normalizeReleaseNotes(`${body('a')}${body('b')}${body('c')}\n<p>tail</p>`)!
    expect(notes.truncated).toBe(true)
    const sections = notes.sections
    const total = sections
      .flatMap((section) =>
        section.blocks.flatMap((block) =>
          block.kind === 'list' ? block.items.flat() : block.runs,
        ),
      )
      .reduce((sum, run) => sum + run.text.length, 0)
    expect(total).toBeLessThanOrEqual(48_000)
    // the newest content survives: the head of the first paragraph is intact
    const first = sections[0]!.blocks[0]!
    expect(first.kind === 'paragraph' ? first.runs[0]!.text.slice(0, 10) : '').toBe('aaaaaaaaaa')
  })

  it('keeps the head of a single oversized body instead of dropping it whole', () => {
    const notes = normalizeReleaseNotes(`<p>${'a'.repeat(300_000)}</p>`)!
    expect(notes.truncated).toBe(true)
    const block = notes.sections[0]!.blocks[0]!
    expect(block.kind === 'paragraph' ? block.runs[0]!.text.length : 0).toBeLessThanOrEqual(48_000)
  })
})
