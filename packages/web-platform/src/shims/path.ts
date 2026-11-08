import path from 'path-browserify'

export const {
  basename,
  delimiter,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} = path
export const toNamespacedPath = (value: string): string => value
export const posix = path
export const win32 = path
export default path
