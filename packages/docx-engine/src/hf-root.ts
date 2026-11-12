// The root element a rewritten header/footer part ends up under. It follows
// from the part's own bytes, so the reader and the writer agree on it: a
// wrapper carried on the part's runs may use only the prefixes that root
// declares.


export type HfRootName = 'w:hdr' | 'w:ftr'