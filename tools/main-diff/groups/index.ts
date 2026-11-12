import type { Group } from '../types.ts'
import { group as b2Misc } from './b2-misc.ts'
import { group as b2Print } from './b2-print.ts'
import { group as b2Recovery } from './b2-recovery.ts'
import { group as b2Remote } from './b2-remote.ts'
import { group as b3Session } from './b3-session.ts'
import { group as b3Shell } from './b3-shell.ts'
import { group as b3Update } from './b3-update.ts'
import { group as b4Docs } from './b4-docs.ts'
import { group as b4Sheets } from './b4-sheets.ts'
import { group as b4Slides } from './b4-slides.ts'
import { group as b4Markdown } from './b4-markdown.ts'
import { group as b4Html } from './b4-html.ts'
import { group as b4Pdf } from './b4-pdf.ts'
import { group as b4Hwp } from './b4-hwp.ts'
import { group as b5Ai } from './b5-ai.ts'
import { group as files } from './files.ts'
import { group as nodeFs } from './node-fs.ts'
import { group as nodePath } from './node-path.ts'
import { group as settings } from './settings.ts'
import { group as update } from './update.ts'

/** The groups of each batch (decision 0030), by the name `--group` takes. */
export const groups: Record<string, Group> = {
  'node-path': nodePath,
  update,
  settings,
  files,
  'node-fs': nodeFs,
  'b2-misc': b2Misc,
  'b2-recovery': b2Recovery,
  'b2-remote': b2Remote,
  'b2-print': b2Print,
  'b3-session': b3Session,
  'b3-update': b3Update,
  'b3-shell': b3Shell,
  'b4-docs': b4Docs,
  'b4-sheets': b4Sheets,
  'b4-slides': b4Slides,
  'b4-markdown': b4Markdown,
  'b4-html': b4Html,
  'b4-pdf': b4Pdf,
  'b4-hwp': b4Hwp,
  'b5-ai': b5Ai,
}
