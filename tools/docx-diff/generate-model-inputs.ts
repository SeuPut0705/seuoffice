import type { ParsedDoc, ParaFormat, Run } from './reference/types'
import { runModelInputs } from './calls-gen-runs'
import type { Input } from './calls-spec'

export function rprModelInputs(doc: ParsedDoc): Input[] {
  return runModelInputs(doc).flatMap(({ args }) =>
    (args!.runs as Run[]).flatMap((run) => [
      { text: run.rawRPr ?? '', args: { run, insideLink: false } },
      {
        text: run.rawRPr ?? '',
        args: { run: { ...run, bold: !run.bold }, insideLink: !!run.link },
      },
    ]),
  )
}

export function pprModelInputs(doc: ParsedDoc): Input[] {
  const inputs: Input[] = []
  const add = (format: ParaFormat | undefined, raw = ''): void => {
    if (!format) return
    inputs.push({ text: raw, args: { format, original: format } })
    inputs.push({
      text: raw,
      args: { format: { ...format, align: 'right', indentLeft: -21.5 }, original: format },
    })
  }
  for (const block of doc.blocks) {
    add(block.format, block.rawPPr)
    for (const row of block.table?.rows ?? [])
      for (const cell of row) {
        for (const para of cell.richParas ?? []) {
          const { runs: _runs, list: _list, styleId: _style, ...format } = para
          add(format)
        }
      }
    for (const box of block.textboxes ?? [])
      for (const para of box.paras) {
        const {
          runs: _runs,
          styleId: _style,
          listMarker: _list,
          cells: _cells,
          row: _row,
          ...format
        } = para
        add(format)
      }
  }
  return inputs
}
