import iconv from 'iconv-lite'
import { decodeCsvBuffer } from '../../packages/xlsx-gateway/src/gateway/csv-import'
import type { Input, Spec } from './spec'

/** Text an Excel user writes, by the language whose charset it needs. */
const SAMPLES: Record<string, string> = {
  korean:
    '이름,나이,주소\n홍길동,30,서울특별시 강남구\n김철수,25,부산광역시 해운대구\n이영희,41,대전광역시 유성구\n',
  // syllables only code page 949 has: the WHATWG euc-kr reads them, KS X 1001 does not
  koreanUhc: '이름,메모\n똠방각하,쏼라쏼라 햏자\n뷁,괜찮은 값입니다\n',
  // Hangul with hanja: half the characters outside ASCII are Hangul, and read
  // as GBK the bytes score as well as Korean
  koreanHanja: '이름,주소\n홍길동,東山道 金市\n김철수,美文家 國民\n',
  chinese: '姓名,年龄,城市\n张三,30,北京市朝阳区\n李四,25,上海市浦东新区\n',
  traditional: '姓名,年齡,城市\n張三,30,臺北市\n李四,25,香港九龍\n',
  // characters of Big5-HKSCS, which the WHATWG big5 decoder has
  hkscs: '名稱,地區\n㗎,香港\n嘅,九龍\n',
  japanese: '名前,年齢,住所\n山田太郎,30,東京都新宿区\n鈴木花子,25,大阪府大阪市\n',
  halfWidthKana: '名前,カナ\n山田,ﾔﾏﾀﾞ\n',
  french: 'Nom;Âge;Ville\nÉlodie;30;Besançon\nJérôme;41;Orléans\n',
  ascii: 'a,b,c\n1,2,3\n',
  // control characters Shift_JIS decoders map differently
  controls: 'a\x1a,b\x1c,c\x7f\n山田,1\n',
}

const ENCODINGS = [
  'utf8',
  'utf16le',
  'utf16be',
  'cp949',
  'euc-kr',
  'gbk',
  'gb18030',
  'shift_jis',
  'cp932',
  'big5',
  'big5hkscs',
  'windows1252',
] as const

const PREFERRED: Array<string | undefined> = [
  undefined,
  '',
  'euc-kr',
  'EUC-KR',
  ' ks_c_5601-1987 ',
  'gbk',
  'shift_jis',
  'big5',
  'windows-1252',
  'utf-8',
  'utf-16le',
  'bogus',
  'iso-2022-kr',
  'x-user-defined',
]

const BOMS: Record<string, number[]> = {
  utf8: [0xef, 0xbb, 0xbf],
  utf16le: [0xff, 0xfe],
  utf16be: [0xfe, 0xff],
}

function encoded(text: string, encoding: string): Uint8Array | undefined {
  if (!iconv.encodingExists(encoding)) return undefined
  const bytes = iconv.encode(text, encoding)
  // a character the encoding has not became `?`: the sample says nothing about that charset
  return iconv.decode(bytes, encoding) === text ? new Uint8Array(bytes) : undefined
}

/** mulberry32: the same population on every run */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function withPreferred(input: Input, preferred: string | undefined): Input {
  return preferred === undefined
    ? input
    : {
        ...input,
        label: `${input.label} preferred ${JSON.stringify(preferred)}`,
        args: { preferred },
      }
}

function built(): Input[] {
  const inputs: Input[] = []
  for (const [name, text] of Object.entries(SAMPLES)) {
    for (const encoding of ENCODINGS) {
      const bytes = encoded(text, encoding)
      if (bytes === undefined) continue
      const base: Input = { label: `${name} in ${encoding}`, bytes }
      for (const preferred of PREFERRED) inputs.push(withPreferred(base, preferred))
      const bom = BOMS[encoding]
      if (bom)
        inputs.push({
          label: `${name} in ${encoding} with its BOM`,
          bytes: Uint8Array.from([...bom, ...bytes]),
        })
    }
  }
  // a BOM followed by another, and BOMs alone
  for (const [encoding, bom] of Object.entries(BOMS)) {
    inputs.push({ label: `${encoding} BOM alone`, bytes: Uint8Array.from(bom) })
    inputs.push({
      label: `${encoding} BOM twice`,
      bytes: Uint8Array.from([...bom, ...bom, 0x61, 0]),
    })
  }
  inputs.push(
    { label: 'empty', bytes: new Uint8Array() },
    { label: 'one NUL', bytes: Uint8Array.of(0) },
  )
  // every charset reads these worse than one U+FFFD, which is all a label of
  // the replacement encoding would give: it must not be a candidate
  inputs.push({
    label: 'worse than one replacement character',
    bytes: Uint8Array.of(0xd8, 0xd8, 0x1b, 0x1b, 0x1b),
    args: { preferred: 'iso-2022-kr' },
  })
  // random bytes: high bytes among ASCII, the pairs of the double-byte charsets, NULs now and then
  const random = seeded(0x0c5f)
  for (let n = 0; n < 600; n++) {
    const length = 1 + Math.floor(random() * 96)
    const high = random()
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i++) {
      const roll = random()
      bytes[i] =
        roll < 0.02
          ? 0
          : roll < high
            ? 0x80 + Math.floor(random() * 0x80)
            : 0x20 + Math.floor(random() * 0x5f)
    }
    const preferred = PREFERRED[Math.floor(random() * PREFERRED.length)]
    inputs.push(withPreferred({ label: `random ${n}`, bytes }, n % 3 === 0 ? preferred : undefined))
  }
  return inputs
}

export const SPECS: Spec[] = [
  {
    fn: 'decodeCsvBuffer',
    extensions: ['csv', 'tsv'],
    mutation: 'none',
    call: async ({ bytes = new Uint8Array(), args = {} }) =>
      decodeCsvBuffer(bytes, typeof args.preferred === 'string' ? args.preferred : undefined),
    built,
  },
]
