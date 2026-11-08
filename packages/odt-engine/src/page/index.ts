// Page layer of the ODT bridge: page layouts, master pages (headers and
// footers), page runs and sections, both directions. See AGENTS.section.md.
//
// Order (T6):
//   open:  registerTextConverters(registry); registerPageConverters(registry)
//          … convertOdtStyles(ctx); convertOdtBody(ctx); convertOdtPage(ctx); buildBridgeDocx(ctx)
//   save:  const items = await preparePageWriteBack(rctx)
//          rebuildOdtBody(rctx, items); updateOdtStyles(rctx); rctx.finish()
export { convertOdtPage, defaultMasterPage } from './forward'
export {
  type LayoutOverrides,
  type PageGeometry,
  columnsOf,
  layoutGeometry,
  layoutOverrides,
  odfLengths,
} from './geometry'
export { pageFieldRunWriter, pairParagraphs } from './hf'
export {
  type DocxSection,
  HF_REGIONS,
  type HfRegion,
  PAGE_EXT_KEY,
  PAGE_OWNER,
  type PageExt,
  type PageHfPart,
  type PageRun,
  readPageExt,
} from './model'
export { editLayoutXml, editMasterXml } from './odf'
export { registerPageConverters } from './register'
export { preparePageWriteBack } from './reverse'
export { buildSectPr, injectParagraphSectPr, paragraphSectPr, stripParagraphSectPr } from './sectpr'
