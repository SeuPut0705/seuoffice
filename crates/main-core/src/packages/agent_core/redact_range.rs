//! `packages/agent-core/src/redact-range.ts` (and `old-names.ts`'s
//! `OLD_REDACT_NS`): the names of the "withheld from the model" label. The
//! range text builders of that file (`redactTextBetween`, `withheldNodeSize`)
//! read a ProseMirror node and no main-process module calls them.

/// `OLD_REDACT_NS` of old-names.ts: the namespace every file marked so far carries
pub const OLD_REDACT_NS: &str = "https://genspark.ai/genoffice/redaction/2026";

/// `REDACT_PREFIX`
pub const REDACT_PREFIX: &str = "go";

/// `REDACT_EL`: `${REDACT_PREFIX}:redact`
pub const REDACT_EL: &str = "go:redact";

/// `OWN_REDACT_NS`: the namespace this product owns for the label
pub const OWN_REDACT_NS: &str = "https://github.com/SeuPut0705/seuoffice/redaction/2026";

/// `REDACT_NAMESPACES`: every namespace a saved label may be under
pub const REDACT_NAMESPACES: [&str; 2] = [OWN_REDACT_NS, OLD_REDACT_NS];

/// `REDACT_NS_WRITTEN`: the namespace a label is written under, still the old one
pub const REDACT_NS_WRITTEN: &str = OLD_REDACT_NS;
