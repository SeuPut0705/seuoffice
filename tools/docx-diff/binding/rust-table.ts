// The generated Rust side of the binding: `invoke`'s table. One function per
// export that has a row, reading its Rust arguments from the positional JSON
// the binding sends (by the Rust parameter types) and answering by the Rust
// return type. Written by gen.ts.
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { type ExportInfo, ROOT, pathOf } from './manifest'
import { overrideOf } from './overrides'

const CRATE_OF_DIR: Array<{ dir: string; crate: string }> = [
  { dir: 'crates/docx-engine/src', crate: 'docx_engine' },
  { dir: 'crates/omml/src', crate: 'omml' },
  { dir: 'crates/ooxml-pkg/src', crate: 'ooxml_pkg' },
  { dir: 'crates/pptx-engine/src', crate: 'pptx_engine' },
]

const snake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()

// ---------------------------------------------------------------- naming the types of a signature

/** the module path of a file: [crate, ...modules] */
function modulePath(file: string): string[] {
  const crate = CRATE_OF_DIR.find((c) => file.startsWith(c.dir + '/'))!
  const parts = relative(crate.dir, file).replace(/\\/g, '/').replace(/\.rs$/, '').split('/')
  if (parts.at(-1) === 'mod') parts.pop()
  return [crate.crate, ...parts]
}

interface Scope {
  /** a name this file brings in with `use`, to its absolute path */
  uses: Map<string, string>
  /** the types and traits this file declares */
  items: Set<string>
}

const scopes = new Map<string, Scope>()

function flattenUse(prefix: string, tree: string, out: Array<[string, string]>): void {
  const text = tree.trim()
  const brace = text.indexOf('{')
  if (brace === -1) {
    const [path, alias] = text.split(/\s+as\s+/)
    const full = `${prefix}${path!.trim()}`
    const last = full.split('::').at(-1)!
    if (last === 'self') {
      const without = full.replace(/::self$/, '')
      out.push([alias?.trim() ?? without.split('::').at(-1)!, without])
    } else if (last !== '*') out.push([alias?.trim() ?? last, full])
    return
  }
  const head = text.slice(0, brace)
  let depth = 0
  let start = brace + 1
  for (let i = brace + 1; i < text.length; i++) {
    const c = text[i]!
    if (c === '{') depth++
    else if (c === '}') {
      if (depth === 0) {
        if (text.slice(start, i).trim()) flattenUse(`${prefix}${head}`, text.slice(start, i), out)
        break
      }
      depth--
    } else if (c === ',' && depth === 0) {
      flattenUse(`${prefix}${head}`, text.slice(start, i), out)
      start = i + 1
    }
  }
}

function absolute(path: string, here: string[]): string {
  const parts = path.split('::')
  const crateRoot = here[0]!
  if (parts[0] === 'crate') return [crateRoot, ...parts.slice(1)].join('::')
  if (parts[0] === 'self') return [...here, ...parts.slice(1)].join('::')
  if (parts[0] === 'super') {
    let base = [...here]
    let i = 0
    while (parts[i] === 'super') {
      base = base.slice(0, -1)
      i++
    }
    return [...base, ...parts.slice(i)].join('::')
  }
  return path
}

function scopeOf(file: string): Scope {
  const known = scopes.get(file)
  if (known) return known
  const text = readFileSync(join(ROOT, file), 'utf8')
  const here = modulePath(file)
  const scope: Scope = { uses: new Map(), items: new Set() }
  for (const m of text.matchAll(/^\s*(?:pub(?:\([a-z]+\))?\s+)?use\s+([^;]+);/gm)) {
    const out: Array<[string, string]> = []
    flattenUse('', m[1]!, out)
    for (const [name, path] of out) scope.uses.set(name, absolute(path, here))
  }
  for (const m of text.matchAll(
    /^\s*(?:pub(?:\([a-z]+\))?\s+)?(?:struct|enum|type|trait|union)\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
  ))
    scope.items.add(m[1]!)
  scopes.set(file, scope)
  return scope
}

const PRELUDE = new Set(['Option', 'Vec', 'String', 'Result', 'Box', 'Some', 'None'])

/** the public path of an item a file declares; the file's module path if nothing re-exports it */
function itemPath(file: string, name: string): string {
  return pathOf(file, name).path
}

/** `type` with every type name written out as an absolute path; null names the first that cannot be resolved */
function qualify(type: string, file: string): { text: string; missing: string | null } {
  const scope = scopeOf(file)
  const here = modulePath(file)
  let missing: string | null = null
  let text = type.replace(/'[a-z_]+\s*/g, '').replace(/\s+/g, ' ')
  // a leading path segment that is a `use`d module
  text = text.replace(/(?<![:\w])([a-z_][a-z0-9_]*)::/g, (match, head: string) => {
    if (['crate', 'self', 'super', 'std', 'core', 'alloc'].includes(head)) return match
    const used = scope.uses.get(head)
    return used ? `${used}::` : match
  })
  text = text.replace(/(?<![:\w])(crate|self|super)::([A-Za-z0-9_:]+)/g, (match) =>
    absolute(match, here),
  )
  text = text.replace(/(?<![:\w])([A-Z][A-Za-z0-9_]*)\b(?!::)/g, (match, id: string) => {
    if (PRELUDE.has(id)) return match
    const used = scope.uses.get(id)
    if (used) return used
    if (scope.items.has(id)) return itemPath(file, id)
    missing ??= id
    return match
  })
  return { text, missing }
}

// ---------------------------------------------------------------- one row

interface Row {
  name: string
  fn: string
  code: string
}

const stripName = (param: string): string =>
  param.replace(/^(?:mut )?(?:r#)?_?[a-z][a-z_0-9]*\s*:\s*/, '').trim()
const INTEGER = /^(?:usize|u8|u16|u32|u64|i8|i16|i32|i64|isize|bool|f32)$/

/** one Rust parameter: the lines that read it, and the argument that passes it */
function readParam(
  env: ExportInfo,
  index: number,
  raw: string,
  notes: string[],
): { lines: string[]; arg: string; mutates?: boolean } | null {
  const rust = env.rust!
  const type = stripName(raw)
  const plain = type
    .replace(/'[a-z_]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const p = `p${index}`
  const at = `args.get(${index}).unwrap_or(&Value::Null)`
  const qualified = (t: string): string | null => {
    const q = qualify(t, rust.file)
    if (q.missing) {
      notes.push(
        `${env.name}: the type ${q.missing} of the parameter ${index} cannot be named from table.rs`,
      )
      return null
    }
    return q.text
  }
  if (plain === '&str') return { lines: [`let ${p} = rstr(args, ${index})?;`], arg: p }
  if (plain === 'String') return { lines: [`let ${p}: String = req(args, ${index})?;`], arg: p }
  if (plain === 'Option<&str>') return { lines: [`let ${p} = ostr(args, ${index})?;`], arg: p }
  if (plain === 'Option<String>')
    return { lines: [`let ${p}: Option<String> = opt(args, ${index})?;`], arg: p }
  if (plain === 'f64') return { lines: [`let ${p} = num(args, ${index})?;`], arg: p }
  if (plain === 'Option<f64>') return { lines: [`let ${p} = onum(args, ${index})?;`], arg: p }
  if (INTEGER.test(plain)) return { lines: [`let ${p}: ${plain} = req(args, ${index})?;`], arg: p }
  const option = /^Option<(.+)>$/.exec(plain)
  if (option && INTEGER.test(option[1]!))
    return { lines: [`let ${p}: ${plain} = opt(args, ${index})?;`], arg: p }
  if (plain === '&[u8]') return { lines: [`let ${p} = env.blob(${at})?;`], arg: p }
  if (plain === 'Option<&[u8]>')
    return {
      lines: [`let ${p} = match ${at} { Value::Null => None, other => Some(env.blob(other)?) };`],
      arg: p,
    }
  if (plain === '&XNode') return { lines: [`let ${p} = xnode(args, ${index})?;`], arg: `&${p}` }
  if (plain === 'Option<&XNode>')
    return { lines: [`let ${p} = oxnode(args, ${index})?;`], arg: `${p}.as_ref()` }
  if (plain === '&Package')
    return { lines: [`let ${p} = routes::package_of(env, ${at})?;`], arg: `&${p}` }
  if (plain === '&mut Package')
    return {
      lines: [`let mut ${p} = routes::package_of(env, ${at})?;`, `let before = snapshot(&${p});`],
      arg: `&mut ${p}`,
      mutates: true,
    }
  if (plain === '&dyn MediaHost') return { lines: [], arg: '&env.media' }
  if (plain === '&[f64]') return { lines: [`let ${p} = nums(args, ${index})?;`], arg: `&${p}` }
  if (plain === '&[Option<f64>]')
    return { lines: [`let ${p} = onums(args, ${index})?;`], arg: `&${p}` }
  if (plain === 'Option<&[f64]>')
    return {
      lines: [
        `let ${p} = match args.get(${index}) { None | Some(Value::Null) => None, Some(_) => Some(nums(args, ${index})?) };`,
      ],
      arg: `${p}.as_deref()`,
    }
  if (plain === '&[&str]')
    return {
      lines: [
        `let ${p}: Vec<String> = req(args, ${index})?;`,
        `let ${p}_refs: Vec<&str> = ${p}.iter().map(String::as_str).collect();`,
      ],
      arg: `&${p}_refs`,
    }
  let m = /^&\[(.+)\]$/.exec(plain)
  if (m) {
    const t = qualified(m[1]!)
    return t ? { lines: [`let ${p}: Vec<${t}> = req(args, ${index})?;`], arg: `&${p}` } : null
  }
  m = /^Option<&\[(.+)\]>$/.exec(plain)
  if (m) {
    const t = qualified(m[1]!)
    return t
      ? { lines: [`let ${p}: Option<Vec<${t}>> = opt(args, ${index})?;`], arg: `${p}.as_deref()` }
      : null
  }
  m = /^Option<&(.+)>$/.exec(plain)
  if (m) {
    const t = qualified(m[1]!)
    return t
      ? { lines: [`let ${p}: Option<${t}> = opt(args, ${index})?;`], arg: `${p}.as_ref()` }
      : null
  }
  m = /^&(.+)$/.exec(plain)
  if (m && !/^mut /.test(m[1]!)) {
    const t = qualified(m[1]!)
    return t ? { lines: [`let ${p}: ${t} = req(args, ${index})?;`], arg: `&${p}` } : null
  }
  m = /^Option<(.+)>$/.exec(plain)
  if (m) {
    const t = qualified(m[1]!)
    return t ? { lines: [`let ${p}: Option<${t}> = opt(args, ${index})?;`], arg: p } : null
  }
  if (/^[A-Za-z_:][A-Za-z0-9_:<>, ]*$/.test(plain) && !/&|\bmut\b/.test(plain)) {
    const t = qualified(plain)
    return t ? { lines: [`let ${p}: ${t} = req(args, ${index})?;`], arg: p } : null
  }
  notes.push(`${env.name}: parameter ${index} (${raw}) is not one the table reads`)
  return null
}

function firstArgument(text: string): string {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if ('<([{'.includes(c)) depth++
    else if (')]}'.includes(c) || (c === '>' && text[i - 1] !== '-')) depth--
    else if (c === ',' && depth === 0) return text.slice(0, i).trim()
  }
  return text.trim()
}

function rowOf(e: ExportInfo, notes: string[]): Row | null {
  const fn = `r_${snake(e.name)}`
  if (e.route === 'routes') return { name: e.name, fn, code: '' }
  const rust = e.rust!
  const override = overrideOf(e.name)
  if (override?.rust)
    return {
      name: e.name,
      fn,
      code: `fn ${fn}(env: &mut InvokeEnv<'_>, args: Args<'_>) -> Out {\n    ${override.rust.replaceAll('{{path}}', rust.path)}\n}\n`,
    }
  const lines: string[] = []
  const passed: string[] = []
  let mutates = false
  for (let i = 0; i < rust.params.length; i++) {
    const read = readParam(e, i, rust.params[i]!, notes)
    if (!read) return null
    lines.push(...read.lines)
    passed.push(read.arg)
    if (read.mutates) mutates = true
  }
  const ret = rust.ret
    .replace(/'[a-z_]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const isResult = /^Result</.test(ret)
  const inner = isResult ? firstArgument(ret.slice('Result<'.length, ret.lastIndexOf('>'))) : ret
  const call = `${rust.path}(${passed.join(', ')})`
  lines.push(isResult ? `let r = ${call}.map_err(|error| error.to_string())?;` : `let r = ${call};`)
  const unit = inner === '' || inner === '()'
  const value = unit
    ? 'Value::Null'
    : e.ret.bytes && inner === 'Vec<u8>'
      ? 'env.put_blob(r)'
      : e.ret.bytes && inner === 'Option<Vec<u8>>'
        ? 'match r { Some(bytes) => env.put_blob(bytes), None => Value::Null }'
        : 'to_json(&r)?'
  if (mutates) {
    lines.push(
      `let parts = changes(env, before, &p${rust.params.findIndex((p) => /&mut\s+Package/.test(p))});`,
    )
    lines.push(`Ok(Some(json!({ "$result": ${value}, "$parts": parts })))`)
  } else lines.push(unit ? 'Ok(None)' : `Ok(Some(${value}))`)
  return {
    name: e.name,
    fn,
    code: `fn ${fn}(env: &mut InvokeEnv<'_>, args: Args<'_>) -> Out {\n    ${lines.join('\n    ')}\n}\n`,
  }
}

const PREAMBLE = `//! GENERATED by tools/docx-diff/binding/gen.ts from tools/docx-diff/binding/manifest.json.
//! Do not edit: change the manifest's inputs (overrides.ts) and run the generator.
//!
//! The table \`invoke\` answers a TypeScript export by: each row reads the
//! positional JSON arguments by the Rust parameter types, calls the port and
//! answers by its return type. \`None\` is JSON \`null\`; the binding turns it into
//! \`undefined\` where the TypeScript return type says so.
#![allow(dead_code, unused_variables, unused_mut, clippy::all)]

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::{Args, InvokeEnv, routes};

/// What a row answers: \`None\` is \`undefined\`.
type Out = Result<Option<Value>, String>;

/// The argument \`index\` as \`T\`; absent and \`null\` are \`None\`. Read from
/// the request in place: a model argument or a long text is not copied first.
fn opt<T: DeserializeOwned>(args: Args<'_>, index: usize) -> Result<Option<T>, String> {
    let read = match (args.text(index)?, args.get(index)) {
        (Some(text), _) => T::deserialize(serde::de::value::StrDeserializer::<serde_json::Error>::new(text)),
        (None, None | Some(Value::Null)) => return Ok(None),
        (None, Some(value)) => T::deserialize(value),
    };
    read.map(Some).map_err(|error| format!("TypeError: argument {index}: {error}"))
}

/// A text argument, borrowed from the request.
fn ostr<'a>(args: Args<'a>, index: usize) -> Result<Option<&'a str>, String> {
    if let Some(text) = args.text(index)? {
        return Ok(Some(text));
    }
    match args.get(index) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(format!("TypeError: argument {index}: expected a string")),
    }
}

fn rstr<'a>(args: Args<'a>, index: usize) -> Result<&'a str, String> {
    ostr(args, index)?.ok_or_else(|| format!("TypeError: argument {index} is missing"))
}

fn req<T: DeserializeOwned>(args: Args<'_>, index: usize) -> Result<T, String> {
    opt(args, index)?.ok_or_else(|| format!("TypeError: argument {index} is missing"))
}

/// The property \`key\` of an object argument as \`T\`.
fn field<T: DeserializeOwned>(object: &Value, key: &str) -> Result<Option<T>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => T::deserialize(value)
            .map(Some)
            .map_err(|error| format!("TypeError: {key}: {error}")),
    }
}

/// A number argument: \`null\` is NaN; NaN and the infinities, which JSON
/// cannot carry, cross as their JavaScript spelling (\`jscompat::js_f64\`).
fn num(args: Args<'_>, index: usize) -> Result<f64, String> {
    match args.get(index) {
        None => Ok(f64::NAN),
        Some(value @ (Value::Null | Value::Number(_) | Value::String(_))) => {
            jscompat::js_f64(value).map_err(|error| format!("TypeError: argument {index}: {error}"))
        }
        Some(_) => Err(format!("TypeError: argument {index} is not a number")),
    }
}

/// An optional number argument: absent and \`null\` are \`None\`.
fn onum(args: Args<'_>, index: usize) -> Result<Option<f64>, String> {
    match args.get(index) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => num(args, index).map(Some),
    }
}

/// A list of numbers, each as \`num\` reads one; \`null\` items are \`None\`.
fn onums(args: Args<'_>, index: usize) -> Result<Vec<Option<f64>>, String> {
    let items: Vec<Value> = req(args, index)?;
    items
        .iter()
        .map(|item| match item {
            Value::Null => Ok(None),
            item => jscompat::js_f64(item).map(Some).map_err(|error| format!("TypeError: argument {index}: {error}")),
        })
        .collect()
}

/// A list of numbers; a \`null\` item is NaN.
fn nums(args: Args<'_>, index: usize) -> Result<Vec<f64>, String> {
    Ok(onums(args, index)?.into_iter().map(|item| item.unwrap_or(f64::NAN)).collect())
}

/// A spin count as the TypeScript receives it: any value, \`unknown\`.
fn spin_count(raw: Option<&Value>) -> docx_engine::protection::SpinCount {
    use docx_engine::protection::SpinCount;
    match raw {
        None | Some(Value::Null) => SpinCount::Missing,
        Some(Value::Number(number)) => SpinCount::Number(number.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(text)) => SpinCount::Text(text.clone()),
        Some(other) => SpinCount::Other(other.to_string()),
    }
}

/// The answer as JSON, a non-finite number as the host revives it.
fn to_json(value: &impl Serialize) -> Result<Value, String> {
    jscompat::writing_for_host(|| serde_json::to_value(value)).map_err(|error| error.to_string())
}

fn put(value: impl Serialize) -> Out {
    to_json(&value).map(Some)
}

/// \`maxNestedTags\` of xml-utils.ts's parser.
const MAX_NESTED_TAGS: usize = 100;

/// An XNode argument: the XML of the element, parsed.
fn xnode(args: Args<'_>, index: usize) -> Result<ooxml_xml::XNode, String> {
    oxnode(args, index)?.ok_or_else(|| format!("TypeError: argument {index} is missing"))
}

fn oxnode(args: Args<'_>, index: usize) -> Result<Option<ooxml_xml::XNode>, String> {
    let Some(xml) = opt::<String>(args, index)? else {
        return Ok(None);
    };
    let nodes = ooxml_xml::parse_ordered(&xml, MAX_NESTED_TAGS).map_err(|error| error.to_string())?;
    Ok(nodes.into_iter().next())
}

/// The parts of a package before a function that writes into it ran.
fn snapshot(package: &ooxml_pkg::Package) -> std::collections::HashMap<String, Vec<u8>> {
    package
        .parts()
        .iter()
        .filter(|part| !part.is_dir)
        .filter_map(|part| part.bytes().ok().map(|bytes| (part.name.clone(), bytes.to_vec())))
        .collect()
}

/// What a function changed in its package: \`[name, text | blob | null]\` per part written or removed.
fn changes(env: &mut InvokeEnv<'_>, mut before: std::collections::HashMap<String, Vec<u8>>, package: &ooxml_pkg::Package) -> Value {
    let mut out = Vec::new();
    for part in package.parts().iter().filter(|part| !part.is_dir) {
        let Ok(bytes) = part.bytes() else { continue };
        let was = before.remove(&part.name);
        if was.as_deref() == Some(bytes) {
            continue;
        }
        let content = match std::str::from_utf8(bytes) {
            Ok(text) => Value::String(text.to_owned()),
            Err(_) => env.put_blob(bytes.to_vec()),
        };
        out.push(json!([part.name, content]));
    }
    for name in before.into_keys() {
        out.push(json!([name, Value::Null]));
    }
    Value::Array(out)
}

`

export function rustTable(entries: ExportInfo[]): { text: string; rows: number; notes: string[] } {
  const notes: string[] = []
  const seen = new Map<string, ExportInfo>()
  const rows: Row[] = []
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const earlier = seen.get(e.name)
    if (earlier) {
      if (earlier.rust?.path !== e.rust?.path)
        notes.push(
          `${e.name} is exported by ${earlier.module} and ${e.module} with different ports: the first is answered`,
        )
      continue
    }
    seen.set(e.name, e)
    const row = rowOf(e, notes)
    if (row) rows.push(row)
  }
  const arms = rows
    .map((r) =>
      r.code
        ? `        ${JSON.stringify(r.name)} => ${r.fn}(env, args),`
        : `        ${JSON.stringify(r.name)} => routes::${snake(r.name)}(env, &args.resolved()?),`,
    )
    .join('\n')
  const text =
    PREAMBLE +
    `pub fn invoke(env: &mut InvokeEnv<'_>, name: &str, args: Args<'_>) -> Out {\n    match name {\n${arms}\n        _ => Err(format!("no function {name}")),\n    }\n}\n\n` +
    rows
      .map((r) => r.code)
      .filter(Boolean)
      .join('\n')
  return { text, rows: rows.length, notes }
}
