import { describe, expect, it } from 'vitest'
import { Encoder, decode, encode, frame, unframe } from '../../crates/shell/bridge/wire.ts'

/** the value crates/shell-core/src/wire.rs's `every_kind` builds */
const everyKind = {
  u: undefined,
  n: null,
  t: true,
  int: 42,
  frac: 0.1,
  big: 1e300,
  nan: NaN,
  inf: Infinity,
  ninf: -Infinity,
  nzero: -0,
  s: '한글 😀',
  u8: new Uint8Array([0, 1, 255]),
  ab: new ArrayBuffer(0),
  date: new Date(1_794_452_400_000),
  'bad-date': new Date(NaN),
  list: [undefined, 1],
  dollar: { $: 'u', z: null, a: null },
}

describe('wire', () => {
  it('writes the header the Rust codec writes', () => {
    const { header, buffers } = encode(everyKind)
    // the same line as `header_text_is_the_contract_s` in wire.rs
    expect(JSON.stringify(header)).toBe(
      '{"u":{"$":"u"},"n":null,"t":true,"int":42,"frac":0.1,"big":1e+300,"nan":{"$":"n","v":"NaN"},"inf":{"$":"n","v":"Infinity"},"ninf":{"$":"n","v":"-Infinity"},"nzero":{"$":"n","v":"-0"},"s":"한글 😀","u8":{"$":"b","k":"u8","i":0},"ab":{"$":"b","k":"ab","i":1},"date":{"$":"d","v":1794452400000},"bad-date":{"$":"d","v":{"$":"n","v":"NaN"}},"list":[{"$":"u"},1],"dollar":{"$":"o","v":{"$":"u","z":null,"a":null}}}',
    )
    expect(buffers.map((b) => [...b])).toEqual([[0, 1, 255], []])
  })

  it('reads back what it wrote, through a frame', () => {
    const { header, buffers } = encode(everyKind)
    const back = unframe(frame(header, buffers))
    const value = decode(back.header, back.buffers) as Record<string, unknown>
    expect(Object.is(value.nzero, -0)).toBe(true)
    expect(Number.isNaN(value.nan)).toBe(true)
    expect(value.u8).toBeInstanceOf(Uint8Array)
    expect(value.ab).toBeInstanceOf(ArrayBuffer)
    expect((value.date as Date).getTime()).toBe(1_794_452_400_000)
    expect('u' in value && value.u === undefined).toBe(true)
    expect(value.dollar).toEqual({ $: 'u', z: null, a: null })
  })

  it('refuses what the structured clone of the renderers does not carry', () => {
    for (const v of [new Map(), new Set(), new Float32Array(1), () => 1, Symbol('x'), 1n]) {
      expect(() => new Encoder().value(v)).toThrow()
    }
  })

  it('refuses a cut frame', () => {
    const bytes = frame([], [new Uint8Array([1, 2, 3])])
    for (let cut = 0; cut < bytes.length; cut++)
      expect(() => unframe(bytes.subarray(0, cut))).toThrow()
  })
})
