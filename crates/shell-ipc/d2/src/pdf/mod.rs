//! PDF: the editor (`apps/pdf/src/main/pdf-main.ts`, [`editor`]) and the
//! shell's PDF tools around it (`apps/shell/src/main/pdf-structure-ipc.ts`,
//! `pdf-tools/`, `pdf-password-dialog.ts`, `pdf-convert-ui.ts`, and
//! `pdf:convert-office` of `shell/index.ts`, [`tools`]). The tools read which
//! files a view was given ([`Grants`]); the editor writes it.

pub mod editor;
pub mod tools;

use std::collections::HashSet;
use std::rc::Rc;

use shell_contract::ipc::RegisterError;
use shell_contract::runtime::Services;
use shell_contract::{Provided, ViewId};

use crate::kit::{Entry, ViewMap};

/// `allowedByWc`: the PDF files each view was given (opened, saved as, picked)
#[derive(Clone)]
pub(crate) struct Grants(pub ViewMap<HashSet<String>>);

impl Grants {
    /// `pdfPathGranted(webContentsId, path)`
    pub fn granted(&self, view: ViewId, path: &str) -> bool {
        self.0
            .with(view, |set| set.is_some_and(|set| set.contains(path)))
    }
}

pub(crate) fn entries(
    services: &Services,
    provided: &Rc<Provided>,
) -> Result<Vec<Entry>, RegisterError> {
    let grants = Grants(ViewMap::new(services));
    let mut all = editor::entries(services, provided, &grants)?;
    all.extend(tools::entries(services, provided, &grants)?);
    Ok(all)
}

#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    editor::fakes(hosts, case);
    tools::fakes(hosts, case);
}
