import { delimiter, dirname, isAbsolute } from 'node:path'

/**
 * Variables a subscription CLI is never started with: each one moves the CLI
 * from the user's subscription to another billing route.
 *
 * The first seven are the list in the product spec. The rest do the same job
 * and are named by the CLIs' own documentation or help:
 * - `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE`,
 *   `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`:
 *   the other cloud-provider switches next to Bedrock and Vertex. A set switch
 *   outranks every login.
 * - `ANTHROPIC_CUSTOM_HEADERS`: can carry an `Authorization` header.
 * - `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`: select a Console
 *   profile or a federation credential, both ranked above the `/login` one.
 * - `CODEX_API_KEY`: the API key `codex exec` reads besides `OPENAI_API_KEY`.
 * - `CODEX_ACCESS_TOKEN`: the access-token variable `codex login` documents.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` stays: it is a subscription credential, and the
 * status check reports a login that comes from it as unknown, hence metered.
 */
export const SUBSCRIPTION_STRIPPED_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
]

export interface SubscriptionEnvOptions {
  /** the environment to copy; the app's own when absent. Never modified. */
  base?: NodeJS.ProcessEnv | undefined
  platform?: NodeJS.Platform | undefined
  /** the file that will be started; its directory goes to the front of PATH when absolute */
  command?: string | undefined
  /** what the launch itself needs (see `SubscriptionProgram.env`), applied last */
  extra?: Record<string, string> | undefined
}

/**
 * The environment for a subscription CLI: a copy of `base` without
 * `SUBSCRIPTION_STRIPPED_ENV_VARS`. Windows matches variable names without
 * regard to case, as the system does.
 */
export function subscriptionChildEnv(options: SubscriptionEnvOptions = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform
  const env: NodeJS.ProcessEnv = { ...(options.base ?? process.env) }
  const stripped = new Set(SUBSCRIPTION_STRIPPED_ENV_VARS)
  for (const name of Object.keys(env)) {
    if (stripped.has(platform === 'win32' ? name.toUpperCase() : name)) delete env[name]
  }
  // Electron on Windows can omit HOME even though USERPROFILE is present. The
  // CLIs use HOME to find their normal login/config directory.
  if (platform === 'win32' && !env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE
  const command = options.command
  if (command && isAbsolute(command)) {
    const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
    env[key] = `${dirname(command)}${delimiter}${env[key] ?? ''}`
  }
  return { ...env, ...options.extra }
}
