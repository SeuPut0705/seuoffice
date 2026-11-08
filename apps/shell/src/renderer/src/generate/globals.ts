import type { GenerateHomeApi, GenerateWindowApi } from '../../../shared/generate-api'

declare global {
  interface Window {
    /** the generate window's own preload (src/preload/generate.ts) */
    aiOfficeGenerateWindow: GenerateWindowApi
    /** Home's entry points into the generate window (src/preload/index.ts) */
    aiOfficeGenerate: GenerateHomeApi
  }
}

export {}
