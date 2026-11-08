/**
 * Home's one channel into the agent window (decision 0032). A file of its own:
 * the Home preload must not import `agent-api.ts`, which the agent window's
 * preload also imports. Two preloads sharing a module make the bundler split it
 * into a chunk, and a sandboxed preload cannot load a chunk, so the whole Home
 * preload would fail to run.
 */
export const AGENT_HOME_OPEN_CHANNEL = 'home:open-agent-window'
