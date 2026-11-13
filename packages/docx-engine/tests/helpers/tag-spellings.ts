import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'

export const SPELLINGS: Record<string, (xml: string) => string> = {
  'single quotes': (xml) => xml.replace(/<[^>!?]+>/g, (t) => t.replace(/="([^"]*)"/g, "='$1'")),
  'spaces around =': (xml) =>
    xml.replace(/<[^>!?]+>/g, (t) => t.replace(/(\s[\w:.-]+)=(["'])/g, '$1 = $2')),
  '> inside values': (xml) =>
    xml.replace(/<(w:p|w:r|w:tbl|w:tc|w:tr|w:drawing|w:pict)(?=[\s>])/g, '<$1 w:x="a>b"'),
  'space before > in end tags': (xml) => xml.replace(/<\/([\w:.-]+)>/g, '</$1 >'),
  // the words of a run as a CDATA section
  CDATA: (xml) =>
    xml.replace(/<w:t((?:\s[^>]*)?)>([^<]*)<\/w:t>/g, (all, attrs: string, text: string) => {
      const words = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      return text === '' || words.includes(']]>') ? all : `<w:t${attrs}><![CDATA[${words}]]></w:t>`
    }),
  // in one pass: a comment holding tags, inside and around the elements
  comments: (xml) =>
    xml.replace(
      /<(?:w:p|w:r|w:tc)(?:\s[^>]*)?(?<!\/)>|<\/(?:w:r|w:p|w:tc|w:tr|w:pPr|w:rPr|w:drawing|w:pict|mc:Choice|mc:Fallback|mc:AlternateContent|w:txbxContent)>/g,
      (tag) =>
        tag.startsWith('</') ? `<!-- </w:p> <w:r> -->${tag}` : `${tag}<!-- <w:p> </w:t> -->`,
    ),
}

export const FIXTURES = join(__dirname, '..', 'fixtures')
export function docxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) docxFiles(path, out)
    else if (path.endsWith('.docx')) out.push(path)
  }
  return out
}

const PARTS = /^word\/[^/]+\.xml$/

export async function respelled(bytes: Uint8Array, spelling: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  for (const path of Object.keys(zip.files)) {
    if (PARTS.test(path))
      zip.file(path, SPELLINGS[spelling]!(await zip.file(path)!.async('string')))
  }
  return zip.generateAsync({ type: 'uint8array' })
}

/** the model of a document, without the XML it was read from */
export function modelOf(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('<') ? '<xml>' : value
  if (Array.isArray(value)) return value.map(modelOf)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value))
      if (!['originalXml', 'internal', 'extras'].includes(k)) out[k] = modelOf(v)
    return out
  }
  return value
}
