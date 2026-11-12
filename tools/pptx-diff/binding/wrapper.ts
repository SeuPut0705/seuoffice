// The TypeScript wrapper of a routed pptx export: a call of engine.ts's `call`
// with the arguments the engine reads, the arguments it changes (`mut`, from
// the Rust `&mut` parameters) and the shape of the reply. An override's
// `body` may spell the call as `$call(a, b)` (those wire arguments) or `$call`
// (the TypeScript parameters); see overrides.ts.
import type { ExportInfo } from '../../docx-diff/binding/manifest'
import type { Override } from '../../docx-diff/binding/overrides'
import { classify, wireParams } from './kinds'

const NOW: Record<string, string> = { $now: 'Date.now()', $nowIso: 'new Date().toISOString()' }
const substituteNow = (text: string): string => text.replace(/\$nowIso\b|\$now\b/g, (m) => NOW[m]!)

/** The end of the parenthesis that opens at `open` of `text`. */
function closeOf(text: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c) && --depth === 0) return i
  }
  throw new Error(`unbalanced $call( in: ${text}`)
}

export function callOptions(info: ExportInfo, args: string[], withReply: boolean, named: boolean): string {
  const wire = wireParams(info.rust?.params ?? [])
  const mut: string[] = []
  const read: number[] = []
  wire.forEach((raw, j) => {
    const c = classify(raw)
    if (c.kind === 'opened') {
      if (c.mut) mut.push(`${j}: 'opened'`)
      else read.push(j)
    } else if (c.kind === 'archive' && c.mut) mut.push(`${j}: 'archive'`)
    else if (c.kind === 'json-mut') mut.push(`${j}: 'json'`)
  })
  const options: string[] = []
  if (mut.length) options.push(`mut: { ${mut.join(', ')} }`)
  if (read.length) options.push(`opened: ${JSON.stringify(read)}`)
  if (named || info.params.some((p) => p.codec === 'callback' || /=>/.test(p.type)))
    options.push(`names: ${JSON.stringify(args.map((a) => (/^[A-Za-z_$][\w$]*$/.test(a) ? a : '')))}`)
  if (withReply) {
    if (info.ret.shape) options.push(`shape: ${JSON.stringify(info.ret.shape)}`)
    if (info.ret.undef && !info.ret.null) options.push('undef: true')
  }
  return options.length ? `, { ${options.join(', ')} }` : ''
}

/** The text of an engine call: `call('name', [args], options)`. */
function callText(info: ExportInfo, args: string[], withReply: boolean, named: boolean): string {
  return `call('${info.name}', [${args.join(', ')}]${callOptions(info, args, withReply, named)})`
}

function expand(body: string, info: ExportInfo, defaults: string[], named: boolean): string {
  let out = ''
  let at = 0
  for (const m of body.matchAll(/\$call\b/g)) {
    const start = m.index!
    if (start < at) continue
    let end = start + '$call'.length
    let args = defaults
    if (body[end] === '(') {
      const close = closeOf(body, end)
      args = splitArgs(body.slice(end + 1, close))
      end = close + 1
    }
    const lineStart = body.lastIndexOf('\n', start - 1) + 1
    const rest = /^[ \t]*(?:;|\n|$)/.test(body.slice(end))
    const statement = body.slice(lineStart, start).trim() === '' && rest
    out += body.slice(at, start) + callText(info, args, false, named) + (statement ? '' : ' as never')
    at = end
  }
  return out + body.slice(at)
}

function splitArgs(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      current += c
      if (c === '\\') current += text[++i] ?? ''
      else if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    if (c === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else current += c
  }
  if (current.trim()) out.push(current.trim())
  return out
}

export function pptxWrapperBody(info: ExportInfo, names: string[], override: Override | undefined): string | null {
  const args = override?.args?.map(substituteNow) ?? names.map((n, i) => (info.params[i]?.rest ? `...${n}` : n))
  // a function argument crosses under the name of its wire argument: a row that takes one (`pass`) asks the host for it by that name
  const named = !!(override as { pass?: unknown } | undefined)?.pass
  if (override?.body) return expand(substituteNow(override.body), info, args, named)
  return `return ${callText(info, args, true, named)} as never`
}
