//! `packages/ai-provider/src/subscription/old-names.ts`: temporary folder
//! prefixes the subscription bridges used before this product took its own
//! names (decision 0024). A record a force-killed earlier version left names
//! such a folder; the next start still removes it.

/// `OLD_TRACKED_TEMP_PREFIXES`
pub const OLD_TRACKED_TEMP_PREFIXES: [&str; 2] =
    ["genoffice-codex-app-server-", "genoffice-claude-code-"];
