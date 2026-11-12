/**
 * `table[key]` for the table's own keys only. A plain object also answers to
 * the keys every object inherits (`constructor`, `toString`, `valueOf`,
 * `hasOwnProperty` give a function, `__proto__` gives Object.prototype), and a
 * document can name any of them where a table key is expected: an attribute
 * value, a style id, a color name, a guide name. Every table read with such a
 * value goes through here. (The same rule as docx-engine's own-value.ts.)
 */
export function ownValue<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}
