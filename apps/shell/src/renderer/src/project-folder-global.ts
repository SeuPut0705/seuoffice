import type { ProjectFolderApi } from '@seuoffice/project-store'

/**
 * The project folder bridge the shell preload exposes (decision 0088), for the
 * home ask panel and the home project screen. Absent with an older preload;
 * `@seuoffice/ui` reads it through `windowProjectFolderBridge()`.
 */
declare global {
  interface Window {
    projectFolderApi?: ProjectFolderApi
  }
}

export {}
