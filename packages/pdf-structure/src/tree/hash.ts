/**
 * Synchronous SHA-256 (FIPS 180-4) over byte chunks. Pure JS so the tree
 * builder stays free of node:crypto and of async Web Crypto — fingerprints
 * are computed inside the synchronous PDFium document scope.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** incremental SHA-256: update() any number of chunks, then hex() once */
export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly block = new Uint8Array(64)
  private readonly w = new Uint32Array(64)
  private blockLen = 0
  private totalLen = 0

  update(data: Uint8Array | string): this {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    this.totalLen += bytes.length
    let i = 0
    while (i < bytes.length) {
      const take = Math.min(64 - this.blockLen, bytes.length - i)
      this.block.set(bytes.subarray(i, i + take), this.blockLen)
      this.blockLen += take
      i += take
      if (this.blockLen === 64) {
        this.compress()
        this.blockLen = 0
      }
    }
    return this
  }

  hex(): string {
    const bitLen = this.totalLen * 8
    this.block[this.blockLen++] = 0x80
    if (this.blockLen > 56) {
      this.block.fill(0, this.blockLen)
      this.compress()
      this.blockLen = 0
    }
    this.block.fill(0, this.blockLen, 56)
    const hi = Math.floor(bitLen / 0x100000000)
    const lo = bitLen >>> 0
    for (let j = 0; j < 4; j++) {
      this.block[56 + j] = (hi >>> (24 - j * 8)) & 0xff
      this.block[60 + j] = (lo >>> (24 - j * 8)) & 0xff
    }
    this.compress()
    return Array.from(this.h, (v) => v.toString(16).padStart(8, '0')).join('')
  }

  private compress(): void {
    const w = this.w
    const b = this.block
    for (let t = 0; t < 16; t++) {
      w[t] = (b[t * 4]! << 24) | (b[t * 4 + 1]! << 16) | (b[t * 4 + 2]! << 8) | b[t * 4 + 3]!
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15]!
      const y = w[t - 2]!
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0
    }
    let [a, bb, c, d, e, f, g, h] = this.h as unknown as number[]
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)
      const ch = (e! & f!) ^ (~e! & g!)
      const t1 = (h! + S1 + ch + K[t]! + w[t]!) | 0
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)
      const maj = (a! & bb!) ^ (a! & c!) ^ (bb! & c!)
      const t2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d! + t1) | 0
      d = c
      c = bb
      bb = a
      a = (t1 + t2) | 0
    }
    const hs = this.h
    hs[0] = hs[0]! + a!
    hs[1] = hs[1]! + bb!
    hs[2] = hs[2]! + c!
    hs[3] = hs[3]! + d!
    hs[4] = hs[4]! + e!
    hs[5] = hs[5]! + f!
    hs[6] = hs[6]! + g!
    hs[7] = hs[7]! + h!
  }
}

export const sha256Hex = (data: Uint8Array | string): string => new Sha256().update(data).hex()
