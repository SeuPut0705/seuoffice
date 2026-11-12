/// <reference types="vite/client" />

import type { ProjectApi, ProjectFolderApi } from '@seuoffice/project-store'
import type { SplitPaneBridge } from '@seuoffice/ui'
import type { MindmapApi } from '../shared/ipc'

declare global {
  interface Window {
    /** project folders (decision 0088); absent outside the shell or with an older preload */
    projectFolderApi?: ProjectFolderApi
    mindmapApi: MindmapApi
    projectApi?: Pick<ProjectApi, 'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'>
    /** the shell's split panes; read through @seuoffice/ui's split-pane-role helpers */
    aiOfficeSplit?: SplitPaneBridge
  }
}

export {}
