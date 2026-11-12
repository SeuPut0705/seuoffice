//! old-names.ts: names this engine wrote before the product took its own
//! names (decision 0024). No other source file spells an old name; the rename
//! tool's keep list names this file by its hyphenated name, as it does the
//! TypeScript one.

/// `OLD_LAZY_MEDIA_MAGICS`: the header of a lazy-media placeholder an
/// earlier version wrote. A crash-recovery copy whose pictures could not be
/// put back keeps its placeholders, so one written then still opens. Same
/// length as the current header.
pub const OLD_LAZY_MEDIA_MAGICS: [&[u8]; 1] = [b"GENOFFICE-LAZY-MEDIA\n"];
