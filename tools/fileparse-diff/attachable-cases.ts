import { attachableMaxBytes, diagramPictureExtOfName, isAttachableExt, ATTACHABLE_EXTS } from './reference/attachable'
import type { Input, Spec } from './spec'
const extensions = [...ATTACHABLE_EXTS, ...[...ATTACHABLE_EXTS].map(ext => `.${ext.toUpperCase()}`), '', '.', '..docx', 'foo', '__proto__', 'constructor', ' docx', '.docx ']
const inputs = (values: readonly string[]): Input[] => values.map((text, n) => ({ label: `metadata ${n}`, text }))
export const SPECS: Spec[] = [
  { fn: 'attachableMaxBytes', extensions: [], mutateText: true, built: () => inputs(extensions), call: ({text = ''}) => attachableMaxBytes(text) },
  { fn: 'isAttachableExt', extensions: [], mutateText: true, built: () => inputs(extensions), call: ({text = ''}) => isAttachableExt(text) },
  { fn: 'diagramPictureExtOfName', extensions: [], mutateText: true, built: () => inputs(['a.drawio.svg','A.DRAWIO.PNG','a.svg','a.drawio','a.dio','drawio.png','a.drawio.svg.tmp','.drawio.png','a.drawio.png ','dir/a.drawio.svg']), call: ({text = ''}) => diagramPictureExtOfName(text) },
]
