import { convertOdpToPptx } from '@genoffice/odf2ooxml'

/** .odp → .pptx through the local import filter (same engine as the app's open route). */
export async function convertOdp(input: Uint8Array): Promise<{
  bytes: Uint8Array
  detail: Record<string, unknown>
}> {
  const result = await convertOdpToPptx(input)
  return {
    bytes: result.pptx,
    detail: { slides: result.slides, dropped: result.dropped },
  }
}
