//! `apps/shell/src/main/drive/drive-attach.ts`: Drive files for an AI panel's
//! attachments (decisions 0033, 0085): the files the person chose in Google's
//! picker, at most [`MAX_ATTACH_FILES`], each downloaded (a Google document
//! exported to Office) into its own folder under a temporary directory. The
//! editor then attaches the paths as it does files from this PC, so its
//! attachment reader (and the hiding it applies) is the same. Copies older
//! than a week are removed the first time the folder is used in a run.
//!
//! Blocks on the network and the disk: run it on a worker.

use std::fs;
use std::io;
use std::path::Path;
#[cfg(feature = "probe")]
use std::sync::atomic::AtomicI64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use main_core::node_fs::{NodeError, node_error};

use super::client::{DriveClient, DriveFile, MAX_READ_BYTES, OpenPlan};

pub const MAX_ATTACH_FILES: usize = 20;
const KEEP_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// `AttachDownload`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AttachDownload {
    pub paths: Vec<String>,
    pub skipped: usize,
    pub failed: usize,
}

/// Probe only: negative names each download folder at random (the TypeScript's
/// `randomBytes(6)`); from 0 up, the folders are named `000000000001`,
/// `000000000002`, ... in the order they are made, so a run can be compared
/// with the TypeScript's (tools/ipc-diff stands `randomBytes` in the same way)
#[cfg(feature = "probe")]
pub static COUNTED_FOLDERS: AtomicI64 = AtomicI64::new(-1);

/// `randomBytes(6).toString('hex')`
fn folder_name() -> io::Result<String> {
    #[cfg(feature = "probe")]
    if COUNTED_FOLDERS.load(Ordering::SeqCst) >= 0 {
        // downloads of one call run one after another, so counting needs no more
        let before = COUNTED_FOLDERS.fetch_add(1, Ordering::SeqCst);
        return Ok(format!("{:012x}", before + 1));
    }
    let mut random = [0u8; 6];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}

/// `pruneOld(dir, now)`: `pruned` is the module variable of the TypeScript,
/// one per run
fn prune_old(dir: &Path, now_ms: u64, pruned: &AtomicBool) {
    if pruned.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(names) = fs::read_dir(dir) else {
        return;
    };
    let _ = (|| -> io::Result<()> {
        for entry in names {
            let path = entry?.path();
            let Ok(info) = fs::metadata(&path) else {
                continue;
            };
            let mtime_ms = info
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
            if now_ms as f64 - mtime_ms > KEEP_MS {
                let removed = if info.is_dir() {
                    fs::remove_dir_all(&path)
                } else {
                    fs::remove_file(&path)
                };
                match removed {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                    _ => {}
                }
            }
        }
        Ok(())
    })();
}

/// `downloadPicks(api, picked, dir, now)`: download the picked files into
/// `dir`. Past [`MAX_ATTACH_FILES`] the rest are counted as skipped. Only the
/// folder `dir` itself failing to exist is an error.
pub fn download_picks(
    client: &dyn DriveClient,
    picked: &[String],
    dir: &Path,
    now_ms: u64,
    pruned: &AtomicBool,
) -> Result<AttachDownload, NodeError> {
    fs::create_dir_all(dir).map_err(|e| node_error(&e, "mkdir", &dir.to_string_lossy()))?;
    prune_old(dir, now_ms, pruned);
    let mut ids: Vec<&String> = Vec::new();
    for id in picked {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut out = AttachDownload {
        skipped: ids.len().saturating_sub(MAX_ATTACH_FILES),
        ..AttachDownload::default()
    };
    for id in ids.into_iter().take(MAX_ATTACH_FILES) {
        let Some(file) = file_behind_shortcut(client, id) else {
            out.failed += 1;
            continue;
        };
        let (extension, got) = match client.open_plan(&file.name, &file.mime_type) {
            OpenPlan::None => {
                out.skipped += 1;
                continue;
            }
            OpenPlan::Export { mime, extension } => {
                let got = client.export(&file.id, &mime, MAX_READ_BYTES);
                (extension, got)
            }
            OpenPlan::Download { extension } => {
                let got = client.download(&file.id, MAX_READ_BYTES);
                (extension, got)
            }
        };
        let Ok(bytes) = got else {
            out.failed += 1;
            continue;
        };
        let written = (|| -> io::Result<String> {
            let folder = dir.join(folder_name()?);
            fs::create_dir(&folder)?;
            let path = folder.join(client.local_file_name(&file.name, &extension));
            fs::write(&path, &bytes)?;
            Ok(path.to_string_lossy().into_owned())
        })();
        match written {
            Ok(path) => out.paths.push(path),
            Err(_) => out.failed += 1,
        }
    }
    Ok(out)
}

/// The file a picked id names, a shortcut followed to its target
fn file_behind_shortcut(client: &dyn DriveClient, id: &str) -> Option<DriveFile> {
    let file = client.file(id).ok()?;
    match &file.shortcut_target {
        Some(target) => client.file(&target.id).ok(),
        None => Some(file),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::super::testing::{FakeClient, GOOGLE_DOC};
    use super::*;

    const T1: &str = "2026-01-02T00:00:00Z";

    fn dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("shell-a-attach-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn picks(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn each_file_lands_in_its_own_folder_and_what_cannot_be_read_is_counted() {
        let client = FakeClient::new();
        client.add("a", "Plan.docx", "application/x", T1, b"plan");
        client.add("b", "Plan.docx", "application/x", T1, b"other plan");
        client.add("g", "Notes", GOOGLE_DOC, T1, b"exported");
        client.add("p", "pic.png", "image/png", T1, b"png");
        let root = dir("each");
        let got = download_picks(
            &*client,
            &picks(&["a", "b", "g", "p", "missing", "a"]),
            &root,
            1,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!((got.skipped, got.failed), (1, 1), "{got:?}");
        assert_eq!(got.paths.len(), 3, "a repeated id is fetched once");
        let contents: Vec<_> = got.paths.iter().map(|p| fs::read(p).unwrap()).collect();
        assert_eq!(
            contents,
            [
                b"plan".to_vec(),
                b"other plan".to_vec(),
                b"exported".to_vec()
            ]
        );
        let folders: std::collections::HashSet<_> = got
            .paths
            .iter()
            .map(|p| Path::new(p).parent().unwrap().to_path_buf())
            .collect();
        assert_eq!(folders.len(), 3, "two Plan.docx do not collide");
        assert!(got.paths.iter().all(|p| Path::new(p).starts_with(&root)));
        assert!(got.paths[2].ends_with("Notes.docx"));
    }

    #[test]
    fn past_twenty_the_rest_are_skipped() {
        let client = FakeClient::new();
        let ids: Vec<String> = (0..25).map(|i| format!("f{i}")).collect();
        for id in &ids {
            client.add(id, &format!("{id}.docx"), "application/x", T1, b"x");
        }
        let got = download_picks(&*client, &ids, &dir("cap"), 1, &AtomicBool::new(false)).unwrap();
        assert_eq!((got.paths.len(), got.skipped, got.failed), (20, 5, 0));
    }

    #[test]
    fn copies_older_than_a_week_go_once_per_run() {
        let root = dir("prune");
        fs::create_dir_all(root.join("old")).unwrap();
        fs::write(root.join("old").join("a.docx"), b"a").unwrap();
        let client = FakeClient::new();
        let pruned = AtomicBool::new(false);
        let week = 7 * 24 * 60 * 60 * 1000;
        let now = (super::super::util::now_ms()) + week + 60_000;

        download_picks(&*client, &[], &root, now, &pruned).unwrap();
        assert!(!root.join("old").exists());
        assert!(pruned.load(Ordering::SeqCst));

        // the folder is only swept the first time it is used in a run
        fs::create_dir_all(root.join("old2")).unwrap();
        download_picks(&*client, &[], &root, now, &pruned).unwrap();
        assert!(root.join("old2").exists());

        let fresh = dir("prune-fresh");
        fs::create_dir_all(fresh.join("new")).unwrap();
        download_picks(
            &*client,
            &[],
            &fresh,
            super::super::util::now_ms(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(fresh.join("new").exists());
    }

    #[test]
    fn a_folder_that_cannot_be_made_is_an_error_with_nodes_text() {
        let client = FakeClient::new();
        let file = dir("blocked");
        fs::write(&file, b"in the way").unwrap();
        let err = download_picks(&*client, &[], &file.join("sub"), 1, &AtomicBool::new(false))
            .unwrap_err();
        assert!(err.message.contains("mkdir"), "{}", err.message);
    }
}
