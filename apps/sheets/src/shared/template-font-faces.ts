/// The bundled template fonts as the families a sheets cell can name. The faces
/// themselves, their URLs and the file list are @genoffice/ui/template-fonts': the
/// grid canvas (renderer FontFaces naming the files by URL, fetched only when text
/// first uses a family) and the PDF export / print window (@font-face rules naming
/// the files) both read that one table, so the page prints in the font the grid drew.

import { TEMPLATE_FONT_FACE_REGISTRATIONS } from '@genoffice/ui/template-fonts'

/** Every family a cell can name and get a bundled face for (lowercase, as CSS matches). */
export const TEMPLATE_FONT_FAMILY_KEYS: ReadonlySet<string> = new Set(
  TEMPLATE_FONT_FACE_REGISTRATIONS.map((face) => face.family.toLowerCase()),
)
