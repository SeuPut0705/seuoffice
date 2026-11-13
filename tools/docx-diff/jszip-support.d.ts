// JSZip's feature flags, read on every call: `nodebuffer` selects its UTF-8 decoder.
declare module 'jszip/lib/support.js' {
  const support: { nodebuffer: boolean }
  export default support
}
