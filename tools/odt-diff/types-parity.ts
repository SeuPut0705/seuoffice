// The public types of @seuoffice/odt-engine (declared again in its types.ts
// since the switch) are the types the frozen TypeScript engine exported: a
// difference is a compile error of `npm run typecheck`.
import type * as binding from '../../packages/odt-engine/src/index'
import type * as frozen from './reference/src/index'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const equal = <A, B>(same: Equal<A, B>): Equal<A, B> => same

export const parity = [
  equal<binding.BridgeMap, frozen.BridgeMap>(true),
  equal<binding.JsonValue, frozen.JsonValue>(true),
  equal<binding.ConversionReport, frozen.ConversionReport>(true),
  equal<binding.ReportFeature, frozen.ReportFeature>(true),
  equal<binding.ReportItem, frozen.ReportItem>(true),
  equal<binding.OdtToDocxResult, frozen.OdtToDocxResult>(true),
  equal<binding.SaveOdtInput, frozen.SaveOdtInput>(true),
  equal<binding.DocxToOdtOptions, frozen.DocxToOdtOptions>(true),
  equal<binding.DocxToOdtResult, frozen.DocxToOdtResult>(true),
  equal<binding.RenderedObject, frozen.RenderedObject>(true),
  equal<binding.ProtectedCellRef, frozen.ProtectedCellRef>(true),
  equal<binding.ObjectKind, frozen.ObjectKind>(true),
  equal<binding.ObjectPlaceholder, frozen.ObjectPlaceholder>(true),
  equal<binding.ObjectsExt, frozen.ObjectsExt>(true),
  equal<binding.OdtOpenErrorCode, frozen.OdtOpenErrorCode>(true),
  equal<typeof binding.REPORT_FEATURES, typeof frozen.REPORT_FEATURES>(true),
  equal<typeof binding.OBJECT_KINDS, typeof frozen.OBJECT_KINDS>(true),
  equal<typeof binding.ODT_MIMETYPE, typeof frozen.ODT_MIMETYPE>(true),
  equal<typeof binding.odtToDocx, typeof frozen.odtToDocx>(true),
  equal<typeof binding.saveOdt, typeof frozen.saveOdt>(true),
  equal<typeof binding.docxToOdt, typeof frozen.docxToOdt>(true),
  equal<typeof binding.odtToText, typeof frozen.odtToText>(true),
  equal<typeof binding.protectedCellsOf, typeof frozen.protectedCellsOf>(true),
  equal<typeof binding.isProtectedCell, typeof frozen.isProtectedCell>(true),
  equal<typeof binding.parseKeepName, typeof frozen.parseKeepName>(true),
]
