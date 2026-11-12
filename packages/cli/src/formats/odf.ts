import { convertOdpToPptx, OdfConvertError } from '@seuoffice/odf2ooxml'
import { CliError, EXIT } from '../result'

/** .odp → .pptx through the local import filter (same engine as the app's open route). */
export async function convertOdp(input: Uint8Array): Promise<{
  bytes: Uint8Array
  detail: Record<string, unknown>
}> {
  try {
    const result = await convertOdpToPptx(input)
    return {
      bytes: result.pptx,
      detail: { slides: result.slides, dropped: result.dropped },
    }
  } catch (err) {
    if (err instanceof OdfConvertError) {
      throw new CliError(EXIT.conversion, err.message, { reason: err.code })
    }
    throw err
  }
}
