//! `apps/markdown/src/main/image-export.ts`: the folders a Save As to page
//! images stages its pages in, one session per approved export.
//!
//! The ids and the folder names come from a random source the caller gives,
//! as `crypto.randomUUID()` and the six characters `mkdtemp` appends do.

use jscompat::node_path::host::{basename, dirname, extname, join};
use jscompat::{js_regex, pad_start, slice_utf16, trim};

use super::fs_util::{mkdtemp, plain_error, rename, rm_recursive_force, write_file_excl};
use super::ord_map::OrdMap;
use crate::node_fs::NodeError;
use crate::packages::electron_utils::numbered_export_paths::numbered_export_paths;

fn page_file_name(page: u64) -> String {
    format!("page-{}.png", pad_start(&page.to_string(), 2, '0'))
}

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

struct Session {
    owner: f64,
    dir: String,
    pages: u64,
    target: Option<String>,
}

/// What `finishExport` answers: the folder holding the pages and the first page.
#[derive(Debug, Clone, PartialEq)]
pub struct FinishedExport {
    pub dir: String,
    pub first: String,
}

/// The two random sources of the TypeScript.
pub struct ImageExportEnv<'a> {
    /// `randomUUID()`
    pub random_uuid: &'a dyn Fn() -> String,
    /// the six characters `mkdtemp` appends
    pub mkdtemp_suffix: &'a dyn Fn() -> String,
}

/// `ImageExportSessions`: only dialog-approved folders are registered.
#[derive(Default)]
pub struct ImageExportSessions {
    sessions: OrdMap<Session>,
}

impl ImageExportSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// `start(owner, parent, name)`
    pub fn start(
        &mut self,
        env: &ImageExportEnv<'_>,
        owner: f64,
        parent: &str,
        name: &str,
    ) -> Result<String, NodeError> {
        let cleaned = js_regex!(r#"[/\\:*?"<>|]"#, "g").replace_all(name, |_| "_".to_owned());
        let cut = slice_utf16(&cleaned, 0.0, Some(80.0));
        let trimmed = trim(&cut);
        let base = if trimmed.is_empty() {
            "Untitled"
        } else {
            trimmed
        };
        let dir = mkdtemp(
            &join(&[parent, &format!("{base}-images-")]),
            env.mkdtemp_suffix,
        )?;
        let id = (env.random_uuid)();
        self.sessions.set(
            &id,
            Session {
                owner,
                dir,
                pages: 0,
                target: None,
            },
        );
        Ok(id)
    }

    /// `startFiles(owner, target)`: Save As to page images.
    pub fn start_files(
        &mut self,
        env: &ImageExportEnv<'_>,
        owner: f64,
        target: &str,
    ) -> Result<String, NodeError> {
        let id = self.start(
            env,
            owner,
            &dirname(target),
            &basename(target, Some(&extname(target))),
        )?;
        if let Some(session) = self.sessions.get_mut(&id) {
            session.target = Some(target.to_owned());
        }
        Ok(id)
    }

    fn get(&self, owner: f64, id: &str) -> Result<&Session, NodeError> {
        match self.sessions.get(id) {
            Some(session) if session.owner == owner => Ok(session),
            _ => Err(plain_error("Export session is not authorized")),
        }
    }

    /// `write(owner, id, page, base64)`; `base64` is `None` where the
    /// argument is no string
    pub fn write(
        &mut self,
        owner: f64,
        id: &str,
        page: f64,
        base64: Option<&str>,
    ) -> Result<(), NodeError> {
        let session = self.get(owner, id)?;
        let is_safe_integer =
            page.is_finite() && page.fract() == 0.0 && page.abs() <= 9007199254740991.0;
        if !is_safe_integer || page != (session.pages + 1) as f64 {
            return Err(plain_error("Invalid export page number"));
        }
        let Some(base64) = base64 else {
            return Err(plain_error("Invalid PNG data"));
        };
        let bytes = jscompat::buffer_from_base64(base64);
        if bytes.len() < 8 || bytes[..8] != PNG_SIGNATURE {
            return Err(plain_error("Invalid PNG data"));
        }
        let path = join(&[&session.dir, &page_file_name(page as u64)]);
        write_file_excl(&path, &bytes)?;
        if let Some(session) = self.sessions.get_mut(id) {
            session.pages = page as u64;
        }
        Ok(())
    }

    /// `finish(owner, id, success)`
    pub fn finish(
        &mut self,
        owner: f64,
        id: &str,
        success: bool,
    ) -> Result<Option<String>, NodeError> {
        Ok(self.finish_export(owner, id, success)?.map(|done| done.dir))
    }

    /// `finishExport(owner, id, success)`: `Ok(None)` is `null`, nothing was kept.
    pub fn finish_export(
        &mut self,
        owner: f64,
        id: &str,
        success: bool,
    ) -> Result<Option<FinishedExport>, NodeError> {
        self.get(owner, id)?;
        let Some(session) = self.sessions.remove(id) else {
            return Err(plain_error("Export session is not authorized"));
        };
        if !success || session.pages == 0 {
            rm_recursive_force(&session.dir)?;
            if success {
                return Err(plain_error("Cannot complete an empty image export"));
            }
            return Ok(None);
        }
        let Some(target) = &session.target else {
            return Ok(Some(FinishedExport {
                first: join(&[&session.dir, &page_file_name(1)]),
                dir: session.dir,
            }));
        };
        // Save As: the staged pages move to the typed name (one page) or its numbered siblings
        let targets =
            numbered_export_paths(target, session.pages as f64).map_err(|e| plain_error(&e.0))?;
        let moved: Result<(), NodeError> =
            targets.iter().enumerate().try_for_each(|(index, to)| {
                rename(
                    &join(&[&session.dir, &page_file_name(index as u64 + 1)]),
                    to,
                )
            });
        // `finally`: a failure of the removal replaces the one of the moves
        rm_recursive_force(&session.dir)?;
        moved?;
        Ok(Some(FinishedExport {
            dir: dirname(target),
            first: targets[0].clone(),
        }))
    }

    /// `dispose(owner)`: every session of the owner is finished as failed; the
    /// first error is the one reported, after all were tried.
    pub fn dispose(&mut self, owner: f64) -> Result<(), NodeError> {
        let ids: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| session.owner == owner)
            .map(|(id, _)| id.to_owned())
            .collect();
        let mut first_error: Option<NodeError> = None;
        for id in ids {
            if let Err(error) = self.finish(owner, &id, false)
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
