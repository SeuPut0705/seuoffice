import {
  extractModelSchema,
  loadOrders,
  type ModelSchema,
  type SchemaNode,
  type TypeDef,
} from './model-schema'
import { modelJson, type ModelInput } from './model-wire'

class RecursiveField extends Error {}

/** Values built independently of Rust serialization, covering fields absent from documents. */
export function builtModelInputs(schema: ModelSchema = extractModelSchema()): ModelInput[] {
  const inputs: ModelInput[] = []
  const orders = loadOrders()
  const objectOf = (type: string, entries: Array<[string, unknown]>): Record<string, unknown> => {
    const order = orders[type]
    if (!order) throw new Error(`no committed order for ${type}`)
    if (order === 'input') return Object.fromEntries(entries)
    const values = new Map(entries)
    return Object.fromEntries(
      order.filter((key) => values.has(key)).map((key) => [key, values.get(key)]),
    )
  }
  const valueOf = (node: SchemaNode, variant: number, stack: ReadonlySet<string>): unknown => {
    switch (node.kind) {
      case 'string':
        return variant % 2 === 0 ? '' : 'A&<"\t\n\u{1f600}'
      // 2^53 is the last integer written digit for digit; 2^55 is written as its shortest round-trip digits
      case 'number':
        return [0, -2.5, 1e21, 1e-7, 9_007_199_254_740_992, 36_028_797_018_963_968][variant % 6]
      case 'boolean':
        return variant % 2 !== 0
      case 'literal':
        return node.value
      case 'ref': {
        const type = schema.types.get(node.name)
        if (!type) throw new Error(`no schema type ${node.name}`)
        if (stack.has(node.name)) throw new RecursiveField(`recursive required field ${node.name}`)
        return definitionValue(type, variant, new Set([...stack, node.name]))
      }
      case 'array': {
        if (stack.size > 6 || variant % 3 === 0) return []
        try {
          return [valueOf(node.element, variant, stack)]
        } catch (error) {
          if (!(error instanceof RecursiveField)) throw error
          return []
        }
      }
      case 'tuple':
        return node.elements.map((element) => valueOf(element, variant, stack))
      case 'nullable':
      case 'undefinable':
        return variant % 3 === 0 ? null : valueOf(node.inner, variant, stack)
      case 'map':
        return variant % 3 === 0
          ? []
          : [
              [node.key === 'string' ? '__proto__' : 10, valueOf(node.value, variant, stack)],
              [node.key === 'string' ? '2' : 2, valueOf(node.value, variant + 1, stack)],
            ]
      case 'record': {
        if (variant % 3 === 0 || stack.size > 6) return {}
        const item = valueOf(node.value, variant, stack)
        return Object.fromEntries(
          (node.key === 'number' ? ['10', '2', '-1'] : ['z', '10', '__proto__', '2', '01']).map(
            (key) => [key, item],
          ),
        )
      }
      // one padding character and two: the unused bits differ (2 and 4)
      case 'bytes':
        return { $bytes: ['', 'AP8BgA==', 'YWI='][variant % 3] }
      case 'opaque':
        return { z: variant, a: null }
      case 'union':
        return valueOf(node.variants[variant % node.variants.length]!, variant, stack)
    }
  }
  const definitionValue = (type: TypeDef, variant: number, stack: ReadonlySet<string>): unknown => {
    if (type.kind === 'enum') return type.values[variant % type.values.length]
    if (type.kind === 'alias') return valueOf(type.type, variant, stack)
    const entries: Array<[string, unknown]> = []
    for (const field of type.fields) {
      if (field.optional && (variant === 0 || stack.size > 5)) continue
      try {
        entries.push([field.name, valueOf(field.type, variant, stack)])
      } catch (error) {
        if (!(error instanceof RecursiveField) || !field.optional) throw error
      }
    }
    return objectOf(type.name, entries)
  }
  for (const [name, type] of schema.types) {
    for (let variant = 0; variant < 6; variant++) {
      inputs.push({
        where: `built ${name} ${variant}`,
        population: 'built',
        type: name,
        json: modelJson(definitionValue(type, variant, new Set([name]))),
      })
    }
    if (type.kind === 'object') {
      const minimal = definitionValue(type, 0, new Set([name])) as Record<string, unknown>
      for (const field of type.fields) {
        const add = (tag: string, value: unknown): void => {
          inputs.push({
            where: `built ${name}.${field.name} ${tag}`,
            population: 'built',
            type: name,
            json: modelJson(objectOf(type.name, [...Object.entries(minimal), [field.name, value]])),
          })
        }
        try {
          add('present', valueOf(field.type, 1, new Set([name])))
        } catch (error) {
          if (!(error instanceof RecursiveField)) throw error
        }
        if (field.type.kind === 'nullable') add('null', null)
        if (field.type.kind === 'number') {
          for (const number of [NaN, Infinity, -Infinity, -0]) add(String(number), number)
        }
        if (field.type.kind === 'map' && field.type.key === 'number') {
          const item = valueOf(field.type.value, 1, new Set([name]))
          add(
            'nonfinite keys',
            [NaN, Infinity, -Infinity].map((key) => [key, item]),
          )
        }
      }
    }
  }
  return inputs
}
