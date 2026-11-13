//! The slides deck a view shows, and the design-template memory the slides AI
//! keeps for each deck. D1 provides [`SlidesDocuments`], A provides
//! [`SlidesTemplateSelectionHooks`]; both go through
//! [`crate::provided::Provided`], so neither batch crate depends on the other.

use crate::ids::ViewId;

/// A slides session: `id` stays fixed for the session's life, `path` is ""
/// before the first save
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlidesDocument {
    pub id: u64,
    pub path: String,
}

/// D1: `sessions.get(event.sender.id)` of the slides session state
pub trait SlidesDocuments {
    fn document(&self, view: ViewId) -> Option<SlidesDocument>;
}

/// A: the hooks the slides save and rename paths call (template-selection-ipc);
/// when none is provided, the callers do nothing
pub trait SlidesTemplateSelectionHooks {
    /// `followTemplateSelection(session, fromPath, toPath)`
    fn follow(&self, doc: &SlidesDocument, from_path: &str, to_path: &str);
    /// `inheritTemplateSelection(previous, replacement)`
    fn inherit(&self, previous: Option<&SlidesDocument>, replacement: &SlidesDocument);
    /// `moveSlidesTemplateSelection(oldPath, newPath)`: the shell's
    /// after-file-moved step for a .pptx (W's rename path)
    fn moved(&self, old_path: &str, new_path: &str);
}
