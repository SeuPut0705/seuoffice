import { buildZip, hostileContainers } from '../docx-diff/package-zips'
import type { Input } from './spec'

export function hostileZipInputs(): Input[] {
  return [
    ...Object.entries(hostileContainers()).map(([label, bytes]) => ({ label, bytes })),
    {
      label: 'gate refuses 600MB declaration',
      bytes: buildZip([{ name: 'payload.xml', data: '<a/>', declaredSize: 600_000_000 }]),
    },
    {
      label: 'gate refuses inflate beyond declared size',
      bytes: buildZip([
        { name: 'payload.xml', data: 'x'.repeat(1536 * 1024), method: 8, declaredSize: 300 },
      ]),
    },
    {
      label: 'gate refuses encryption flag',
      bytes: buildZip([{ name: 'payload.xml', data: '<a/>', flags: 1 }]),
    },
    {
      label: 'gate refuses unknown compression',
      bytes: buildZip([{ name: 'payload.xml', data: '<a/>', method: 99 }]),
    },
  ].map((input) => ({ ...input, isolate: true }))
}
