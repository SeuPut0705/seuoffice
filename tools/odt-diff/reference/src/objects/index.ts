// Objects layer of the ODT bridge: pictures, objects the editor cannot change
// (shown as locked placeholders), footnotes/endnotes and existing comments.
import type { ConversionRegistry, InlineConverter } from '../core/convert'
import { objectsBlockConverter, objectsFreeWriter } from './blocks'
import {
  annotationEndInlineConverter,
  annotationInlineConverter,
  commentInjector,
} from './comments'
import { OBJECTS_OWNER } from './model'
import { noteInlineConverter } from './notes'
import { drawingInlineConverter, droppedDrawingInjector, objectsRunWriter } from './pictures'
import { forwardState } from './state'

/** Tracked-change marks outside a locked paragraph (lists, cells) stay as kept markers. */
const trackedMarkConverter: InlineConverter = {
  id: OBJECTS_OWNER,
  names: ['text:change-start', 'text:change-end', 'text:change'],
  toOoxml(ctx) {
    const st = forwardState(ctx)
    if (!st.warnedTracked) {
      st.warnedTracked = true
      ctx.warn(
        'tracked-change marks inside lists or cells are kept as markers; their text is editable',
      )
    }
    return null
  },
}

/**
 * Registers the objects layer. Register it after the text layer (and the
 * table layer): its block converter and inline converters take precedence
 * and decline what belongs to others (text boxes holding tables).
 */
export function registerObjectConverters(registry: ConversionRegistry): ConversionRegistry {
  return registry
    .addInline(trackedMarkConverter)
    .addInline(noteInlineConverter)
    .addInline(annotationInlineConverter)
    .addInline(annotationEndInlineConverter)
    .addInline(drawingInlineConverter)
    .addRunWriter(objectsRunWriter)
    .addInjector(commentInjector)
    .addInjector(droppedDrawingInjector)
    .addBlock(objectsBlockConverter)
    .addFreeWriter(objectsFreeWriter)
}

export {
  OBJECTS_EXT_KEY,
  OBJECTS_OWNER,
  OBJECT_KINDS,
  ODT_KEEP_PREFIX,
  ODT_PICTURE_PREFIX,
  emptyObjectsExt,
  keepName,
  parseKeepName,
  parsePictureName,
  pictureName,
  type NoteKind,
  type ObjectComment,
  type ObjectKind,
  type ObjectNote,
  type ObjectPicture,
  type ObjectPlaceholder,
  type ObjectsExt,
} from './model'
export { NEUTRAL_PLACEHOLDER_PNG, sniffImage, type ImageFormat } from './media'
export {
  objectPackageChanges,
  paragraphNeedsRewrite,
  patchManifestXml,
  prepareObjectWriteBack,
  type OdtPackageChanges,
} from './package'
export { type AddedEntry } from './state'
export { objectsBlockConverter, objectsFreeWriter } from './blocks'
export {
  annotationEndInlineConverter,
  annotationInlineConverter,
  commentInjector,
} from './comments'
export { noteInlineConverter } from './notes'
export {
  drawingInlineConverter,
  droppedDrawingInjector,
  objectsRunWriter,
  writeDrawing,
} from './pictures'
