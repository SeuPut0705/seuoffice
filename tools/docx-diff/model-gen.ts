// Writes the Rust model, crates/docx-engine/src/model/generated.rs, from the
// schema model-schema.ts reads out of tools/docx-diff/reference/types.ts at the
// commit of main MODEL_SOURCE pins, and from the key orders in
// model-orders.json.
//
//   tsx model-gen.ts                 write generated.rs
//   tsx model-gen.ts --sync-orders   bring model-orders.json in line with the schema first
//   tsx model-gen.ts --observe-orders FILE.ndjson...
//                                    derive model-orders.json from captured parse results
//                                    (ModelInput lines); report in out/model-orders-report.json
//   tsx model-gen.ts --out PATH      write the Rust model to PATH instead of generated.rs
//   tsx model-gen.ts --check         write nothing; exit 1 when generated.rs is stale for the
//                                    declarations at the pinned commit
// Every run refuses a model-orders.json that does not list each object type's fields once.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { builtModelInputs } from './model-built'
import {
  extractModelSchema,
  loadOrders,
  MODEL_SOURCE,
  type ModelSchema,
  ORDERS_PATH,
  type OrderTable,
  type SchemaNode,
  type TypeDef,
  walkWire,
  WireError,
} from './model-schema'
import type { ModelInput } from './model-wire'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const GENERATED_PATH = join(REPO_ROOT, 'crates/docx-engine/src/model/generated.rs')
const ORDERS_REPORT_PATH = join(HERE, 'out/model-orders-report.json')
const PRINT_WIDTH = 100
/** `wire::MAX_KEYS`: also asserted per type when the Rust compiles */
const MAX_FIELDS = 256

const RUST_KEYWORDS = new Set(
  (
    'as async await break const continue dyn else enum extern false fn for if impl in let loop ' +
    'match mod move mut pub ref return static struct trait true type unsafe use where while ' +
    'abstract become box do final gen macro override priv try typeof unsized virtual yield'
  ).split(' '),
)
const UNRAWABLE = new Set(['self', 'Self', 'super', 'crate'])
/** names the generated code uses besides its own types */
const TAKEN = new Set(
  (
    'Bytes Deserialize Deserializer False FieldKey Fields JsNum JsObject Key MapAccess MapEntries NumberRecord ' +
    'Option Result Seen Serialize SerializeMap Serializer String True Vec Visitor'
  ).split(' '),
)

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function pascal(text: string): string {
  const out = text
    .split(/[^A-Za-z0-9]+/)
    .filter((piece) => piece !== '')
    .map((piece) => piece[0]!.toUpperCase() + piece.slice(1))
    .join('')
  if (out === '') throw new Error(`no identifier in ${JSON.stringify(text)}`)
  return /^[0-9]/.test(out) ? `V${out}` : out
}

/** `Run.rPrChange.old` is `RunRPrChangeOld`; `[]` is Item, `{}` Value, `|0` V0, `[0]` I0. */
function typeName(schemaName: string): string {
  return schemaName
    .replaceAll('[]', '.Item')
    .replaceAll('{}', '.Value')
    .replace(/\|(\d+)/g, '.V$1')
    .replace(/\[(\d+)\]/g, '.I$1')
    .split('.')
    .map(pascal)
    .join('')
}

/**
 * `rawRPr` is `raw_r_pr`, `type` is `r#type`. A key the usual snake case would
 * not give back in camel case (`autoSpaceDE` as `auto_space_de`) breaks before
 * every capital instead (`auto_space_d_e`), as serde's `rename_all` reads it.
 */
function fieldName(key: string): string {
  if (!IDENTIFIER.test(key)) throw new Error(`the key ${key} is no identifier`)
  const usual = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
  const snake = macroKey(usual) === key ? usual : key.replace(/([A-Z])/g, '_$1').toLowerCase()
  if (macroKey(snake) !== key) throw new Error(`the key ${key} has no snake case that gives it back`)
  if (UNRAWABLE.has(snake)) throw new Error(`the key ${key} is reserved`)
  return RUST_KEYWORDS.has(snake) ? `r#${snake}` : snake
}

const rustString = (text: string): string => {
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error(`not printable ASCII: ${JSON.stringify(text)}`)
  return JSON.stringify(text)
}

function unique(names: string[], what: string): void {
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) throw new Error(`${what}: ${name} twice`)
    seen.add(name)
  }
}

function rustType(node: SchemaNode): string {
  switch (node.kind) {
    case 'string':
      return 'String'
    case 'number':
      return 'JsNum'
    case 'boolean':
      return 'bool'
    case 'literal':
      if (typeof node.value === 'string') {
        throw new Error(`a string literal outside a union: ${node.value}`)
      }
      return node.value ? 'True' : 'False'
    case 'ref':
      return typeName(node.name)
    case 'array':
      return `Vec<${rustType(node.element)}>`
    case 'tuple':
      return `(${node.elements.map(rustType).join(', ')})`
    case 'nullable':
    case 'undefinable':
      return `Option<${rustType(node.inner)}>`
    case 'record':
      return node.key === 'number' ? `NumberRecord<${rustType(node.value)}>` : `JsObject<${rustType(node.value)}>`
    case 'map':
      return `MapEntries<${node.key === 'string' ? 'String' : 'JsNum'}, ${rustType(node.value)}>`
    case 'bytes':
      return 'Bytes'
    case 'opaque':
      return 'serde_json::Value'
    case 'union':
      throw new Error('a union that is not a type of its own')
  }
}

type ObjectDef = Extract<TypeDef, { kind: 'object' }>

function orderOf(definition: ObjectDef, orders: OrderTable): string[] | 'input' {
  const order = orders[definition.name]
  if (order === undefined) throw new Error(`model-orders.json has no ${definition.name}`)
  return order
}

/** One struct of an object type and the bases it is composed of, outermost first. */
interface Level {
  definition: ObjectDef
  name: string
  key: string
  /** how many fields of the outermost type this level holds: its own and its bases' */
  count: number
  /** a `js_object!`: its order follows the path the TypeScript took, every field a `Slot` */
  input: boolean
  /** the field of the level above that holds this one */
  field: string
  /** the local the deserializer builds a `js_object!` level in */
  local: string
}

function levelsOf(definition: ObjectDef, schema: ModelSchema, orders: OrderTable): Level[] {
  const levels: Level[] = []
  for (let at: ObjectDef | undefined = definition; at !== undefined; ) {
    const name = typeName(at.name)
    levels.push({
      definition: at,
      name,
      key: `${name}Key`,
      count: at.fields.length,
      input: orderOf(at, orders) === 'input',
      field: fieldName(name[0]!.toLowerCase() + name.slice(1)),
      local: `b_${levels.length}`,
    })
    if (at.base === undefined) break
    const base = schema.types.get(at.base)
    if (base?.kind !== 'object') throw new Error(`${at.name}: the base ${at.base} is no object type`)
    if (base.fields.some((field, i) => at!.fields[i]?.name !== field.name)) {
      throw new Error(`${at.name}: the fields of ${at.base} do not lead its own`)
    }
    // the keys of an input-ordered type are ordered by when each was set, its base's too
    if (levels.at(-1)!.input && orderOf(base, orders) !== 'input') {
      throw new Error(`${at.name}: an input order over ${at.base}, whose order is fixed`)
    }
    at = base
  }
  return levels
}

/** The key `js_object!` writes for a field: its name in camel case, without `r#`. */
const macroKey = (rust: string): string =>
  rust.replace(/^r#/, '').replace(/_(.)/g, (_, letter: string) => letter.toUpperCase())

function objectCode(definition: ObjectDef, schema: ModelSchema, orders: OrderTable): string {
  const levels = levelsOf(definition, schema, orders)
  const { name, key, input } = levels[0]!
  const own = levels[1]?.count ?? 0
  if (definition.fields.length > MAX_FIELDS) throw new Error(`${definition.name}: too many fields`)
  const fields = definition.fields.map((field, at) => {
    const rust = fieldName(field.name)
    const holders = levels.slice(1).filter((level) => at < level.count)
    const holder = holders.at(-1) ?? levels[0]!
    const plain = rustType(field.type)
    return {
      ...field,
      rust,
      variant: pascal(field.name),
      key: rustString(field.name),
      /** a field of a `js_object!` is a `Slot` of its type: no key is an unset slot */
      slot: holder.input,
      holder,
      type: holder.input || !field.optional ? plain : `Option<${plain}>`,
      /** the place of the field, through the bases that hold it */
      access: [...holders.map((level) => level.field), rust].join('.'),
      // `v_` keeps a field named `key` or `map` from shadowing the visitor's own
      local: `v_${rust.replace(/^r#/, '')}`,
    }
  })
  unique(
    [...fields.map((field) => field.rust), ...levels.slice(1).map((level) => level.field)],
    `${definition.name} fields`,
  )
  unique(
    fields.map((field) => field.variant),
    `${definition.name} keys`,
  )
  const order = orderOf(definition, orders)
  const byName = new Map(fields.map((field) => [field.name, field]))
  const base = levels[1]
  const lines: string[] = []
  if (input && !base) {
    lines.push(
      'jscompat::js_object! {',
      `    /// \`${definition.name}\`: the keys go out in the order they were set`,
      '    #[derive(Debug, Clone, PartialEq)]',
      `    pub struct ${name} {`,
      ...fields.map((field) => `        pub ${field.rust}: ${field.type},`),
      '    }',
      '}',
      '',
    )
  } else if (input && base) {
    lines.push(
      `/// \`${definition.name}\`: the keys go out in the order they were set, those of`,
      `/// \`${base.definition.name}\` among its own`,
      '#[derive(Debug, Clone, Default, PartialEq)]',
      `pub struct ${name} {`,
      `    /// the fields of \`${base.definition.name}\`, which \`${definition.name}\` extends`,
      `    pub ${base.field}: ${base.name},`,
      ...fields.slice(own).map((field) => `    pub ${field.rust}: jscompat::Slot<${field.type}>,`),
      '}',
      '',
    )
  } else {
    // a plain struct declares its own fields in the order it writes them
    const written = order === 'input' ? [] : order.map((field) => byName.get(field)!)
    const ownFields = written.filter((field) => definition.fields.findIndex((other) => other.name === field.name) >= own)
    // a type whose required keys are all strings or arrays has an empty value:
    // `{}`, or `{ text: "" }` for a Run. Its base passes the same test, its
    // fields leading these
    const empty = definition.fields.every(
      (field) => field.optional || field.type.kind === 'string' || field.type.kind === 'array',
    )
    const derives = empty ? 'Debug, Clone, Default, PartialEq' : 'Debug, Clone, PartialEq'
    lines.push(`/// \`${definition.name}\``, `#[derive(${derives})]`, `pub struct ${name} {`)
    if (base) {
      lines.push(
        `    /// the fields of \`${base.definition.name}\`, which \`${definition.name}\` extends`,
        `    pub ${base.field}: ${base.name},`,
      )
    }
    lines.push(...ownFields.map((field) => `    pub ${field.rust}: ${field.type},`), '}', '')
  }
  if (base) {
    lines.push(
      `impl std::ops::Deref for ${name} {`,
      `    type Target = ${base.name};`,
      '',
      `    fn deref(&self) -> &${base.name} {`,
      `        &self.${base.field}`,
      '    }',
      '}',
      '',
      `impl std::ops::DerefMut for ${name} {`,
      `    fn deref_mut(&mut self) -> &mut ${base.name} {`,
      `        &mut self.${base.field}`,
      '    }',
      '}',
      '',
    )
  }
  lines.push(
    `/// The keys of \`${definition.name}\`, in declaration order.`,
    '#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]',
    `pub enum ${key} {`,
    ...fields.map((field) => `    ${field.variant},`),
    '}',
    '',
    `impl FieldKey for ${key} {`,
    `    const NAMES: &'static [&'static str] = &[${fields.map((field) => field.key).join(', ')}];`,
    '',
    '    fn from_name(name: &str) -> Option<Self> {',
    '        match name {',
    ...fields.map((field) => `            ${field.key} => Some(Self::${field.variant}),`),
    '            _ => None,',
    '        }',
    '    }',
    '',
    '    fn index(self) -> usize {',
    '        self as usize',
    '    }',
    '}',
    '',
    `const _: () = assert!(${key}::NAMES.len() <= wire::MAX_KEYS);`,
    '',
  )
  /** where the deserializer sets a slot: through the whole value, or the local of its base */
  const slotOf = (field: (typeof fields)[number]): string =>
    input ? `b_0.${field.access}` : `${field.holder.local}.${field.rust}`
  if (input && base) {
    lines.push(
      `impl Serialize for ${name} {`,
      '    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {',
      `        let mut keys: Vec<(u64, ${key})> = Vec::new();`,
      ...fields.map(
        (field) =>
          `        if let Some(at) = self.${field.access}.set_at() { keys.push((at, ${key}::${field.variant})); }`,
      ),
      '        keys.sort_unstable_by_key(|&(at, _)| at);',
      '        let mut map = serializer.serialize_map(None)?;',
      '        for (_, key) in keys {',
      '            match key {',
      ...fields.map(
        (field) =>
          `                ${key}::${field.variant} => if let Some(value) = &*self.${field.access} { map.serialize_entry(${field.key}, value)?; },`,
      ),
      '            }',
      '        }',
      '        map.end()',
      '    }',
      '}',
      '',
    )
  }
  if (order !== 'input') {
    lines.push(
      `impl Serialize for ${name} {`,
      '    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {',
      '        let mut map = serializer.serialize_map(None)?;',
    )
    for (const field of order.map((written) => byName.get(written)!)) {
      if (field.slot || field.optional) {
        lines.push(
          `        if let Some(value) = ${field.slot ? '&*' : '&'}self.${field.access} {`,
          `            map.serialize_entry(${field.key}, value)?;`,
          '        }',
        )
      } else {
        lines.push(`        map.serialize_entry(${field.key}, &self.${field.access})?;`)
      }
    }
    lines.push('        map.end()', '    }', '}', '')
  }
  lines.push(
    `impl<'de> Deserialize<'de> for ${name} {`,
    "    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
    '        struct Fields;',
    "        impl<'de> Visitor<'de> for Fields {",
    `            type Value = ${name};`,
    '',
    '            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {',
    `                formatter.write_str(${rustString(`an object: ${definition.name}`)})`,
    '            }',
    '',
    `            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<${name}, A::Error> {`,
    '                let mut seen = Seen::default();',
    ...(input
      ? [`                let mut b_0 = ${name}::default();`]
      : levels
          .filter((level) => level.input)
          .map((level) => `                let mut ${level.local} = ${level.name}::default();`)),
    ...fields.filter((field) => !field.slot).map((field) => `                let mut ${field.local} = None;`),
    `                while let Some(Key(key)) = map.next_key::<Key<${key}>>()? {`,
    '                    let Some(key) = key else {',
    '                        map.next_value::<serde::de::IgnoredAny>()?;',
    '                        continue;',
    '                    };',
    '                    if !seen.insert(key.index()) {',
    '                        return Err(A::Error::duplicate_field(key.name()));',
    '                    }',
    '                    match key {',
    ...fields.map((field) =>
      field.slot
        ? `                        ${key}::${field.variant} => ${slotOf(field)}.set(map.next_value()?),`
        : `                        ${key}::${field.variant} => ${field.local} = Some(map.next_value()?),`,
    ),
    '                    }',
    '                }',
  )
  for (const field of fields.filter((candidate) => candidate.slot && !candidate.optional)) {
    lines.push(
      `                if !${slotOf(field)}.has_key() {`,
      `                    return Err(A::Error::missing_field(${field.key}));`,
      '                }',
    )
  }
  const value = (field: (typeof fields)[number]): string =>
    field.optional ? field.local : `${field.local}.ok_or_else(|| A::Error::missing_field(${field.key}))?`
  /** a level as an expression: the local of a `js_object!`, else a struct expression with its bases nested */
  const expression = (at: number): string => {
    const level = levels[at]!
    if (level.input) return level.local
    const inner = levels[at + 1]
    const entries = [
      ...(inner ? [`${inner.field}: ${expression(at + 1)}`] : []),
      ...fields.slice(inner?.count ?? 0, level.count).map((field) => `${field.rust}: ${value(field)}`),
    ]
    return `${level.name} { ${entries.join(', ')} }`
  }
  lines.push(
    `                Ok(${expression(0)})`,
    '            }',
    '        }',
    '        deserializer.deserialize_map(Fields)',
    '    }',
    '}',
  )
  return lines.join('\n')
}

function enumCode(definition: Extract<TypeDef, { kind: 'enum' }>): string {
  const name = typeName(definition.name)
  const variants = definition.values.map((value) => ({ value: rustString(value), variant: pascal(value) }))
  unique(
    variants.map((variant) => variant.variant),
    `${definition.name} variants`,
  )
  return [
    `/// \`${definition.name}\``,
    '#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]',
    `pub enum ${name} {`,
    ...variants.flatMap(({ value, variant }) => [`    #[serde(rename = ${value})]`, `    ${variant},`]),
    '}',
    '',
    `impl ${name} {`,
    '    /// The string the TypeScript holds.',
    "    pub fn as_str(self) -> &'static str {",
    '        match self {',
    ...variants.map(({ value, variant }) => `            Self::${variant} => ${value},`),
    '        }',
    '    }',
    '}',
    '',
    `impl<'de> Deserialize<'de> for ${name} {`,
    "    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
    `        wire::string_enum(deserializer, ${rustString(definition.name)}, |text| match text {`,
    ...variants.map(({ value, variant }) => `            ${value} => Some(Self::${variant}),`),
    '            _ => None,',
    '        })',
    '    }',
    '}',
  ].join('\n')
}

interface Variant {
  variant: string
  payload?: string
  /** an expression over `value: &serde_json::Value` giving `Option<Self>` */
  read: string
  /** the arm of `serialize` */
  write: string
}

function variantOf(node: SchemaNode): Variant {
  const payload = (type: string, variant: string): Variant => ({
    variant,
    payload: type,
    read: `${type}::deserialize(value).ok().map(Self::${variant})`,
    write: `Self::${variant}(inner) => inner.serialize(serializer)`,
  })
  switch (node.kind) {
    case 'literal': {
      if (typeof node.value !== 'string') throw new Error('a boolean literal in a union')
      const variant = pascal(node.value)
      const value = rustString(node.value)
      return {
        variant,
        read: `(value.as_str() == Some(${value})).then_some(Self::${variant})`,
        write: `Self::${variant} => serializer.serialize_str(${value})`,
      }
    }
    case 'boolean':
      return payload('bool', 'Bool')
    case 'string':
      return payload('String', 'String')
    case 'number':
      return payload('JsNum', 'Number')
    case 'ref':
      return payload(typeName(node.name), typeName(node.name))
    default:
      throw new Error(`a ${node.kind} in a union`)
  }
}

function aliasCode(definition: Extract<TypeDef, { kind: 'alias' }>): string {
  const name = typeName(definition.name)
  if (definition.type.kind !== 'union') {
    return [`/// \`${definition.name}\``, `pub type ${name} = ${rustType(definition.type)};`].join('\n')
  }
  const variants = definition.type.variants.map(variantOf)
  unique(
    variants.map((variant) => variant.variant),
    `${definition.name} variants`,
  )
  return [
    `/// \`${definition.name}\`: exactly one variant reads a value.`,
    '#[derive(Debug, Clone, PartialEq)]',
    `pub enum ${name} {`,
    ...variants.map((variant) =>
      variant.payload ? `    ${variant.variant}(${variant.payload}),` : `    ${variant.variant},`,
    ),
    '}',
    '',
    `impl Serialize for ${name} {`,
    '    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {',
    '        match self {',
    ...variants.map((variant) => `            ${variant.write},`),
    '        }',
    '    }',
    '}',
    '',
    `impl<'de> Deserialize<'de> for ${name} {`,
    "    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
    '        let value = &serde_json::Value::deserialize(deserializer)?;',
    `        wire::one_of(${rustString(definition.name)}, [`,
    ...variants.map((variant) => `            ${variant.read},`),
    '        ])',
    '    }',
    '}',
  ].join('\n')
}

/** The Rust source of the model. */
export function generate(schema: ModelSchema, orders: OrderTable): string {
  const definitions = [...schema.types.values()]
  const names = definitions.map((definition) => typeName(definition.name))
  const keys = definitions
    .filter((definition) => definition.kind === 'object')
    .map((definition) => `${typeName(definition.name)}Key`)
  unique([...names, ...keys, ...TAKEN], 'Rust type names')
  const blocks = definitions.map((definition) => {
    switch (definition.kind) {
      case 'object':
        return objectCode(definition, schema, orders)
      case 'enum':
        return enumCode(definition)
      case 'alias':
        return aliasCode(definition)
    }
  })
  const used = new Set(blocks.join('\n').match(/\b(?:Bytes|False|JsObject|MapEntries|NumberRecord|True)\b/g))
  const wire = ['self', 'FieldKey', 'Key', 'Seen', ...['Bytes', 'False', 'MapEntries', 'NumberRecord', 'True'].filter((name) => used.has(name))]
  const jscompat = ['JsNum', ...(used.has('JsObject') ? ['JsObject'] : [])]
  const dispatch = definitions.map(
    (definition) =>
      `        ${rustString(definition.name)} => wire::round_trip::<${typeName(definition.name)}>(json),`,
  )
  return [
    '//! Generated by `tools/docx-diff/model-gen.ts` from `packages/docx-engine/src/types.ts`',
    '//! and `tools/docx-diff/model-orders.json`. Do not edit: run the generator.',
    '',
    '#![allow(clippy::enum_variant_names, clippy::large_enum_variant)]',
    '',
    'use std::fmt;',
    '',
    `use jscompat::{${jscompat.join(', ')}};`,
    'use serde::de::{Error as _, MapAccess, Visitor};',
    'use serde::ser::SerializeMap;',
    'use serde::{Deserialize, Deserializer, Serialize, Serializer};',
    '',
    `use super::wire::{${wire.join(', ')}};`,
    '',
    ...blocks.flatMap((block) => [block, '']),
    '/// Reads `json` as the model type the schema names `type_name` (an anonymous',
    '/// type by its path, `Run.rPrChange`) and writes it again.',
    'pub fn round_trip(type_name: &str, json: &str) -> Result<String, String> {',
    '    match type_name {',
    ...dispatch,
    '        _ => Err(format!("no model type {type_name}")),',
    '    }',
    '}',
    '',
  ].join('\n')
}

/** What is wrong with the order table for this schema. */
function orderProblems(schema: ModelSchema, orders: OrderTable): string[] {
  const problems: string[] = []
  const objects = new Map(
    [...schema.types.values()]
      .filter((definition) => definition.kind === 'object')
      .map((definition) => [definition.name, definition]),
  )
  for (const name of Object.keys(orders)) {
    if (!objects.has(name)) problems.push(`${name}: no such object type`)
  }
  for (const definition of objects.values()) {
    const order = orders[definition.name]
    if (order === undefined) {
      problems.push(`${definition.name}: no order`)
      continue
    }
    if (order === 'input') continue
    const fields = definition.fields.map((field) => field.name)
    if (order.length !== fields.length || [...order].sort().join() !== [...fields].sort().join()) {
      problems.push(`${definition.name}: the order does not list its fields once each`)
    }
  }
  return problems
}

/** The table with every object type: new types in declaration order, new fields last, gone ones dropped. */
function syncOrders(schema: ModelSchema, orders: OrderTable): OrderTable {
  const out: OrderTable = {}
  for (const definition of schema.types.values()) {
    if (definition.kind !== 'object') continue
    const fields = definition.fields.map((field) => field.name)
    const order = orders[definition.name]
    if (order === 'input') {
      out[definition.name] = 'input'
      continue
    }
    const kept = (order ?? []).filter((field) => fields.includes(field))
    out[definition.name] = [...kept, ...fields.filter((field) => !kept.includes(field))]
  }
  return out
}

/** model-orders.json as prettier writes it: an array on one line where it fits. */
function formatOrders(orders: OrderTable): string {
  const entries = Object.entries(orders)
  const lines = entries.map(([name, order], at) => {
    const comma = at < entries.length - 1 ? ',' : ''
    const head = `  ${JSON.stringify(name)}: `
    if (order === 'input') return `${head}"input"${comma}`
    const flat = `${head}[${order.map((field) => JSON.stringify(field)).join(', ')}]${comma}`
    if (flat.length <= PRINT_WIDTH) return flat
    return [`${head}[`, ...order.map((field, i) => `    ${JSON.stringify(field)}${i < order.length - 1 ? ',' : ''}`), `  ]${comma}`].join('\n')
  })
  return ['{', ...lines, '}', ''].join('\n')
}

type Source = 'parser' | 'built'

/** Every key order each object type was met in, by where the value came from. */
class Sequences {
  readonly seen = new Map<string, Record<Source, Set<string>>>()
  readonly refused: Record<Source, string[]> = { parser: [], built: [] }
  readonly values: Record<Source, number> = { parser: 0, built: 0 }

  constructor(private readonly schema: ModelSchema) {}

  add(input: ModelInput, source: Source): void {
    this.values[source]++
    try {
      walkWire(this.schema, input.type, JSON.parse(input.json), ({ type: object, keys }) => {
        let sets = this.seen.get(object)
        if (!sets) {
          sets = { parser: new Set(), built: new Set() }
          this.seen.set(object, sets)
        }
        sets[source].add(JSON.stringify(keys))
      })
    } catch (error) {
      if (!(error instanceof WireError)) throw error
      this.refused[source].push(`${input.where}: ${error.message}`)
    }
  }

  of(type: string, sources: readonly Source[]): string[][] {
    const sets = this.seen.get(type)
    return sources.flatMap((source) => [...(sets?.[source] ?? [])].map((keys) => JSON.parse(keys) as string[]))
  }
}

/**
 * One order of the fields that keeps every pair the sequences show, the
 * declaration order deciding where they show none; undefined where the pairs
 * form a cycle. Also the pairs met both ways.
 */
function mergeOrder(fields: readonly string[], sequences: readonly string[][]): {
  order: string[] | undefined
  conflicts: string[][]
} {
  const before = new Map(fields.map((field) => [field, new Set<string>()]))
  for (const sequence of sequences) {
    sequence.forEach((field, at) => {
      for (const earlier of sequence.slice(0, at)) before.get(field)!.add(earlier)
    })
  }
  const conflicts = fields.flatMap((field, at) =>
    fields.slice(at + 1).filter((other) => before.get(field)!.has(other) && before.get(other)!.has(field)).map((other) => [field, other]),
  )
  const left = new Set(fields)
  const order: string[] = []
  while (left.size > 0) {
    const next = [...left].find((field) => ![...before.get(field)!].some((earlier) => left.has(earlier)))
    if (next === undefined) return { order: undefined, conflicts }
    order.push(next)
    left.delete(next)
  }
  return { order, conflicts }
}

/**
 * The order table the parser's values give. Only captured parseDocx results
 * vote: a type their key orders agree on gets that order, one they disagree
 * on is "input", and a field (or a type) they never show keeps its place in
 * the declaration, which nothing has verified. Schema-built values count in
 * the report as field coverage only: they are built by the gate, not by the
 * TypeScript, so their key order proves nothing about it.
 */
async function observeOrders(schema: ModelSchema, paths: readonly string[]): Promise<{ orders: OrderTable; report: object }> {
  const sequences = new Sequences(schema)
  for (const path of paths) {
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
      if (line) sequences.add(JSON.parse(line) as ModelInput, 'parser')
    }
  }
  for (const input of builtModelInputs(schema)) sequences.add(input, 'built')
  const orders: OrderTable = {}
  const types: Record<string, object> = {}
  const totals = {
    types: 0,
    fixedByParser: 0,
    input: 0,
    declarationUnverified: 0,
    fields: 0,
    parserFields: 0,
    builtOnlyFields: 0,
    unobservedFields: 0,
  }
  for (const definition of schema.types.values()) {
    if (definition.kind !== 'object') continue
    const fields = definition.fields.map((field) => field.name)
    const parser = sequences.of(definition.name, ['parser'])
    const merged = mergeOrder(fields, parser)
    const inParser = new Set(parser.flat())
    const inBuilt = new Set(sequences.of(definition.name, ['built']).flat())
    const builtOnly = fields.filter((field) => inBuilt.has(field) && !inParser.has(field))
    const unobserved = fields.filter((field) => !inParser.has(field) && !inBuilt.has(field))
    orders[definition.name] = merged.order ?? 'input'
    const producerOrder =
      merged.order === undefined ? 'input' : parser.length === 0 ? 'declaration-unverified' : 'parser'
    totals.types++
    totals.fields += fields.length
    totals.parserFields += inParser.size
    totals.builtOnlyFields += builtOnly.length
    totals.unobservedFields += unobserved.length
    if (producerOrder === 'parser') totals.fixedByParser++
    if (producerOrder === 'input') totals.input++
    if (producerOrder === 'declaration-unverified') totals.declarationUnverified++
    types[definition.name] = {
      /** 'parser': fixed, from parseDocx results; 'input': they disagree; 'declaration-unverified': no parse result has the type */
      producerOrder,
      parserSequences: parser.length,
      fields: fields.length,
      parserFields: inParser.size,
      /** no parse result shows them: placed by the declaration among the observed ones, unverified */
      unobservedFieldOrder: fields.filter((field) => !inParser.has(field)),
      /** shown by schema-built values only: covered by the round trip, not by the parser */
      builtOnlyFields: builtOnly,
      /** shown by no value at all */
      unobservedFields: unobserved,
      conflicts: merged.conflicts.slice(0, 10),
    }
  }
  const report = {
    inputs: sequences.values,
    refused: sequences.refused,
    totals,
    types,
  }
  return { orders, report }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const observeAt = argv.indexOf('--observe-orders')
  const after = observeAt < 0 ? [] : argv.slice(observeAt + 1)
  const end = after.findIndex((arg) => arg.startsWith('--'))
  const observed = end < 0 ? after : after.slice(0, end)
  const outAt = argv.indexOf('--out')
  const out = outAt < 0 ? GENERATED_PATH : resolve(argv[outAt + 1] ?? '')
  if (outAt >= 0 && argv[outAt + 1] === undefined) throw new Error('--out takes a path')
  for (const arg of argv) {
    const known = ['--check', '--sync-orders', '--observe-orders', '--out', ...observed]
    if (!known.includes(arg) && arg !== argv[outAt + 1]) throw new Error(`unknown option ${arg}`)
  }
  if (observeAt >= 0 && observed.length === 0) throw new Error('--observe-orders takes the model input files')
  const args = new Set(argv)
  const check = args.has('--check')
  if (check && (observeAt >= 0 || outAt >= 0)) throw new Error('--check writes nothing: leave out --observe-orders and --out')
  const schema = extractModelSchema()
  const stale: string[] = []

  let orders = (existsSync(ORDERS_PATH) ? loadOrders() : {}) as OrderTable
  if (observeAt >= 0) {
    const result = await observeOrders(schema, observed)
    orders = result.orders
    mkdirSync(dirname(ORDERS_REPORT_PATH), { recursive: true })
    writeFileSync(ORDERS_REPORT_PATH, `${JSON.stringify(result.report, null, 2)}\n`)
    writeFileSync(ORDERS_PATH, formatOrders(orders))
    console.log(`orders observed; report: ${ORDERS_REPORT_PATH}`)
  }
  if (args.has('--sync-orders')) {
    orders = syncOrders(schema, orders)
    if (!check) writeFileSync(ORDERS_PATH, formatOrders(orders))
  }
  const problems = orderProblems(schema, orders)
  if (problems.length > 0) {
    throw new Error(`model-orders.json is out of line with the schema (run --sync-orders):\n${problems.join('\n')}`)
  }

  const source = generate(schema, orders)
  if (check) {
    const current = existsSync(GENERATED_PATH) ? readFileSync(GENERATED_PATH, 'utf8') : ''
    if (current.replaceAll('\r\n', '\n') !== source) {
      stale.push(`${GENERATED_PATH} is stale for the declarations at ${MODEL_SOURCE.commit}`)
    }
  } else {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, source)
  }
  if (stale.length > 0) {
    console.error(stale.join('\n'))
    process.exit(1)
  }
  const objects = [...schema.types.values()].filter((definition) => definition.kind === 'object').length
  console.log(`declarations of ${MODEL_SOURCE.ref} at ${MODEL_SOURCE.commit}`)
  console.log(`${schema.types.size} model types (${objects} objects): ${check ? 'up to date' : 'written'}`)
}

await main()
