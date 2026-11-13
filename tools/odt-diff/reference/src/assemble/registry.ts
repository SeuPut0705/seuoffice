/**
 * The converter registry every public entry point uses, in the one order the
 * layers were built for: text → tables → objects → pages.
 *
 * Newer registrations win, so tables and objects take their nodes before the
 * text converter; the page layer's decorator of the text converter (same id
 * `text`) only takes what the text converter itself would take.
 */
import { ConversionRegistry } from '../core/convert'
import { registerObjectConverters } from '../objects'
import { registerPageConverters } from '../page'
import { registerTableConverters } from '../table'
import { registerTextConverters } from '../text'

export function odtRegistry(): ConversionRegistry {
  const registry = new ConversionRegistry()
  registerTextConverters(registry)
  registerTableConverters(registry)
  registerObjectConverters(registry)
  registerPageConverters(registry)
  return registry
}
