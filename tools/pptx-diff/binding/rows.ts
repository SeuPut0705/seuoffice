// The Rust row of a pptx export (the pptx counterpart of rowOf in
// tools/docx-diff/binding/rust-table.ts): it reads the wire arguments by the
// Rust parameter kinds (kinds.ts), fills the ones the host owns, calls the port
// and answers `{ "$result": value, "$out": { "<wire index>": answer } }`.
import type { RowTools } from '../../docx-diff/binding/config'
import type { ExportInfo } from '../../docx-diff/binding/manifest'
import { classify } from './kinds'
import { overrideOf } from './overrides'

const rowHead = (fn: string): string => `fn ${fn}(env: &mut InvokeEnv<'_>, args: &[Value]) -> Out {\n    `

export function pptxRow(e: ExportInfo, notes: string[], fn: string, tools: RowTools): { code: string } | null {
  const { firstArgument, readParam } = tools
  const rust = e.rust!
  const override = overrideOf(e.name)
  if (override?.rust) return { code: `${rowHead(fn)}${override.rust.replaceAll('{{path}}', rust.path)}\n}\n` }
  const lines: string[] = []
  const passed: string[] = []
  const out: string[] = []
  const after: string[] = []
  let wire = 0
  for (const [position, raw] of rust.params.entries()) {
    const c = classify(raw)
    const p = `p${wire}`
    const at = `at(args, ${wire})`
    const pass = override?.pass?.[position]
    if (pass !== undefined) {
      passed.push(pass)
      wire++
      continue
    }
    if (c.kind === 'host') {
      if (c.host === 'uuid') {
        lines.push('let uuid = jscompat::random_uuid();')
        passed.push('&uuid')
      } else if (c.host === 'uuid-source') {
        lines.push('let mut uuids = || jscompat::random_uuid();')
        passed.push('&mut uuids')
      } else if (c.host === 'uuid-source-impl') passed.push('|| jscompat::random_uuid()')
      else if (c.host === 'now') passed.push('env.now_ms')
      else {
        lines.push('let uids = pptx::uids();')
        passed.push('&uids')
        after.push('pptx::keep_uids(&uids);')
      }
      continue
    }
    if (c.kind === 'opened') {
      lines.push(`let ${c.mut ? 'mut ' : ''}${p} = pptx::read_opened(env, ${at})?;`)
      passed.push(c.mut ? `&mut ${p}.opened` : `&${p}.opened`)
      if (c.mut) out.push(`(${wire}, pptx::answer_opened(env, ${p})?)`)
    } else if (c.kind === 'archive') {
      lines.push(`let ${c.mut ? 'mut ' : ''}${p} = pptx::read_archive(env, ${at})?;`)
      passed.push(c.mut ? `&mut ${p}.archive` : `&${p}.archive`)
      if (c.mut) out.push(`(${wire}, pptx::answer_archive(env, &${p}.sent, &${p}.archive))`)
    } else if (c.kind === 'json-mut') {
      const type = c.type.startsWith('[') ? `Vec<${qualified(tools, e, c.type.slice(1, -1), notes)}>` : qualified(tools, e, c.type, notes)
      lines.push(`let mut ${p}: ${type} = req(args, ${wire})?;`)
      passed.push(`&mut ${p}`)
      out.push(`(${wire}, to_json(&${p})?)`)
    } else if (/^&?JsObject<f64>$/.test(c.type)) {
      // a JavaScript number: NaN and the infinities cross as their spelling (`JsNum` reads it)
      lines.push(
        `let ${p}: jscompat::JsObject<jscompat::JsNum> = req(args, ${wire})?;`,
        `let ${p}: jscompat::JsObject<f64> = ${p}.entries().into_iter().map(|(key, value)| (key.to_owned(), value.0)).collect();`,
      )
      passed.push(c.type.startsWith('&') ? `&${p}` : p)
    } else {
      const read = readParam(e, wire, raw, notes)
      if (!read) return null
      lines.push(...read.lines)
      passed.push(read.arg)
    }
    wire++
  }
  if (override?.lines) lines.push(override.lines)
  const ret = rust.ret.replace(/'[a-z_]+\s*/g, '').replace(/\s+/g, ' ').trim()
  const isResult = /^Result</.test(ret)
  const inner = isResult ? firstArgument(ret.slice('Result<'.length, ret.lastIndexOf('>'))) : ret
  const call = `${rust.path}(${passed.join(', ')})`
  if (override?.ret) {
    lines.push(`let r = ${call};`, ...after, override.ret.replaceAll('{{out}}', `vec![${out.join(', ')}]`))
    return { code: `${rowHead(fn)}${lines.join('\n    ')}\n}\n` }
  }
  lines.push(isResult ? `let r = ${call}.map_err(|error| error.to_string())?;` : `let r = ${call};`)
  lines.push(...after)
  const unit = inner === '' || inner === '()'
  const value = unit
    ? 'None'
    : e.ret.bytes && inner === 'Vec<u8>'
      ? 'Some(env.put_blob(r))'
      : e.ret.bytes && inner === 'Option<Vec<u8>>'
        ? 'Some(match r { Some(bytes) => env.put_blob(bytes), None => Value::Null })'
        : 'Some(to_json(&r)?)'
  if (value.includes('to_json')) lines.push('let value = to_json(&r)?;')
  lines.push(`Ok(Some(pptx::answer(${value.includes('to_json') ? 'Some(value)' : value}, vec![${out.join(', ')}])))`)
  return { code: `${rowHead(fn)}${lines.join('\n    ')}\n}\n` }
}

function qualified(tools: RowTools, e: ExportInfo, type: string, notes: string[]): string {
  const named = tools.qualify(type, e.rust!.file)
  if (named.missing) notes.push(`${e.name}: the type ${named.missing} cannot be named from pptx_table.rs`)
  return named.text
}
