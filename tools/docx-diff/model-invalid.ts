// Model values the Rust must refuse, each one valid built value
// (model-built.ts) with one thing broken: an unknown key, a required key
// missing, null where the type takes none, a value of another JSON kind that
// the schema (walkWire) refuses, a string no enum holds, an enum written as
// an object, a key twice, base64 with padding bits set, and one text that is
// no JSON.
import { builtModelInputs } from './model-built'
import { extractModelSchema, type ModelSchema, type SchemaNode, walkWire, WireError } from './model-schema'
import type { ModelInput } from './model-wire'

const UNKNOWN = '__modelUnknown'
/** One value of every JSON kind: whichever the schema refuses for a field, the Rust must refuse. */
const OTHER_KINDS: Array<[string, unknown]> = [
  ['number', 0], ['string', ''], ['true', true], ['false', false], ['array', []], ['object', {}],
  ['array of string', ['']], ['object of null', { [UNKNOWN]: null }],
]

export function invalidModelInputs(schema: ModelSchema = extractModelSchema()): ModelInput[] {
  const built = new Map(builtModelInputs(schema).map((input) => [input.where, input.json]))
  const inputs: ModelInput[] = []
  const refuse = (where: string, type: string, json: string): void => {
    inputs.push({ where: `invalid ${where}`, population: 'mutated', type, json, expect: 'refuse' })
  }

  const takesNull = (node: SchemaNode): boolean => {
    switch (node.kind) {
      case 'number': case 'nullable': case 'undefinable': case 'opaque': return true
      case 'union': return node.variants.some(takesNull)
      case 'ref': {
        const type = schema.types.get(node.name)
        return type?.kind === 'alias' ? takesNull(type.type) : false
      }
      default: return false
    }
  }
  const bytesField = (node: SchemaNode): boolean =>
    node.kind === 'bytes' || ((node.kind === 'nullable' || node.kind === 'undefinable') && bytesField(node.inner))
  const schemaRefuses = (type: string, value: unknown): boolean => {
    try {
      walkWire(schema, type, value, () => {})
      return false
    } catch (error) {
      if (error instanceof WireError) return true
      throw error
    }
  }

  for (const [name, type] of schema.types) {
    if (type.kind === 'enum') {
      refuse(`${name} unknown value`, name, JSON.stringify(UNKNOWN))
      // the form serde's derived reader takes for a unit variant
      refuse(`${name} as object`, name, JSON.stringify({ [type.values[0]!]: null }))
      refuse(`${name} as array`, name, JSON.stringify([type.values[0]!]))
      continue
    }
    if (type.kind !== 'object') continue
    const minimal = built.get(`built ${name} 0`)
    if (minimal === undefined) continue
    const base = JSON.parse(minimal) as Record<string, unknown>

    // spliced into the text so every other byte of the valid value stays
    refuse(`${name} unknown key`, name,
      minimal === '{}' ? `{"${UNKNOWN}":1}` : `${minimal.slice(0, -1)},"${UNKNOWN}":1}`)

    for (const field of type.fields) {
      if (!field.optional && field.name in base) {
        const { [field.name]: _dropped, ...rest } = base
        refuse(`${name}.${field.name} missing`, name, JSON.stringify(rest))
      }
      const present = built.get(`built ${name}.${field.name} present`)
      if (present === undefined) continue
      const withField = JSON.parse(present) as Record<string, unknown>
      if (field.type.kind !== 'opaque' && !takesNull(field.type)) {
        refuse(`${name}.${field.name} null`, name, JSON.stringify({ ...withField, [field.name]: null }))
      }
      for (const [kind, other] of OTHER_KINDS) {
        const candidate = { ...withField, [field.name]: other }
        if (schemaRefuses(name, candidate)) {
          refuse(`${name}.${field.name} as ${kind}`, name, JSON.stringify(candidate))
        }
      }
      if (bytesField(field.type)) {
        // padding bits set, which Buffer never writes: each of the four bits '==' leaves unused, each of the two of '='
        for (const base64 of ['AP8BgB==', 'AP8BgC==', 'AP8BgE==', 'AP8BgI==', 'YWJ=', 'YWK=']) {
          refuse(`${name}.${field.name} bytes padding ${base64}`, name,
            JSON.stringify({ ...withField, [field.name]: { $bytes: base64 } }))
        }
      }
    }

    // a key twice in one object of a type read directly (a union takes the last one, as JSON.parse does)
    const keyed = Object.keys(base).length > 0
      ? minimal
      : type.fields.map((field) => built.get(`built ${name}.${field.name} present`)).find((json) => json !== undefined)
    if (keyed !== undefined && keyed !== '{}') {
      const [key, value] = Object.entries(JSON.parse(keyed) as Record<string, unknown>)[0]!
      refuse(`${name} duplicate ${key}`, name, `{${JSON.stringify(key)}:${JSON.stringify(value)},${keyed.slice(1)}`)
    }
  }

  const root = built.get(`built ${schema.root} 0`)
  if (root !== undefined) refuse(`${schema.root} malformed`, schema.root, root.slice(0, -1))
  return inputs
}
