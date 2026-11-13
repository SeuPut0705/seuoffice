/**
 * Group `w/home-settings-mcp`: the MCP log channels of home's settings, with
 * the MCP runtime configured the way the entry module does once the app is
 * ready: its log file is userData/mcp.log (`logFilePath` of
 * `configureMcpRuntime`). The server is never turned on here.
 */
import type { Case, Group } from '../../types.ts'
import { call, hosts, loadHome, saved } from './home-settings.ts'

const LOG = '$DIR/userData/mcp.log'
const withLog = (extra: Parameters<typeof hosts>[1] = {}) => hosts({ mcpLogFile: LOG }, extra)

const cases: Case[] = [
  {
    note: 'logs: the last lines of the file, blank lines left out',
    hosts: withLog(),
    files: { 'userData/mcp.log': 'one\ntwo\n\nthree\n' },
    calls: [call('home:get-mcp-logs')],
  },
  {
    note: 'logs: only the last 200 lines',
    hosts: withLog(),
    files: {
      'userData/mcp.log': Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n'),
    },
    calls: [call('home:get-mcp-logs')],
  },
  {
    note: 'logs: an empty file reads as no lines',
    hosts: withLog(),
    files: { userData: { dir: true } },
    calls: [call('home:get-mcp-logs')],
  },
  {
    note: 'clear the log: the file is emptied, the lines are gone',
    hosts: withLog(),
    files: { 'userData/mcp.log': 'a\nb\n' },
    calls: [call('home:clear-mcp-logs'), call('home:get-mcp-logs')],
  },
  {
    note: 'open the log file: shown in the file manager',
    hosts: withLog(),
    files: { 'userData/mcp.log': 'a\n' },
    calls: [call('home:open-mcp-log-file')],
  },
  {
    note: 'open the log file: the file is made when it is missing',
    hosts: withLog(),
    files: { userData: { dir: true } },
    calls: [call('home:open-mcp-log-file'), call('home:get-mcp-logs')],
  },
  {
    note: 'the status and settings with the runtime configured',
    hosts: withLog(),
    files: saved({ mcpLogging: true }),
    calls: [
      call('home:get-mcp-status'),
      call('home:set-mcp-settings', { port: 4500, background: true }),
      call('home:get-mcp-status'),
    ],
  },
]

export const group: Group = {
  batch: 'W',
  load: loadHome,
  cases,
}
