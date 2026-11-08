import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildParseMap } from '../src/renderer/document/parse-map'
import { compileOps, type HtmlOp } from '../src/renderer/document/ops'
import { applyPatches, invertPatches, validatePatchSet } from '../src/renderer/document/patch'
import {
  findMath,
  mathEditOps,
  mathHtml,
  mathInsertOp,
  readMath,
} from '../src/renderer/extensions/math/html-adapter'
import { MATH_TEMPLATES, MAX_LATEX_LENGTH, renderMath } from '../src/renderer/extensions/math/model'

const before =
  '<!doctype html>\r\n<html lang="ko"><head><style>p { color: navy }</style><script>const x = "keep & this";</script></head><body><!-- untouched --><p id=lesson>Before &amp; after</p>'
const after = "<footer data-x='original'>Keep this exactly.</footer></body></html>"
const value = { latex: String.raw`\frac{1}{2}+\sqrt{x}`, display: true }

function apply(source: string, ops: HtmlOp[]) {
  const compiled = compileOps(source, buildParseMap(source, 1), ops)
  expect(compiled.errors).toEqual([])
  expect(
    validatePatchSet(
      { patches: compiled.patches, baseVersion: 1, origin: 'manual', label: 'math' },
      1,
      source.length,
    ),
  ).toBeNull()
  return { text: applyPatches(source, compiled.patches), patches: compiled.patches }
}

describe('HTML math extension persistence', () => {
  it.each(MATH_TEMPLATES)('renders %s as standalone MathML', (_name, latex) => {
    const rendered = renderMath({ latex, display: true })
    expect(rendered.error).toBe(false)
    const doc = new DOMParser().parseFromString(rendered.html, 'text/html')
    expect(doc.querySelector('math')?.getAttribute('display')).toBe('block')
    expect(doc.querySelector('annotation')?.textContent).toBe(latex)
    expect(doc.querySelector('script, link, img')).toBeNull()
  })

  it('saves, reopens, edits and saves again without changing surrounding source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'html-math-'))
    try {
      const path = join(dir, 'lesson.html')
      const source = before + mathHtml(value) + after
      await writeFile(path, source, 'utf8')
      const opened = await readFile(path, 'utf8')
      const map = buildParseMap(opened, 1)
      const entry = map.elements.find((e) => readMath(opened, e))!
      const target = findMath(opened, map, entry.sid)!
      expect(target.value).toEqual(value)
      const nextValue = { latex: String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, display: false }
      const result = apply(opened, mathEditOps(target, nextValue))
      expect(result.text.startsWith(before)).toBe(true)
      expect(result.text.endsWith(after)).toBe(true)
      expect(applyPatches(result.text, invertPatches(opened, result.patches))).toBe(opened)
      await writeFile(path, result.text, 'utf8')
      const reopened = await readFile(path, 'utf8')
      const fresh = buildParseMap(reopened, 9)
      expect(fresh.elements.map((e) => readMath(reopened, e)).filter(Boolean)).toEqual([nextValue])
      const doc = new DOMParser().parseFromString(reopened, 'text/html')
      expect(doc.querySelectorAll('mtr')).toHaveLength(2)
      expect(doc.querySelectorAll('mtd')).toHaveLength(4)
      expect(doc.querySelector('math')?.getAttribute('display')).not.toBe('block')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('adopts Meditor data-latex objects and preserves their authored attributes', () => {
    const original =
      '<span id=eq class="formula-view" style="font-size:22px" data-latex="x&amp;y" data-display="false"><em>old rendering</em></span>'
    const source = before + original + after
    const map = buildParseMap(source, 1)
    const child = map.elements.find((e) => e.tag === 'em')!
    const target = findMath(source, map, child.sid)!
    expect(target.value.latex).toBe('x&y')
    const result = apply(source, mathEditOps(target, value)).text
    expect(result).toContain('id=eq class="formula-view" style="font-size:22px"')
    expect(result.startsWith(before)).toBe(true)
    expect(result.endsWith(after)).toBe(true)
  })

  it('does not rewrite a no-op equation, including imported rendering', () => {
    const source = '<span data-latex="x"><b>Original</b></span>'
    const map = buildParseMap(source, 1)
    const target = findMath(source, map, map.elements[0]!.sid)!
    expect(mathEditOps(target, target.value)).toEqual([])
  })

  it('inserts inline math inside a paragraph and block math after it', () => {
    const source = before + after
    const map = buildParseMap(source, 1)
    const p = map.elements.find((e) => e.tag === 'p')!
    const inline = apply(source, [mathInsertOp(map, p.sid, { ...value, display: false })!]).text
    const block = apply(source, [mathInsertOp(map, p.sid, value)!]).text
    expect(
      new DOMParser().parseFromString(inline, 'text/html').querySelector('p > [data-latex]'),
    ).not.toBeNull()
    expect(
      new DOMParser().parseFromString(block, 'text/html').querySelector('p + [data-latex]'),
    ).not.toBeNull()
  })

  it('keeps malformed input editable and escapes markup and attribute injection', () => {
    const broken = { latex: '\\badcommand{" onmouseover="alert(1) <img src=x> &', display: false }
    const html = mathHtml(broken)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('img,script,[onmouseover]')).toBeNull()
    expect(doc.querySelector('code')?.textContent).toBe(broken.latex)
    const map = buildParseMap(html, 1)
    expect(readMath(html, map.elements[0]!)).toEqual(broken)
  })

  it('does not permit untrusted LaTeX to produce links or external resources', () => {
    for (const latex of [
      String.raw`\href{javascript:alert(1)}{x}`,
      String.raw`\includegraphics{https://example.com/x}`,
      String.raw`\htmlClass{unsafe}{x}`,
    ]) {
      const doc = new DOMParser().parseFromString(
        renderMath({ latex, display: false }).html,
        'text/html',
      )
      expect(doc.querySelector('a,img,script,iframe,.unsafe')).toBeNull()
    }
  })

  it('bounds input and recursive macro expansion', () => {
    expect(renderMath({ latex: 'x'.repeat(MAX_LATEX_LENGTH + 1), display: false }).error).toBe(true)
    expect(renderMath({ latex: String.raw`\def\a{\a}\a`, display: false }).error).toBe(true)
  })

  it('does not rewrite unknown versions, scripts or void elements', () => {
    const source =
      '<span data-gx-math="2" data-latex="x">future</span><script data-latex="x">a()</script><img data-latex="x">'
    const map = buildParseMap(source, 1)
    expect(map.elements.map((e) => readMath(source, e)).filter(Boolean)).toEqual([])
    expect(findMath(source, map, 999)).toBeNull()
  })
})
