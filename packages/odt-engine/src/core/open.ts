/**
 * `openOdt`: the one entry point that turns ODT bytes into the core model —
 * the package (raw entries in original order), the manifest, the body's
 * position map and the style table. Rejections are typed (`OdtOpenError`).
 */
import { type OdtBody, scanOdtBody } from './body'
import { OdtEncryptedError, OdtNotTextError, OdtOpenError } from './errors'
import { type OdtManifest, readManifest } from './manifest'
import { type OdtGenerator, detectGenerator } from './meta'
import {
  ODT_TEXT_MEDIA_TYPE,
  type OdtPackage,
  type ReadOdtPackageOptions,
  readOdtPackage,
} from './package'
import { type OdtStyleTable, readOdtStyles } from './styles'
import { decodeXmlEntities, readRoot } from './xml'

export interface OdtDocument {
  pkg: OdtPackage
  manifest: OdtManifest
  /** decoded content.xml; every body offset indexes this string */
  contentXml: string
  /** decoded styles.xml, or null when the package has none */
  stylesXml: string | null
  /** decoded meta.xml, or null */
  metaXml: string | null
  body: OdtBody
  styles: OdtStyleTable
  generator: OdtGenerator
  /** `office:version` of the content (or styles/meta) root; null when absent, as in Hancom files */
  officeVersion: string | null
}

export type OpenOdtOptions = ReadOdtPackageOptions

/**
 * Opens an ODT leniently: `mimetype` anywhere and in any compression, no
 * `office:version`, schema errors. Throws `OdtOpenError`:
 * `zip-rejected` (size / bomb gate), `corrupt`, `not-odt-text`
 * (`OdtNotTextError`), `encrypted` (`OdtEncryptedError`).
 */
export async function openOdt(
  bytes: Uint8Array,
  options: OpenOdtOptions = {},
): Promise<OdtDocument> {
  const pkg = await readOdtPackage(bytes, options)
  if (pkg.mimetype !== ODT_TEXT_MEDIA_TYPE) throw new OdtNotTextError(pkg.mimetype)
  const manifest = readManifest(pkg.text('META-INF/manifest.xml'))
  if (manifest.encrypted) throw new OdtEncryptedError()
  const contentXml = pkg.text('content.xml')
  if (contentXml === undefined) throw new OdtOpenError('corrupt', 'odt: content.xml is missing')
  const stylesXml = pkg.text('styles.xml') ?? null
  const metaXml = pkg.text('meta.xml') ?? null
  const body = scanOdtBody(contentXml)
  const styles = readOdtStyles(stylesXml, contentXml)
  return {
    pkg,
    manifest,
    contentXml,
    stylesXml,
    metaXml,
    body,
    styles,
    generator: detectGenerator(metaXml),
    officeVersion:
      officeVersionOf(contentXml) ?? officeVersionOf(stylesXml) ?? officeVersionOf(metaXml),
  }
}

function officeVersionOf(xml: string | null): string | null {
  const root = xml ? readRoot(xml) : null
  if (!root) return null
  const attr = root.attributes.find((a) => root.prefixes.canonical(a.name) === 'office:version')
  return attr ? decodeXmlEntities(attr.raw) : null
}
