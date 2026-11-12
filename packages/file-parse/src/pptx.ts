import { callEngine } from './engine'

/**
 * Extract slide text from a pptx: one "## Slide N" section per slide in the
 * order of presentation.xml, a line per paragraph, speaker notes under
 * "### Notes" and comments under "### Comments". Withheld runs are their
 * `{{label}}` markers.
 */
export async function pptxToText(bytes: Uint8Array): Promise<string> {
  return callEngine<string>('pptxToText', [bytes])
}
