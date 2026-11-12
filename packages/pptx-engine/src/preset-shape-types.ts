/** ST_ShapeType (ISO/IEC 29500-1 §20.1.10.56): the only names a:prstGeom/@prst may carry. */
import { call } from './engine'

export function isPresetShapeType(name: string): boolean {
  return call('isPresetShapeType', [name]) as never
}