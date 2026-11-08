/**
 * Page-layer fixtures: Hancom-like documents with several page runs, shared
 * master pages, header/footer variants, columns and page numbers.
 *
 * The default document has three runs, each started by a paragraph whose
 * automatic style names a master page (Hancom's `…_MS<n>_…` styles):
 * run 1 and run 3 share `Standard` (layout `Mpm1`), run 2 uses `MP2` (`Mpm2`).
 */
import type { BuildOdtOptions } from './build-odt'
import { hPara, hParagraphAutoStyle, hTextAutoStyle } from './hancom-fragments'

export const RUN_TEXTS = ['one a', 'one b', 'two a', 'two b', 'three a', 'three b']

export function layoutXml(
  name: string,
  opts: {
    width?: string
    height?: string
    orientation?: string
    margins?: [string, string, string, string]
    header?: string | null
    footer?: string | null
    headerExtra?: string
    columns?: number
    numFormat?: string
  } = {},
): string {
  const [top, right, bottom, left] = opts.margins ?? ['1.000cm', '2.000cm', '1.000cm', '2.000cm']
  const num = opts.numFormat !== undefined ? ` style:num-format="${opts.numFormat}"` : ''
  const cols = opts.columns ?? 1
  const header =
    opts.header === null
      ? ''
      : `<style:header-style><style:header-footer-properties svg:height="${opts.header ?? '1.500cm'}"${opts.headerExtra ?? ''}/></style:header-style>`
  const footer =
    opts.footer === null
      ? ''
      : `<style:footer-style><style:header-footer-properties svg:height="${opts.footer ?? '1.000cm'}"/></style:footer-style>`
  return (
    `<style:page-layout style:name="${name}"><style:page-layout-properties fo:page-width="${opts.width ?? '21.000cm'}" fo:page-height="${opts.height ?? '29.700cm'}" style:print-orientation="${opts.orientation ?? 'portrait'}"${num} fo:margin-left="${left}" fo:margin-right="${right}" fo:margin-top="${top}" fo:margin-bottom="${bottom}" fo:border="none" style:shadow="none" style:writing-mode="lr-tb">` +
    `<style:columns fo:column-count="${cols}"${cols > 1 ? ' fo:column-gap="0.500cm"' : ''}><style:column style:rel-width="9622*"/><style:column-sep style:style="none" style:width="0.010cm" style:color="#000000"/></style:columns></style:page-layout-properties>` +
    `${header}${footer}</style:page-layout>`
  )
}

export const hp = (text: string) => hPara(text, { style: 'MP445_1', span: 'MT40' })

export function masterXml(
  name: string,
  layout: string,
  regions: Partial<Record<string, string[]>>,
): string {
  const order = ['header', 'header-left', 'header-first', 'footer', 'footer-left', 'footer-first']
  const inner = order
    .filter((r) => regions[r])
    .map((r) => `<style:${r}>${(regions[r] ?? []).map(hp).join('')}</style:${r}>`)
    .join('')
  return inner
    ? `<style:master-page style:name="${name}" style:page-layout-name="${layout}">${inner}</style:master-page>`
    : `<style:master-page style:name="${name}" style:page-layout-name="${layout}"/>`
}

/** Header paragraph styles of styles.xml plus the given layouts. */
export const stylesAutos = (...layouts: string[]) =>
  hParagraphAutoStyle('MP445_1', { parent: '바탕글' }) + hTextAutoStyle('MT40') + layouts.join('')

/** Content automatic styles: the run-start styles and a shared body style. */
export function contentAutos(extra = ''): string {
  return (
    hTextAutoStyle('T1') +
    hParagraphAutoStyle('P1_0') +
    hParagraphAutoStyle('PS1', { masterPage: 'Standard' }) +
    hParagraphAutoStyle('PS2', { masterPage: 'MP2' }) +
    hParagraphAutoStyle('PS3', { masterPage: 'Standard' }) +
    extra
  )
}

/** Three runs: Standard, MP2, Standard. */
export function threeRuns(): string {
  return (
    hPara(RUN_TEXTS[0], { style: 'PS1' }) +
    hPara(RUN_TEXTS[1]) +
    hPara(RUN_TEXTS[2], { style: 'PS2' }) +
    hPara(RUN_TEXTS[3]) +
    hPara(RUN_TEXTS[4], { style: 'PS3' }) +
    hPara(RUN_TEXTS[5])
  )
}

export interface PageDocOptions {
  body?: string
  masterStyles?: string
  layouts?: string[]
  contentExtra?: string
}

/** The default three-run document (override any piece). */
export function pageDoc(opts: PageDocOptions = {}): BuildOdtOptions {
  return {
    body: opts.body ?? threeRuns(),
    contentAutomaticStyles: contentAutos(opts.contentExtra),
    stylesAutomaticStyles: stylesAutos(
      ...(opts.layouts ?? [
        layoutXml('Mpm1'),
        layoutXml('Mpm2', { width: '29.700cm', height: '21.000cm', orientation: 'landscape' }),
      ]),
    ),
    masterStyles:
      opts.masterStyles ??
      masterXml('Standard', 'Mpm1', { header: ['header'], footer: ['footer'] }) +
        masterXml('MP2', 'Mpm2', { header: ['header 2'] }),
  }
}

/** One run under `Standard` (explicit start), two paragraphs. */
export function singleRun(regions: Partial<Record<string, string[]>>, layout = layoutXml('Mpm1')) {
  return pageDoc({
    body: hPara('alpha', { style: 'PS1' }) + hPara('beta'),
    layouts: [layout],
    masterStyles: masterXml('Standard', 'Mpm1', regions),
  })
}

/** The XML of one named element (`style:master-page`, `style:page-layout`, `style:style`) in a part. */
export function elementNamed(xml: string, element: string, name: string): string | null {
  const re = new RegExp(`<${element} style:name="${name}"[^>]*?(?:/>|>[\\s\\S]*?</${element}>)`)
  return re.exec(xml)?.[0] ?? null
}

/** Every `style:name` of an element kind. */
export function namesOf(xml: string, element: string): string[] {
  return [...xml.matchAll(new RegExp(`<${element} style:name="([^"]*)"`, 'g'))].map((m) => m[1])
}
