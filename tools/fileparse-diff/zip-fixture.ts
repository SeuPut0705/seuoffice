import JSZip from 'jszip'
import { assertZipInflatesWithinLimits } from '../../packages/zip-gate/src/index'

const FIXTURE_DATE = new Date('2024-01-02T03:04:06Z')

export async function fixtureBytes(
  zip: JSZip,
  compression: 'STORE' | 'DEFLATE' = 'DEFLATE',
): Promise<Uint8Array> {
  for (const file of Object.values(zip.files)) file.date = FIXTURE_DATE
  return zip.generateAsync({ type: 'uint8array', compression })
}

export async function fixedFixtureBytes(bytes: Uint8Array): Promise<Uint8Array> {
  await assertZipInflatesWithinLimits(bytes)
  return fixtureBytes(await JSZip.loadAsync(bytes))
}
