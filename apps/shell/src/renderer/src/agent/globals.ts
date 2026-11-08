import type { AgentWindowApi } from '../../../shared/agent-api'

declare global {
  interface Window {
    /** the agent window's own preload (src/preload/agent.ts) */
    aiOfficeAgentWindow: AgentWindowApi
  }
}

export {}
