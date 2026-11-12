/**
 * 3D models stored the way PowerPoint stores them: an mc:AlternateContent whose Choice is a
 * p:graphicFrame holding am3d:model3d ([MS-ODRAWXML] 2.31, the 2017/model3d namespace) and
 * whose Fallback is a p:pic of the model's latest rendering, for applications without 3D.
 * The editor treats the model as that picture (move, resize, thumbnails, export) and keeps
 * the Choice in step: frame, rotation and the rendering it caches (am3d:raster).
 */
import type { GlbBounds } from './glb-bounds'
import type { EmuRect } from './types'
import { call } from './engine'

export const AM3D_NS = 'http://schemas.microsoft.com/office/drawing/2017/model3d'
export const MODEL3D_REL_TYPE = 'http://schemas.microsoft.com/office/2017/06/relationships/model3d'
/** PowerPoint's own spelling, with a dot. */
export const GLB_CONTENT_TYPE = 'model/gltf.binary'
/** Denominator of am3d's ratios (meterPerModelUnit, illuminance, intensity, scale). */
export const MODEL3D_RATIO_ONE = 1_000_000
/** am3d lengths are EMUs: 36,000,000 per meter. */
export const MODEL3D_EMU_PER_METER = 36_000_000
/** PowerPoint's default camera: perspective, 45° field of view (60,000ths of a degree). */
export const MODEL3D_FOV = 2_700_000
/** am3d:rot, in 60,000ths of a degree, applied to the model about its x, y and z axes. */
export interface Model3dRotation {
  ax: number
  ay: number
  az: number
}
export const NO_ROTATION: Model3dRotation = { ax: 0, ay: 0, az: 0 }
/** How PowerPoint frames a model: scaled to one meter across, centred, the camera backed off to fit it. */
export function model3dFraming(bounds: GlbBounds | null): { meterPerModelUnit: { n: number; d: number; }; preTrans: [number, number, number]; cameraZ: number; } {
  return call('model3dFraming', [bounds]) as never
}
/**
 * PowerPoint's default lighting for an inserted model: a grey ambient light and three point
 * lights (color in scRGB 100,000ths, intensity n/1,000,000, position in EMUs).
 */
export const MODEL3D_LIGHTS = {
  ambient: { rgb: [50000, 50000, 50000], illuminance: 500000 },
  points: [
    { rgb: [100000, 75000, 50000], intensity: 9765625, pos: [21959998, 70920001, 16344003] },
    { rgb: [40000, 60000, 95000], intensity: 12250000, pos: [-37964106, 51130435, 57631972] },
    { rgb: [86837, 72700, 100000], intensity: 3125000, pos: [-37739122, 58056624, -34769649] },
  ],
} as const
export interface Model3dXmlOptions {
  id: number
  name: string
  offset: EmuRect
  modelRId: string
  posterRId: string
  bounds: GlbBounds | null
  rot?: Model3dRotation
}
/** The slide's mc:AlternateContent for a new model. */
export function model3dXml(o: Model3dXmlOptions): string {
  return call('model3dXml', [o], { names: ["o"] }) as never
}
/**
 * Copies the Fallback picture's frame, which the editor moves and resizes, to the Choice:
 * the graphicFrame's p:xfrm, the model's own extent and its viewport.
 */
export function syncModel3dFrame(xml: string): string {
  return call('syncModel3dFrame', [xml]) as never
}
/** The model's rotation, as am3d:rot holds it (absent axes are 0). */
export function readModel3dRotation(xml: string): Model3dRotation {
  return call('readModel3dRotation', [xml]) as never
}
export function setModel3dRotationXml(xml: string, rot: Model3dRotation): string {
  return call('setModel3dRotationXml', [xml, rot]) as never
}