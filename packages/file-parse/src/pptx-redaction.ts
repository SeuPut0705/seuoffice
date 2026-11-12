import { callEngine } from './engine'

/** the deck engine's REDACT_EXT_URI: the `uri` of the `<a:ext>` that carries a withheld run's mark */
export const PPTX_REDACT_EXT_URI = '{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}'

/**
 * A slide, notes or comments part with every run its editor withholds from a
 * model rewritten to a run holding only its `{{label}}` marker. A trace of a
 * mark that no run or picture accounts for throws `RedactionMarkError`.
 */
export function redactPptxPartXml(xml: string): string {
  return callEngine<string>('redactPptxPartXml', [xml])
}
