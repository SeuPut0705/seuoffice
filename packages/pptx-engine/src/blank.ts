/**
 * Blank presentation template — starting point for the start screen's
 * "AI generate / New blank" actions. A hand-written minimal set of valid OOXML
 * parts (16:9, single blank slide); once parsed by openPptx it goes through
 * exactly the same edit/save pipeline as opening a real file.
 */
import { call } from './engine'

const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const EMPTY_SPTREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>'
/** Minimal blank slide XML (empty spTree); insertBlankSlide also uses it as new slide content. */
export const BLANK_SLIDE_XML =
  XMLDECL +
  `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
  `<p:cSld>${EMPTY_SPTREE}</p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
/** Generate blank presentation bytes (16:9, one blank slide). */
export async function createBlankPptx(): Promise<Uint8Array> {
  return call('createBlankPptx', []) as never
}
