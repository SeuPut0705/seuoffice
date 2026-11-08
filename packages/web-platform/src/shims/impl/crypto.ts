import { Buffer } from 'buffer'
import { hmac } from '@noble/hashes/hmac.js'
import { md5, sha1 } from '@noble/hashes/legacy.js'
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js'
import { WebUnsupportedError } from '../../errors'

type Input = string | ArrayBuffer | ArrayBufferView
type Encoding = 'hex' | 'base64' | 'utf8' | 'utf-8' | 'latin1' | 'binary'
type DigestEncoding = 'hex' | 'base64'

const ALGORITHMS = { md5, sha1, sha256, sha384, sha512 }
type Algorithm = keyof typeof ALGORITHMS

function bytes(input: Input, encoding?: Encoding): Uint8Array {
  if (typeof input === 'string') return Buffer.from(input, encoding ?? 'utf8')
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
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
