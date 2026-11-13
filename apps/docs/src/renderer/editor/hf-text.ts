/**
 * Plain-text view of a header/footer part, shared by the on-canvas editing
 * surface and the AI set_header_footer tool: paragraphs edit as lines, the
 * invisible PAGE / NUMPAGES / SECTIONPAGES field sentinels as visible {PAGE} /
 * {NUMPAGES} / {SECTIONPAGES} tokens. Layout-table rows (cells) and images stay out of the text flow and
 * keep their original content.
 */
import { checkPlaceholders, placeholderSource } from '@seuoffice/agent-core/redact-core'
import {
  PAGE_MARK,
  SECTION_PAGES_MARK,
  TOTAL_PAGES_MARK,
  withheldLabelOf,
  type HeaderFooter,
  type HfImage,
  type HfParagraph,
  type Run,
} from '@seuoffice/docx-engine'

export const PAGE_TOKEN = '{PAGE}'
export const TOTAL_TOKEN = '{NUMPAGES}'
export const SECTION_TOKEN = '{SECTIONPAGES}'

/** effective paragraphs: rich paras when present, else the legacy single line */
export function hfParasOf(value: HeaderFooter, images?: HfImage[] | null): HfParagraph[] {
  if (value.paras?.length) return value.paras
  const runs: Run[] = value.text ? [{ text: value.text }] : []
  if (value.pageNumber && !value.text.includes('#') && !value.text.includes(PAGE_MARK)) {
    runs.push({ text: runs.length > 0 ? ` ${PAGE_MARK}` : PAGE_MARK })
  }
  // Word reserves exactly the picture height for a picture-only part: no text line
  if (runs.length === 0 && images?.some((im) => !im.floating)) return []
  return [{ align: 'center', runs }]
}

/** Pictures are not editable: they leave the text runs and return to the
 *  same side of the text they came from (a logo before the title stays first). */
export function hfPictureRuns(runs: Run[]): { leading: Run[]; text: Run[]; trailing: Run[] } {
  const leading: Run[] = []
  const text: Run[] = []
  const trailing: Run[] = []
  for (const run of runs) {
    if (run.image) {
      ;(text.length > 0 ? trailing : leading).push({ ...run, text: '' })
      if (run.text === '') continue
    }
    const { image: _image, ...rest } = run
    text.push(rest)
  }
  return { leading, text, trailing }
}

/** editable text of the part: one line per text paragraph, field sentinels as tokens */
export function hfEditText(value: HeaderFooter): string {
  return hfLinesText(textParas(value).map((p) => p.runs.filter((r) => !r.del).map((r) => r.text)))
}

function hfLinesText(lines: string[][]): string {
  return lines
    .map((pieces) => pieces.join(''))
    .join('\n')
    .replaceAll(PAGE_MARK, PAGE_TOKEN)
    .replaceAll(TOTAL_PAGES_MARK, TOTAL_TOKEN)
    .replaceAll(SECTION_PAGES_MARK, SECTION_TOKEN)
}

/** runs of the part hidden from AI, next to each other under one label: one placeholder */
interface WithheldSpan {
  marker: string
  runs: Run[]
}

/** a text paragraph's live runs, the ones hidden from AI grouped into their spans */
function modelPieces(runs: Run[]): Array<Run | WithheldSpan> {
  const pieces: Array<Run | WithheldSpan> = []
  let label: string | null = null
  for (const source of runs) {
    if (source.del) continue
    // a picture is no part of the text flow: hfPictureRuns gives it back on its own side of the
    // text, so a span holding it as well would write the hidden picture twice
    if (source.image && source.text === '') continue
    const { image: _image, ...run } = source
    const mine = withheldLabelOf(run.rawRPr)
    const last = pieces[pieces.length - 1]
    if (mine !== null && mine === label && last && 'marker' in last) last.runs.push(run)
    else pieces.push(mine === null ? run : { marker: placeholderSource(mine), runs: [run] })
    label = mine
  }
  return pieces
}

function textParas(value: HeaderFooter): HfParagraph[] {
  return hfParasOf(value).filter((p) => !p.cells)
}

/**
 * The part's text as a model may read it: `hfEditText`, with each run the
 * person hid from AI read as its `{{label}}` placeholder.
 */
export function hfModelText(value: HeaderFooter): string {
  return hfLinesText(
    textParas(value).map((p) =>
      modelPieces(p.runs).map((piece) => ('marker' in piece ? piece.marker : piece.text)),
    ),
  )
}

/**
 * The part's layout tables as a model may read them: one line per row, cells
 * joined with " | " (a cell's paragraphs with a space), each run hidden from AI
 * as its placeholder; "" when the part has none. Read-only: set_header_footer
 * keeps the rows as they are.
 */
export function hfModelTableText(value: HeaderFooter): string {
  return hfParasOf(value)
    .flatMap((p) => (p.cells ? [p.cells] : []))
    .map((cells) =>
      cells
        .map((cell) =>
          cell.paras
            .map((runs) =>
              hfLinesText([
                modelPieces(runs).map((piece) => ('marker' in piece ? piece.marker : piece.text)),
              ]),
            )
            .join(' '),
        )
        .join(' | '),
    )
    .join('\n')
}

/**
 * A model's new text for the part (written against `hfModelText`). Its
 * placeholders must come back exactly as given: each then becomes the hidden
 * runs it stands for, so the person's words and their mark survive the edit,
 * and the new words never take the mark. Returns the reason when they do not.
 */
export function applyHfModelText(value: HeaderFooter | null, text: string): HeaderFooter | string {
  const spans = new Map<string, Run[][]>()
  for (const p of value ? textParas(value) : []) {
    for (const piece of modelPieces(p.runs)) {
      if ('marker' in piece)
        spans.set(piece.marker, [...(spans.get(piece.marker) ?? []), piece.runs])
    }
  }
  if (spans.size === 0) return applyHfText(value, text)
  const damaged = checkPlaceholders(hfModelText(value!), text).length
  if (damaged > 0) {
    return `this edit would damage ${damaged} private placeholder(s) (dropped, renamed, split or duplicated) — reproduce each {{...}} exactly and rephrase around them instead`
  }
  return applyHfText(value, text, (line, style) =>
    line.split(/(\{\{[^{}]*\}\})/).flatMap((piece): Run[] => {
      const hidden = spans.get(piece)?.shift()
      if (hidden) return hidden
      return piece === '' ? [] : [{ ...style, text: piece }]
    }),
  )
}

/**
 * Map edited lines back onto the part: each line keeps its original
 * paragraph's format and first-run styling (extra lines reuse the last
 * template), cells rows are spliced back at their original positions.
 */
export function applyHfText(
  value: HeaderFooter | null,
  text: string,
  /** a model's edit: how a line becomes runs, its hidden runs given back (applyHfModelText) */
  lineRuns?: (line: string, style: Run) => Run[],
): HeaderFooter {
  const base = value ?? { text: '' }
  const paras = hfParasOf(base)
  const lines = text
    .replace(/\n+$/, '')
    .replaceAll(PAGE_TOKEN, PAGE_MARK)
    .replaceAll(TOTAL_TOKEN, TOTAL_PAGES_MARK)
    .replaceAll(SECTION_TOKEN, SECTION_PAGES_MARK)
    .split('\n')
  const textParas = paras.filter((p) => !p.cells)
  const templates: HfParagraph[] =
    textParas.length > 0 ? textParas : [{ align: 'center', runs: [] }]
  const edited: HfParagraph[] = lines.map((line, i) => {
    const template = templates[Math.min(i, templates.length - 1)]
    const { leading, text: textRuns, trailing } = hfPictureRuns(template.runs)
    // The line takes the styling of the paragraph's first text run that is not a tracked
    // deletion. A wrapper (a content control) is not styling: the retyped line is plain
    // text. It is also the accepted text: it must not inherit a tracked wrapper.
    const {
      ins: _ins,
      del: _del,
      wrap: _wrap,
      ...style
    } = lineRuns
      ? // the mark belongs to the person, so a model's new words never take it
        (textRuns.find((r) => !r.del && withheldLabelOf(r.rawRPr) === null) ?? { text: '' })
      : (textRuns.find((r) => !r.del) ?? textRuns[0] ?? { text: '' })
    const runs = line === '' ? [] : lineRuns ? lineRuns(line, style) : [{ ...style, text: line }]
    return { ...template, runs: [...leading, ...runs, ...trailing] }
  })
  const nextParas: HfParagraph[] = []
  let ei = 0
  for (const p of paras) {
    if (p.cells) nextParas.push(p)
    else if (ei < edited.length) nextParas.push(edited[ei++])
  }
  nextParas.push(...edited.slice(ei))
  const nextText = edited.map((p) => p.runs.map((r) => r.text).join('')).join('')
  return { ...base, text: nextText, paras: nextParas }
}
