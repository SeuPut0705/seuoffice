/** vite: the module is the URL its asset is served from */
declare module '*.wasm?url' {
  const url: string
  export default url
}
