//! `packages/electron-utils/src/doc-attach-channels.ts`.

/// `DOC_ATTACH_CHANNELS`, as (key, channel) in the order the object has them.
pub const DOC_ATTACH_CHANNELS: [(&str, &str); 3] = [
    ("available", "doc:attach-available"),
    ("pick", "doc:pick-attachments"),
    ("list", "doc:attach-list"),
];

/// `DOC_ATTACH_BRIDGE_KEY`
pub const DOC_ATTACH_BRIDGE_KEY: &str = "aiOfficeDocs";
