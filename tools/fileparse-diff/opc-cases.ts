import { resolveTarget } from './reference/opc'
import type { Spec } from './spec'

export const SPECS: Spec[] = [{
  fn: 'resolveTarget',
  extensions: [],
  mutateText: true,
  call: ({ text = '', args = {} }) => resolveTarget(String(args.basePart ?? ''), text),
  built: () => [
    ['', ''], ['word/document.xml', '../media/a.xml'], ['a/b/c.xml', '../../../../root.xml'],
    ['a/b.xml', '\\ppt\\slides\\slide2.xml'], ['a.xml', 'https://example.org/a'],
    ['a.xml', '%ZZ'], ['a/b.xml', '%E0%A4%A'], ['a/b.xml', '%F0%9F%98%80.xml'],
    ['a/b.xml', '/root.xml'], ['a/b.xml', '%2Froot.xml'], ['a/b.xml', './c/../d.xml'],
    ['a/b.xml', 'file:bad'], ['a/b.xml', '%3Afoo'], ['a/b.xml', 'name%20with%20spaces.xml'],
  ].map(([basePart, text], n) => ({label: `OPC ${n}`, text, args: {basePart}})),
}]
