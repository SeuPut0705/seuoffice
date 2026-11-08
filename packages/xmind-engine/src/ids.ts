const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'))

/**
 * A new identifier for a sheet, topic, summary, boundary or relationship: a
 * lower-case version 4 UUID, the shape the format uses for all of them.
 *
 * Built from `getRandomValues` rather than `randomUUID`, which browsers only
 * offer in a secure context; the engine also runs in renderer windows.
 */
export function newXmindId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => HEX[byte]!)
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}
