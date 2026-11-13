/**
 * `@seuoffice/electron-utils/fetch-image-bytes`: the real function refuses
 * anything but a non-empty string before it reaches the network (so the host
 * is not called for it); otherwise it answers from the case's
 * `hosts.d2.hwp.fetch_image_bytes` as `FakeEngine::fetch_image_bytes` does,
 * one host-log line per call.
 */
import { world } from './common.ts'

export async function fetchImageBytes(
  url: unknown,
): Promise<{ base64: string; mime: string } | null> {
  if (typeof url !== 'string' || url === '') return null
  const w = world()
  w.log.push(['fetchImageBytes', url])
  const answer = w.answers.next('fetch_image_bytes') as Record<string, unknown> | null | undefined
  const base64 = answer?.base64
  const mime = answer?.mime
  return typeof base64 === 'string' && typeof mime === 'string' ? { base64, mime } : null
}
