/** file:///web/... is the only file URL the web build knows */
export function fileURLToPath(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : url
  if (parsed.protocol !== 'file:') throw new TypeError('The URL must be of scheme file')
  return decodeURIComponent(parsed.pathname)
}

export function pathToFileURL(path: string): URL {
  const absolute = path.startsWith('/') ? path : `/web/${path}`
  return new URL(`file://${absolute.split('/').map(encodeURIComponent).join('/')}`)
}
