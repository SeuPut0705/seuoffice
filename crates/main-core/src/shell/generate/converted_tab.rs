//! `apps/shell/src/main/generate/converted-tab.ts`: the last step of a
//! conversion without AI (8.6): the new tab of the result's editor exists, its
//! renderer has not asked yet; queue the content for that tab's webContents
//! (taken once, as a new unsaved document) and record that the conversion
//! happened into this tab from these sources, for the provenance reader.
//!
//! The markdown and mind map seed queues (`seed-main.ts` of those editors) are
//! not ported yet: [`SeedTargets`] is their seam. The slides queue is
//! [`SeedQueue`], and the record goes into the caller's [`HandoffStore`].

use super::convert::{ConvertedContent, ConvertedDocument};
use crate::packages::electron_utils::generate_handoff::{HandoffStore, HandoffWebContents};
use crate::slides::seed_queue::{SeedQueue, SlidesSeedOptions};

/// `queueMarkdownSeedFor` and `queueMindmapSeedFor`
pub trait SeedTargets {
    /// `queueMarkdownSeedFor(contents, text)`
    fn queue_markdown_seed_for(&mut self, contents: &mut dyn HandoffWebContents, text: &str);
    /// `queueMindmapSeedFor(contents, { outline })`
    fn queue_mindmap_seed_for(&mut self, contents: &mut dyn HandoffWebContents, outline: &str);
}

/// `queueConvertedContent(contents, doc)`; `now_ms` is the `Date.now()` of
/// the record, and its `Err` is a tab id resolver that throws.
pub fn queue_converted_content(
    contents: &mut dyn HandoffWebContents,
    doc: &ConvertedDocument,
    seeds: &mut dyn SeedTargets,
    slides: &mut SeedQueue,
    store: &mut HandoffStore,
    now_ms: f64,
) -> Result<(), String> {
    let content = &doc.content;
    match content {
        ConvertedContent::MindmapToMarkdown { markdown } => {
            seeds.queue_markdown_seed_for(contents, markdown);
        }
        ConvertedContent::MindmapToSlides { deck, .. } => {
            slides.queue_slides_seed_for(contents, deck.clone(), SlidesSeedOptions::default());
        }
        ConvertedContent::MarkdownToMindmap { outline } => {
            seeds.queue_mindmap_seed_for(contents, outline);
        }
    }
    store.record_generate_converted(
        contents.id(),
        content.target(),
        content.kind(),
        &doc.sources,
        &doc.id,
        now_ms,
    )?;
    Ok(())
}
