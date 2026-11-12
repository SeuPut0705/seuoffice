import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { OLD_REDACT_NS } from '../../../packages/agent-core/src/old-names'
import { setRedactExt } from '../../../packages/pptx-engine/src/redaction-xml'
import { templateRedactionOf } from '../src/main/agent/agent-skills'

/**
 * A deck that withholds anything is never saved as a skill template as it is.
 * The withheld label may be under either namespace, and a label is enough
 * even where the extension around it is not the deck engine's.
 */

const OWN_REDACT_NS = 'https://github.com/SeuPut0705/seuoffice/redaction/2026'

describe('saving a deck as it is', () => {
  it.each([
    ['the old namespace', OLD_REDACT_NS],
    ['this product’s own namespace', OWN_REDACT_NS],
  ])('is blocked by a label under %s', async (_name, ns) => {
    const zip = new JSZip()
    zip.file(
      'ppt/slides/slide1.xml',
      `<p:sld><a:ext uri="{OTHER}" xmlns:x="${ns}"><x:redact label="x"/></a:ext></p:sld>`,
    )
    const deck = await zip.generateAsync({ type: 'uint8array' })
    expect(await templateRedactionOf('deck.pptx', deck, false)).toBe('redacted')
  })
})

/**
 * The check every version before the rename ran on each part of a deck
 * (`templateRedactionOf` at b867d02f2), and the namespace its deck reader
 * counted to tell that it had read every mark. Copied here, with the values
 * spelled out, so that they cannot follow a later change of the code.
 */
const NS_BEFORE_THE_RENAME = 'https://genspark.ai/genoffice/redaction/2026'
const EXT_URI_BEFORE_THE_RENAME = '{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}'
const redactedAsBeforeTheRename = (xml: string) =>
  xml.includes(NS_BEFORE_THE_RENAME) || xml.includes(EXT_URI_BEFORE_THE_RENAME)

describe('a run marked as withheld now', () => {
  const marked = setRedactExt('<a:rPr lang="en-US"/>', 'client phone')

  it('is one a version from before the rename still takes for withheld', () => {
    expect(redactedAsBeforeTheRename(marked)).toBe(true)
  })

  it('names the namespace that version counts, once for the one mark, and no other', () => {
    expect(marked.split(NS_BEFORE_THE_RENAME)).toHaveLength(2)
    expect(marked).not.toContain(OWN_REDACT_NS)
  })

  it('blocks saving the deck as it is', async () => {
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', `<p:sld><a:r>${marked}<a:t>13800138000</a:t></a:r></p:sld>`)
    const deck = await zip.generateAsync({ type: 'uint8array' })
    expect(await templateRedactionOf('deck.pptx', deck, false)).toBe('redacted')
  })
})
