// Mutations of the arguments of a call, for functions whose input is a model
// value instead of a text. A mutation stays inside what the seeds showed: a
// value is replaced by one seen under the same key, a key is dropped where
// some seed object lacked it, added where another had it (after the keys
// every seed had before it, so an object whose type writes one order keeps
// it), and array elements are removed, repeated, swapped or taken from
// another array of the same key. So a mutated value has the types of the
// seeds, in a combination none had.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const POOL_PER_KEY = 60

const isObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What the seeds of one function hold, by the key a value sits under. */
export class ArgPool {
  private readonly values = new Map<string, Map<string, Json>>()
  private readonly objects = new Map<string, number>()
  private readonly present = new Map<string, number>()
  private readonly keys = new Map<string, Set<string>>()
  /** `context\0a\0b`: some seed object of the context held key a before key b. */
  private readonly before = new Set<string>()

  add(args: unknown): void {
    this.walk(JSON.parse(JSON.stringify(args)) as Json, '')
  }

  private keep(context: string, value: Json): void {
    const kept = this.values.get(context) ?? new Map<string, Json>()
    this.values.set(context, kept)
    const text = JSON.stringify(value)
    if (kept.size < POOL_PER_KEY && text.length < 4_000) kept.set(text, value)
  }

  private walk(value: Json, context: string): void {
    if (Array.isArray(value)) {
      for (const element of value) {
        this.keep(`${context}[]`, element)
        this.walk(element, `${context}[]`)
      }
    } else if (isObject(value)) {
      this.objects.set(context, (this.objects.get(context) ?? 0) + 1)
      const keys = this.keys.get(context) ?? new Set<string>()
      this.keys.set(context, keys)
      const earlier: string[] = []
      for (const [key, child] of Object.entries(value)) {
        keys.add(key)
        for (const other of earlier) this.before.add(`${context}\0${other}\0${key}`)
        earlier.push(key)
        const at = `${context}.${key}`
        this.present.set(at, (this.present.get(at) ?? 0) + 1)
        this.keep(at, child)
        // the key alone names what is under it: a Run is a Run wherever a `runs` holds it
        this.walk(child, key)
      }
    }
  }

  /**
   * Sets `key`, a key the object lacks, at the place the seeds give it:
   * between the keys that always came before it and those that always came
   * after. Where the seeds do not say (a pair seen in both orders or never
   * together, or the object's own keys not in that order), nothing is set: a
   * key at a place its type never writes it would differ by order alone.
   */
  private insert(object: { [key: string]: Json }, context: string, key: string, value: Json): void {
    const entries = Object.entries(object)
    const sides = entries.map(([other]) => {
      const earlier = this.before.has(`${context}\0${other}\0${key}`)
      return earlier === this.before.has(`${context}\0${key}\0${other}`) ? undefined : earlier
    })
    const at = sides.lastIndexOf(true) + 1
    if (sides.includes(undefined) || sides.indexOf(false, 0) !== (at < sides.length ? at : -1)) return
    for (const [other] of entries) delete object[other]
    entries.splice(at, 0, [key, value])
    for (const [other, kept] of entries) object[other] = kept
  }

  private pick(context: string, random: () => number): Json | undefined {
    const kept = this.values.get(context)
    if (!kept || kept.size === 0) return undefined
    const value = [...kept.values()][Math.floor(random() * kept.size)]!
    return JSON.parse(JSON.stringify(value)) as Json
  }

  private optional(context: string, key: string): boolean {
    return (this.present.get(`${context}.${key}`) ?? 0) < (this.objects.get(context) ?? 0)
  }

  /** `args` with one to three changes; `undefined` where nothing in it can change. */
  mutate(args: unknown, random: () => number): Record<string, unknown> | undefined {
    const root = JSON.parse(JSON.stringify(args)) as Json
    let changed = false
    for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits--) {
      const edit = this.edits(root, '')
      if (edit.length === 0) break
      edit[Math.floor(random() * edit.length)]!(random)
      changed = true
    }
    return changed && isObject(root) ? root : undefined
  }

  /** Every change `value` allows, each as a function that makes it. */
  private edits(value: Json, context: string): Array<(random: () => number) => void> {
    const out: Array<(random: () => number) => void> = []
    if (Array.isArray(value)) {
      const of = `${context}[]`
      if (value.length > 0) {
        out.push((random) => void value.splice(Math.floor(random() * value.length), 1))
        out.push((random) => {
          const at = Math.floor(random() * value.length)
          value.splice(at, 0, JSON.parse(JSON.stringify(value[at]!)) as Json)
        })
      }
      if (value.length > 1) {
        out.push((random) => {
          const a = Math.floor(random() * value.length)
          const b = Math.floor(random() * value.length)
          ;[value[a], value[b]] = [value[b]!, value[a]!]
        })
      }
      if (this.values.has(of)) {
        out.push((random) => {
          const element = this.pick(of, random)
          if (element !== undefined) value.splice(Math.floor(random() * (value.length + 1)), 0, element)
        })
      }
      for (const element of value) out.push(...this.edits(element, of))
    } else if (isObject(value)) {
      for (const key of Object.keys(value)) {
        const at = `${context}.${key}`
        out.push((random) => {
          const other = this.pick(at, random)
          if (other !== undefined) value[key] = other
        })
        if (this.optional(context, key)) out.push(() => void delete value[key])
        out.push(...this.edits(value[key]!, key))
      }
      for (const key of this.keys.get(context) ?? []) {
        if (key in value) continue
        out.push((random) => {
          const other = this.pick(`${context}.${key}`, random)
          if (other !== undefined) this.insert(value, context, key, other)
        })
      }
    }
    return out
  }
}
