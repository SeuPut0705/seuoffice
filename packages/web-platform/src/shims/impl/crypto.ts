import { Buffer } from 'buffer'
import { cbc, ecb } from '@noble/ciphers/aes.js'
import { hmac } from '@noble/hashes/hmac.js'
import { md5, sha1 } from '@noble/hashes/legacy.js'
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js'
import { WebUnsupportedError } from '../../errors'

/**
 * Node's inputs plus plain byte arrays: outside Node, cfb hands out arrays
 * and officecrypto-tool hashes them, as browser crypto polyfills allow.
 */
type Input = string | ArrayBuffer | ArrayBufferView | readonly number[]
type Encoding = 'hex' | 'base64' | 'utf8' | 'utf-8' | 'latin1' | 'binary'
type DigestEncoding = 'hex' | 'base64'

const ALGORITHMS = { md5, sha1, sha256, sha384, sha512 }
type Algorithm = keyof typeof ALGORITHMS

function bytes(input: Input, encoding?: Encoding): Uint8Array {
  if (typeof input === 'string') return Buffer.from(input, encoding ?? 'utf8')
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input))
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return Uint8Array.from(input)
}

function algorithm(name: string): (typeof ALGORITHMS)[Algorithm] {
  const key = name.toLowerCase().replace('-', '') as Algorithm
  const hash = ALGORITHMS[key]
  if (!hash) throw new WebUnsupportedError(`node:crypto.createHash(${name})`)
  return hash
}

function encode(digest: Uint8Array, encoding?: DigestEncoding): Buffer | string {
  const buffer = Buffer.from(digest)
  return encoding ? buffer.toString(encoding) : buffer
}

class Hash {
  private readonly state

  constructor(create: { create(): { update(data: Uint8Array): unknown; digest(): Uint8Array } }) {
    this.state = create.create()
  }

  update(data: Input, encoding?: Encoding): this {
    this.state.update(bytes(data, encoding))
    return this
  }

  digest(): Buffer
  digest(encoding: DigestEncoding): string
  digest(encoding?: DigestEncoding): Buffer | string {
    return encode(this.state.digest(), encoding)
  }
}

export function createHash(name: string): Hash {
  return new Hash(algorithm(name))
}

export function createHmac(name: string, key: Input): Hash {
  const hash = algorithm(name)
  return new Hash({ create: () => hmac.create(hash, bytes(key)) })
}

export const getHashes = (): string[] => Object.keys(ALGORITHMS)

const BLOCK = 16
const CIPHER = /^aes-(128|192|256)-(cbc|ecb)$/

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * AES-CBC/ECB with Node's streaming contract: update() returns every whole
 * block it can, final() handles the PKCS#7 padding (on unless
 * setAutoPadding(false)). Synchronous like Node's, which Web Crypto is not.
 */
class BlockCipher {
  private readonly key: Uint8Array
  private readonly chained: boolean
  private iv: Uint8Array
  private pending: Uint8Array = new Uint8Array(0)
  private padding = true

  constructor(
    private readonly decrypting: boolean,
    name: string,
    key: Input,
    iv: Input | null,
  ) {
    const match = CIPHER.exec(name.toLowerCase())
    const call = decrypting ? 'createDecipheriv' : 'createCipheriv'
    if (!match) throw new WebUnsupportedError(`node:crypto.${call}(${name})`)
    this.key = bytes(key)
    if (this.key.length * 8 !== Number(match[1])) throw new RangeError('Invalid key length')
    this.chained = match[2] === 'cbc'
    this.iv = this.chained && iv !== null ? bytes(iv).slice() : new Uint8Array(0)
    if (this.chained && this.iv.length !== BLOCK)
      throw new RangeError('Invalid initialization vector')
  }

  setAutoPadding(on = true): this {
    this.padding = on
    return this
  }

  update(data: Input, encoding?: Encoding): Buffer {
    const all = concat(this.pending, bytes(data, encoding))
    // a decipher that strips padding holds its last whole block back for final()
    const tail = all.length % BLOCK
    const keep = tail === 0 && this.decrypting && this.padding && all.length > 0 ? BLOCK : tail
    this.pending = all.slice(all.length - keep)
    return Buffer.from(this.run(all.subarray(0, all.length - keep)))
  }

  final(): Buffer {
    const rest = this.pending
    this.pending = new Uint8Array(0)
    if (!this.padding) {
      if (rest.length > 0) throw new Error('data not multiple of block length')
      return Buffer.alloc(0)
    }
    if (!this.decrypting) {
      const count = BLOCK - rest.length
      return Buffer.from(this.run(concat(rest, new Uint8Array(count).fill(count))))
    }
    if (rest.length !== BLOCK) throw new Error('wrong final block length')
    const plain = this.run(rest)
    const count = plain[BLOCK - 1]!
    if (count < 1 || count > BLOCK || plain.subarray(BLOCK - count).some((b) => b !== count)) {
      throw new Error('bad decrypt')
    }
    return Buffer.from(plain.subarray(0, BLOCK - count))
  }

  private run(blocks: Uint8Array): Uint8Array {
    if (blocks.length === 0) return blocks
    const opts = { disablePadding: true }
    const cipher = this.chained ? cbc(this.key, this.iv, opts) : ecb(this.key, opts)
    const out = this.decrypting ? cipher.decrypt(blocks) : cipher.encrypt(blocks)
    // CBC chains on the last ciphertext block across update() calls
    if (this.chained) this.iv = (this.decrypting ? blocks : out).slice(-BLOCK)
    return out
  }
}

export function createCipheriv(name: string, key: Input, iv: Input | null): BlockCipher {
  return new BlockCipher(false, name, key, iv)
}

export function createDecipheriv(name: string, key: Input, iv: Input | null): BlockCipher {
  return new BlockCipher(true, name, key, iv)
}

export const randomUUID = (): string => globalThis.crypto.randomUUID()

export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  return globalThis.crypto.getRandomValues(array as never) as T
}

export function randomBytes(size: number): Buffer {
  const buffer = Buffer.alloc(size)
  // getRandomValues fills at most 65536 bytes per call
  for (let offset = 0; offset < size; offset += 65536)
    globalThis.crypto.getRandomValues(buffer.subarray(offset, Math.min(size, offset + 65536)))
  return buffer
}

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const left = bytes(a)
  const right = bytes(b)
  if (left.length !== right.length) throw new RangeError('Input buffers must have the same length')
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!
  return diff === 0
}

export const webcrypto = globalThis.crypto
export const subtle = globalThis.crypto?.subtle
