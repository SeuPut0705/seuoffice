/**
 * Group `b5-mcp`: the MCP server of apps/shell/src/main/mcp (and its tools),
 * the MCP client of apps/shell/src/main/mcp-client, agent/agent-mcp and
 * agent/agent-mcp-relay, with the pieces of @modelcontextprotocol/sdk, zod and
 * the packages they call. One file per slice under b5-mcp/; the Rust has one
 * submodule per slice under crates/main-core/src/calls/b5_mcp/.
 */
import type { Group } from '../types.ts'

const zod = await import('./b5-mcp/zod.ts')
const deps = await import('./b5-mcp/deps.ts')
const clientpure = await import('./b5-mcp/client-pure.ts')
const clientfiles = await import('./b5-mcp/client-files.ts')
const mcppure = await import('./b5-mcp/mcp-pure.ts')
const server = await import('./b5-mcp/server.ts')
const clientsdk = await import('./b5-mcp/client-sdk.ts')
const toolsdocs = await import('./b5-mcp/tools-docs.ts')
const toolsapps = await import('./b5-mcp/tools-apps.ts')
const clientproc = await import('./b5-mcp/client-proc.ts')
const clientnet = await import('./b5-mcp/client-net.ts')
const hub = await import('./b5-mcp/hub.ts')
const agent = await import('./b5-mcp/agent.ts')

export const group: Group = {
  ...zod.group,
  ...deps.group,
  ...clientpure.group,
  ...clientfiles.group,
  ...mcppure.group,
  ...server.group,
  ...clientsdk.group,
  ...toolsdocs.group,
  ...toolsapps.group,
  ...clientproc.group,
  ...clientnet.group,
  ...hub.group,
  ...agent.group,
}
