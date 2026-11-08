// Home's two channels into the generate window. Kept apart from
// generate-api.ts on purpose: the shell preload (index) and the generate
// window's preload are separate bundle entries, and a module both import by
// value is split into a shared chunk that a sandboxed preload cannot load.
export const GENERATE_HOME_CHANNELS = {
  openWithPaths: 'generate:open-with-paths',
  openWithGroup: 'generate:open-with-group',
} as const
