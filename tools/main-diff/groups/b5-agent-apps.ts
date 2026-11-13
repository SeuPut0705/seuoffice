import type { Group } from '../types.ts'
const { providerGroup } = await import('./b5-agent-apps-provider.ts')
const { searchGroup } = await import('./b5-agent-apps-search.ts')
const { modulesGroup } = await import('./b5-agent-apps-modules.ts')
const { attachmentsGroup } = await import('./b5-agent-apps-attachments.ts')
export const group: Group = {
  ...providerGroup,
  ...searchGroup,
  ...modulesGroup,
  ...attachmentsGroup,
}
