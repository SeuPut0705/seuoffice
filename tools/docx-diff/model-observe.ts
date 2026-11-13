import { createHash } from 'node:crypto'
import { extractModelSchema, walkWire, WireError, type ModelSchema, type ObjectVisit } from './model-schema'
import type { ModelInput } from './model-wire'

export interface FieldCount {
  values: number
  nulls: number
  distinct: Set<string>
}

export class ModelCoverage {
  readonly fields = new Map<string, FieldCount>()
  readonly refused: Array<{ where: string; error: string }> = []
  constructor(readonly schema: ModelSchema = extractModelSchema()) {
    for (const [name, type] of schema.types) {
      if (type.kind === 'object') {
        for (const field of type.fields) {
          this.fields.set(`${name}.${field.name}`, { values: 0, nulls: 0, distinct: new Set() })
        }
      }
    }
  }

  observe(input: ModelInput): void {
    const value: unknown = JSON.parse(input.json)
    const object = ({ type, keys, value: current }: ObjectVisit): void => {
      for (const key of keys) {
        const tally = this.fields.get(`${type}.${key}`)
        if (!tally) throw new Error(`schema visitor emitted unknown field ${type}.${key}`)
        const inner = current[key]
        tally.values++
        if (inner === null) tally.nulls++
        tally.distinct.add(createHash('sha256').update(JSON.stringify(inner)).digest('hex'))
      }
    }
    try {
      walkWire(this.schema, input.type, value, object)
    } catch (error) {
      if (!(error instanceof WireError)) throw error
      this.refused.push({ where: input.where, error: String(error) })
    }
  }

  report(): object {
    return {
      fields: Object.fromEntries([...this.fields].map(([name, tally]) => [name, {
        values: tally.values, nulls: tally.nulls, distinct: tally.distinct.size,
      }])),
      unobserved: [...this.fields].filter(([, tally]) => tally.values === 0).map(([name]) => name),
      refused: this.refused,
    }
  }
}
