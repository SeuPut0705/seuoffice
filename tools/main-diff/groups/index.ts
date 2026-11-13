import type { Group } from '../types.ts'

/**
 * The groups of each batch (decision 0030), by the name `--group` takes, in
 * the order they run. A group is loaded only when it runs, and main.ts runs
 * each group in a process of its own: a group fakes modules (electron, the
 * editors' mains) through loader hooks and module caches that outlive it, so
 * one group's fakes must never reach another group's modules.
 */
export const groups: Record<string, () => Promise<{ group: Group }>> = {
  'node-path': () => import('./node-path.ts'),
  update: () => import('./update.ts'),
  settings: () => import('./settings.ts'),
  files: () => import('./files.ts'),
  'node-fs': () => import('./node-fs.ts'),
  'b2-misc': () => import('./b2-misc.ts'),
  'b2-recovery': () => import('./b2-recovery.ts'),
  'b2-remote': () => import('./b2-remote.ts'),
  'b2-print': () => import('./b2-print.ts'),
  'b3-session': () => import('./b3-session.ts'),
  'b3-update': () => import('./b3-update.ts'),
  'b3-shell': () => import('./b3-shell.ts'),
  'b4-docs': () => import('./b4-docs.ts'),
  'b4-sheets': () => import('./b4-sheets.ts'),
  'b4-slides': () => import('./b4-slides.ts'),
  'b4-markdown': () => import('./b4-markdown.ts'),
  'b4-html': () => import('./b4-html.ts'),
  'b4-pdf': () => import('./b4-pdf.ts'),
  'b4-hwp': () => import('./b4-hwp.ts'),
  'b5-ai': () => import('./b5-ai.ts'),
  'b6-utils': () => import('./b6-utils.ts'),
  'b6-shell': () => import('./b6-shell.ts'),
  'b6-apps': () => import('./b6-apps.ts'),
  'b6-tabs': () => import('./b6-tabs.ts'),
  'b2-cli': () => import('./b2-cli.ts'),
  'b4-fonts': () => import('./b4-fonts.ts'),
  'b4-pdf-store': () => import('./b4-pdf-store.ts'),
  'b3b4-rest': () => import('./b3b4-rest.ts'),
  'b3-projects': () => import('./b3-projects.ts'),
  'b5-agent': () => import('./b5-agent.ts'),
}
