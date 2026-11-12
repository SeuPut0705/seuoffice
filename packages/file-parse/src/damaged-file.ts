/**
 * A file the compound-file gate refuses, as the readers of this package report it. The
 * gate says which table or sector does not hold, which means nothing to the person who
 * attached the file: what they can act on is that the file is damaged, or is not the kind of
 * document its name says. The message is one short, stable English sentence (tools and the
 * model read it as it is).
 */
export class DamagedFileError extends Error {
  constructor(type: string, cause: unknown) {
    super(`The file is damaged or is not a valid ${type} document`, { cause })
    this.name = 'DamagedFileError'
  }
}
