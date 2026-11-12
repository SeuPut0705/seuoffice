/**
 * The engine's XML parser. Every parse tree comes from here, so every parsed value is decoded
 * by `decodeXml`, the same function that decodes a value read off a raw tag (`attributeOf`).
 *
 * fast-xml-parser's own decoder leaves numeric references as written: an id spelled `r&#38;1`
 * came out of it unlike the `r&1` a raw-tag read gives, and decoding its output a second time
 * to make the two meet turned `X&amp;#38;1` (the value `X&#38;1`) into `X&1`. With one decoder,
 * run once, there is nothing to reconcile: what the parser returns is the value.
 */
import { XMLParser, type X2jOptions } from 'fast-xml-parser'
import { decodeXml } from './xml-utils'

const ignore = (): void => undefined

// Entities a DTD declares are not expanded: a package part has no DTD (OPC forbids one), and a
// reference to such an entity stays as written.
const ENTITY_DECODER: NonNullable<X2jOptions['entityDecoder']> = {
  decode: decodeXml,
  reset: ignore,
  setXmlVersion: ignore,
  addInputEntities: ignore,
  setExternalEntities: ignore,
}

export function xmlParser(
  options: Omit<X2jOptions, 'entityDecoder' | 'processEntities' | 'htmlEntities'>,
): XMLParser {
  return new XMLParser({ ...options, entityDecoder: ENTITY_DECODER })
}
