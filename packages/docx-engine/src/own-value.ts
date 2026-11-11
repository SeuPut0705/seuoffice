/**
 * `table[key]` for the table's own keys only. A plain object also answers to
 * the keys every object inherits (`constructor`, `toString`, `valueOf`,
 * `hasOwnProperty` give a function, `__proto__` gives Object.prototype), and a
 * document can name any of them where a table key is expected: an attribute
 * value, a font name, a language tag, a zip entry name. Every table read with
 * such a value goes through here.
 */
export function ownValue<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/**
 * `record[key] = value` as an own entry, whatever the key. The plain
 * assignment stores nothing under `__proto__`: Object.prototype answers that
 * name with a setter, which swaps the record's prototype for an object (or
 * null) and ignores any other value, so an entry a document names `__proto__`
 * silently disappears. Every other inherited name is a data property, which an
 * assignment shadows the ordinary way, so only that one name is defined
 * explicitly. The record stays a plain object: Object.keys, spread and
 * JSON.stringify list the entry, and ownValue reads it back.
 */
export function setOwn<V>(record: Record<string, V>, key: string, value: V): void {
  if (key === '__proto__') {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  } else record[key] = value
}

// Copy such a record with a spread or Object.entries. Object.assign and
// `target[key] = value` in a loop send a `__proto__` entry to the setter again,
// which swaps the TARGET's prototype when the value is an object.
