//! Menu actions one batch offers another through [`crate::provided::Provided`]:
//! U the update check, D2 the shell's own document conversions. The menus
//! (M) leave an item out when nobody provides its action.

use std::rc::Rc;

use crate::ids::ViewId;
use crate::provided::Provided;

/// Batch U: Help > Check for Updates and the About box's check
/// (`checkForUpdatesNow`)
pub trait UpdateCheck {
    /// `false` while no updater runs (a dev build, an unsupported install):
    /// the item is left out
    fn available(&self) -> bool;
    fn check_now(&self);
}

/// The local conversions of a PDF the File menu offers
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PdfExport {
    Docx,
    Pptx,
    Xlsx,
}

/// Batch D2: the shell's own conversions of the File menus
pub trait DocumentConversions {
    /// PDF > Export as Word / PowerPoint / Excel (`exportPdfAs*Local`)
    fn export_pdf_as(&self, view: ViewId, format: PdfExport);
    /// Hangul > Import PDF (`importPdfIntoHwp`)
    fn import_pdf_into_hwp(&self, view: ViewId);
}

pub fn update_check(provided: &Provided) -> Option<Rc<dyn UpdateCheck>> {
    provided.all::<dyn UpdateCheck>().into_iter().next()
}

pub fn document_conversions(provided: &Provided) -> Option<Rc<dyn DocumentConversions>> {
    provided.all::<dyn DocumentConversions>().into_iter().next()
}
