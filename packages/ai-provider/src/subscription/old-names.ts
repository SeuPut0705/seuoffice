/**
 * Temporary folder prefixes the subscription bridges used before this product
 * took its own names (decision 0024). A record a force-killed earlier version
 * left names such a folder; the next start still removes it.
 */
export const OLD_TRACKED_TEMP_PREFIXES: readonly string[] = [
  'genoffice-codex-app-server-',
  'genoffice-claude-code-',
]
