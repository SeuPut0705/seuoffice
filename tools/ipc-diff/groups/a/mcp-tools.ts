/**
 * Group `a/mcp-tools`: the person's MCP servers as the AI windows see them
 * (`apps/shell/src/main/mcp-client/hub-ipc.ts`, `mcp-tools:*`): the list,
 * calls, cancel, retry and "open in Settings". The hub is loaded as in
 * `a/mcp-servers`, whose world (the servers behind `net.fetch`, the seeded
 * store, the stand-ins of `safeStorage` and the shell window) this group
 * shares. Settings (view 1) prepares each server with `mcp-servers:*` calls;
 * the editor (view 3) uses the tools.
 */
import type { Case, Group } from '../../types.ts'
import {
  DOCS_URL,
  DOWN_URL,
  editor,
  loadMcpHub,
  mcpWorld,
  seeded,
  shell,
  views,
} from './mcp-servers.ts'

const request = (server: string, tool: string, callId: string, input: unknown = {}) => ({
  server,
  tool,
  callId,
  input,
})

/** Settings tests the server and lets one tool run without asking */
const prepared = [
  shell('mcp-servers:test', 'srv-docs'),
  shell('mcp-servers:set-tool-permission', 'srv-docs', 'echo', 'always'),
  shell('mcp-servers:set-tool-permission', 'srv-docs', 'upper', 'off'),
]

const base = { views, files: seeded, hosts: mcpWorld() }

const cases: Case[] = [
  {
    ...base,
    note: 'the list: servers not yet checked, then with their tools once tested; the windows are told of each change',
    calls: [
      editor('mcp-tools:list'),
      shell('mcp-servers:test', 'srv-docs'),
      editor('mcp-tools:list'),
      shell('mcp-servers:set-tool-permission', 'srv-docs', 'echo', 'always'),
      editor('mcp-tools:list'),
      shell('mcp-servers:set-enabled', 'srv-off', true),
      editor('mcp-tools:list'),
    ],
  },
  {
    ...base,
    note: 'a call to a tool the person allowed runs on the server and answers with its output',
    calls: [
      ...prepared,
      editor('mcp-tools:call', request('docs', 'echo', 'c1', { text: 'hi' })),
      editor('mcp-tools:call', request('docs', 'echo', 'c2')),
    ],
  },
  {
    ...base,
    note: 'a call that is refused: no such server, no such tool, a tool turned off, a server off, a malformed request',
    calls: [
      ...prepared,
      editor('mcp-tools:call', request('nothing', 'echo', 'c1')),
      editor('mcp-tools:call', request('docs', 'nothing', 'c2')),
      editor('mcp-tools:call', request('docs', 'upper', 'c3')),
      editor('mcp-tools:call', request('off', 'echo', 'c4')),
      editor('mcp-tools:call', 'docs'),
      editor('mcp-tools:call', { server: 'docs', tool: 'echo', input: {} }),
      editor('mcp-tools:call', { server: 'docs', tool: 'echo', callId: 'c5', input: 5 }),
    ],
  },
  {
    ...base,
    note: "a server that is down answers the call with the reason; a server error is the call's own",
    calls: [
      ...prepared,
      editor('mcp-tools:call', request('down', 'echo', 'c1')),
      shell('mcp-servers:list'),
      editor('mcp-tools:call', request('broken', 'echo', 'c2')),
    ],
  },
  {
    ...base,
    note: "a tool that answers with an error is reported as one; the answer is the server's text",
    hosts: mcpWorld({
      servers: {
        [DOCS_URL]: {
          tools: [{ name: 'echo', description: 'Echo it back' }],
          callText: 'it went wrong',
          callError: true,
        },
        [DOWN_URL]: { unreachable: true },
      },
    }),
    calls: [...prepared.slice(0, 2), editor('mcp-tools:call', request('docs', 'echo', 'c1'))],
  },
  {
    ...base,
    note: 'cancelling a call nobody made, and a cancel that is malformed, are harmless',
    calls: [
      editor('mcp-tools:cancel', 'c1'),
      editor('mcp-tools:cancel', 5),
      editor('mcp-tools:cancel'),
    ],
  },
  {
    ...base,
    note: 'retry by name: a known server is tried again, an unknown one is not',
    calls: [
      editor('mcp-tools:retry', 'down'),
      editor('mcp-tools:retry', 'nothing'),
      editor('mcp-tools:retry', 5),
      shell('mcp-servers:list'),
    ],
  },
  {
    ...base,
    note: '"open in Settings" brings the shell window up on the server',
    calls: [
      editor('mcp-tools:open-settings', 'docs'),
      editor('mcp-tools:open-settings', 'nothing'),
      editor('mcp-tools:open-settings', {}),
    ],
  },
  {
    ...base,
    note: 'the shell window calls the tools too',
    calls: [
      ...prepared,
      shell('mcp-tools:list'),
      shell('mcp-tools:call', request('docs', 'echo', 's1')),
    ],
  },
]

export const group: Group = {
  batch: 'A',
  load: loadMcpHub,
  cases,
}
