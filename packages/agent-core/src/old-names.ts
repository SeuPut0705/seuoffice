/**
 * Names this product wrote into users' files before it took its own names
 * (decision 0024). This package depends on no other workspace package, so the
 * ones it honours are listed here. No other source file spells an old name.
 */

/**
 * Namespace of the "withheld from the model" label (`go:redact`) in a docx or
 * pptx. Every file marked so far carries it for good, and it is still the one
 * written: `REDACT_NS_WRITTEN` in redact-range.ts says why and what ends that.
 */
export const OLD_REDACT_NS = 'https://genspark.ai/genoffice/redaction/2026'

/**
 * The app's own MCP server as agent sessions, pasted client configs and
 * saved chats named it: a user server may not take it either.
 */
export const OLD_APP_MCP_SERVER_NAMES: readonly string[] = ['ieumoffice-editor']
