//! `objects/index.ts`: the objects layer of the ODT bridge: pictures, objects
//! the editor cannot change (shown as locked placeholders), footnotes/endnotes
//! and existing comments.

use std::rc::Rc;

use crate::core::convert::{
    ConversionRegistry, InlineConverter, InlineElement, InlineEnv, InlineOoxml, OdfToOoxmlContext,
};
use crate::core::errors::OdtError;

pub mod analyze;
pub mod blocks;
pub mod comments;
pub mod geometry;
pub mod media;
pub mod model;
pub mod notes;
pub mod package;
pub mod pictures;
pub mod state;

pub use blocks::{ObjectsBlockConverter, ObjectsFreeWriter};
pub use comments::{AnnotationEndInlineConverter, AnnotationInlineConverter, CommentInjector};
pub use media::{ImageFormat, NEUTRAL_PLACEHOLDER_PNG, sniff_image};
pub use model::{
    NoteKind, OBJECT_KINDS, OBJECTS_EXT_KEY, OBJECTS_OWNER, ODT_KEEP_PREFIX, ODT_PICTURE_PREFIX,
    ObjectComment, ObjectKind, ObjectNote, ObjectPicture, ObjectPlaceholder, ObjectsExt,
    empty_objects_ext, keep_name, parse_keep_name, parse_picture_name, picture_name,
};
pub use notes::NoteInlineConverter;
pub use package::{
    OdtPackageChanges, object_package_changes, paragraph_needs_rewrite, patch_manifest_xml,
    prepare_object_write_back,
};
pub use pictures::{
    DrawingInlineConverter, DroppedDrawingInjector, ObjectsRunWriter, write_drawing,
};
pub use state::AddedEntry;

/// `trackedMarkConverter`: tracked-change marks outside a locked paragraph
/// (lists, cells) stay as kept markers.
pub struct TrackedMarkConverter;

impl InlineConverter for TrackedMarkConverter {
    fn id(&self) -> &str {
        OBJECTS_OWNER
    }

    fn names(&self) -> &[&'static str] {
        &["text:change-start", "text:change-end", "text:change"]
    }

    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        _el: &InlineElement,
        _env: &InlineEnv,
    ) -> Result<Option<InlineOoxml>, OdtError> {
        let st = state::forward_state(ctx);
        let warn = {
            let mut st = st.borrow_mut();
            let first = !st.warned_tracked;
            st.warned_tracked = true;
            first
        };
        if warn {
            ctx.warn(
                "tracked-change marks inside lists or cells are kept as markers; their text is editable",
            );
        }
        Ok(None)
    }
}

/// `registerObjectConverters`: registers the objects layer. Register it after
/// the text layer (and the table layer): its block converter and inline
/// converters take precedence and decline what belongs to others (text boxes
/// holding tables).
pub fn register_object_converters(registry: &mut ConversionRegistry) {
    registry.add_inline(Rc::new(TrackedMarkConverter));
    registry.add_inline(Rc::new(NoteInlineConverter));
    registry.add_inline(Rc::new(AnnotationInlineConverter));
    registry.add_inline(Rc::new(AnnotationEndInlineConverter));
    registry.add_inline(Rc::new(DrawingInlineConverter));
    registry.add_run_writer(Rc::new(ObjectsRunWriter));
    registry.add_injector(Rc::new(CommentInjector));
    registry.add_injector(Rc::new(DroppedDrawingInjector));
    registry.add_block(Rc::new(ObjectsBlockConverter));
    registry.add_free_writer(Rc::new(ObjectsFreeWriter));
}
