// Group `images` of comparison (f): the predicates of tiff.ts and metafile.ts
// that need no canvas. The decoders stay with the host.
import { isMetafileMime, MAX_METAFILE_GUNZIP_BYTES } from './reference/metafile'
import { isTiffMime, tiffDimsOk } from './reference/tiff'
import type { CallSpec, Input } from './calls-spec'

/**
 * An `unknown` argument as it crosses JSON: `{ $: tag }` stands for what JSON
 * cannot carry. Any other value, objects with another `$` included, is itself.
 */
function unknownOf(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || !('$' in raw)) return raw
  switch (raw.$) {
    case 'NaN':
      return NaN
    case 'Infinity':
      return Infinity
    case '-Infinity':
      return -Infinity
    case '-0':
      return -0
    case 'undefined':
      return undefined
    default:
      return raw
  }
}

const MIMES = [
  'image/tiff',
  'image/tif',
  'image/x-tiff',
  'image/emf',
  'image/x-emf',
  'image/wmf',
  'image/x-wmf',
  'image/emz',
  'image/x-emz',
  'image/wmz',
  'image/x-wmz',
  'IMAGE/TIFF',
  'image/TIF',
  ' image/tiff',
  'image/tiff ',
  'image/tiff; charset=x',
  'image/png',
  'image/jpeg',
  'image/x-emf+gzip',
  'tiff',
  'emf',
  '',
  '__proto__',
  'constructor',
  'toString',
]

const mimeInputs: Input[] = [
  ...MIMES.map((text) => ({ text })),
  { text: '', args: { missing: true } },
  { text: 'image/tiff', args: { missing: true } },
]

/** Values of an `unknown` dimension: in and out of budget, and of every other type. */
const DIMS: unknown[] = [
  1,
  0,
  -1,
  100,
  16384,
  16385,
  16383.5,
  0.5,
  1e-300,
  9375,
  16000,
  16001,
  12247,
  12248,
  1e21,
  2 ** 53,
  2 ** 53 + 2,
  '100',
  '',
  null,
  true,
  [100],
  { width: 100 },
  { $: 'NaN' },
  { $: 'Infinity' },
  { $: '-Infinity' },
  { $: '-0' },
  { $: 'undefined' },
  { $: 'other' },
]

const CONSTANTS: Record<string, unknown> = { MAX_METAFILE_GUNZIP_BYTES }

export const IMAGES: CallSpec[] = [
  {
    fn: 'images.constants',
    call: (_text, args) => {
      const name = String(args.name)
      if (!Object.hasOwn(CONSTANTS, name)) throw new Error(`no constant ${name}`)
      return CONSTANTS[name]
    },
    built: [...Object.keys(CONSTANTS), 'nothing'].map((name) => ({ args: { name } })),
    mutation: 'none',
  },
  {
    fn: 'images.isTiffMime',
    call: (text, args) => isTiffMime(args.missing ? undefined : text),
    built: mimeInputs,
  },
  {
    fn: 'images.tiffDimsOk',
    call: (_text, args) => tiffDimsOk(unknownOf(args.width), unknownOf(args.height)),
    built: [
      ...DIMS.flatMap((width) => DIMS.map((height) => ({ args: { width, height } }))),
      { args: {} },
      { args: { width: 100 } },
      // the pixel budget: 9375 x 16000 is exactly 150 000 000
      { args: { width: 9375, height: 16000 } },
      { args: { width: 9375, height: 16001 } },
      { args: { width: 12247, height: 12247 } },
      { args: { width: 12247, height: 12248 } },
      { args: { width: 16384, height: 9155 } },
      { args: { width: 16384, height: 9156 } },
    ],
    mutation: 'none',
  },
  {
    fn: 'images.isMetafileMime',
    call: (text, args) => isMetafileMime(args.missing ? undefined : text),
    built: mimeInputs,
  },
]
