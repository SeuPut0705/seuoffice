import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { canonicalXmlSyntax } from '../src/ooxml-normalize'

describe('canonicalXmlSyntax', () => {
  it.each([
    ["<w:p w:x='a'/>", '<w:p w:x="a"/>'],
    ['<w:p w:x = "a" w:y= \'b\'>', '<w:p w:x="a" w:y="b">'],
    ['<w:p w:x="a>b">', '<w:p w:x="a&gt;b">'],
    ['<w:p w:x=\'say "hi"\'>', '<w:p w:x="say &quot;hi&quot;">'],
    ['<w:p w:x="a/>b"/>', '<w:p w:x="a/&gt;b"/>'],
    ['<w:p>x</w:p >', '<w:p>x</w:p>'],
    ['<w:p>x</w:p\n>', '<w:p>x</w:p>'],
    ['<w:p><!-- </w:p> <w:r> --><w:r/></w:p>', '<w:p><w:r/></w:p>'],
    ['<a><?target data?></a>', '<a></a>'],
    ['<w:t><![CDATA[a < b & </w:r> c]]></w:t>', '<w:t>a &lt; b &amp; &lt;/w:r&gt; c</w:t>'],
    ['<w:t>a<!-- c -->b</w:t>', '<w:t>ab</w:t>'],
  ])('writes %j as %j', (spelled, canonical) => {
    expect(canonicalXmlSyntax(spelled)).toBe(canonical)
  })

  it('leaves a part written the usual way as it is, the XML declaration included', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document xmlns:w="u"><w:p w:rsidR="00A1"><w:r><w:t xml:space="preserve">a &amp; b &gt; c \'q\'</w:t></w:r><w:br/></w:p></w:document>'
    expect(canonicalXmlSyntax(xml)).toBe(xml)
  })

  it('leaves every part of every probe document as it is', async () => {
    const changed: string[] = []
    const walk = async (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) await walk(path)
        else if (path.endsWith('.docx')) {
          const zip = await JSZip.loadAsync(readFileSync(path))
          for (const part of Object.keys(zip.files)) {
            if (!/^word\/[^/]+\.xml$/.test(part)) continue
            const xml = await zip.file(part)!.async('string')
            if (canonicalXmlSyntax(xml) !== xml) changed.push(`${path}:${part}`)
          }
        }
      }
    }
    await walk(join(__dirname, 'fixtures'))
    expect(changed).toEqual([])
  })
})
