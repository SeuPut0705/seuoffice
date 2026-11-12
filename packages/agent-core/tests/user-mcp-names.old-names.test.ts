import { describe, expect, it } from 'vitest'
import { serverNameProblem, suggestServerName } from '../src/user-mcp'

// The app's own MCP server was named `ieumoffice-editor` before it became
// `seuoffice-editor`; pasted client configs and saved chats still carry that
// name, so a person's server may take neither.

describe("the app's own server under its old name", () => {
  it('is refused as a user server name, in any case, like the current one', () => {
    expect(serverNameProblem('ieumoffice-editor')).toBe('reserved')
    expect(serverNameProblem('IeumOffice-Editor')).toBe('reserved')
    expect(serverNameProblem('seuoffice-editor')).toBe('reserved')
    expect(serverNameProblem('ieumoffice-tools')).toBeNull()
  })

  it('is suggested away from', () => {
    expect(suggestServerName('ieumoffice-editor')).toBe('ieumoffice-editor-2')
  })
})
