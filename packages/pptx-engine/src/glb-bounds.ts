/**
 * The bounding box of a glTF binary (.glb) scene, from its JSON chunk alone: each mesh's
 * POSITION accessor min/max, carried through the node hierarchy of the default scene.
 * PowerPoint frames a 3D model from this box (am3d:meterPerModelUnit, preTrans, camera).
 */
import { call } from './engine'

/**
 * The bounding box of a glTF binary (.glb) scene, from its JSON chunk alone: each mesh's
 * POSITION accessor min/max, carried through the node hierarchy of the default scene.
 * PowerPoint frames a 3D model from this box (am3d:meterPerModelUnit, preTrans, camera).
 */
type Vec3 = [number, number, number]
export interface GlbBounds {
  center: Vec3
  size: Vec3
}
export function glbBounds(bytes: Uint8Array): GlbBounds | null {
  return call('glbBounds', [bytes]) as never
}
