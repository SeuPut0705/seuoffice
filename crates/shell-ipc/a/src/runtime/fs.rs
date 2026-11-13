//! The file system calls of the ported code (`node:fs/promises`), carried out
//! with `std::fs` and failing as Node fails: the message and `code` of
//! `main_core::node_fs`.

use std::fs;
use std::io::Write;
use std::time::UNIX_EPOCH;

use jscompat::JsonValue;
#[cfg(not(unix))]
use main_core::node_fs::node_error_named;
use main_core::node_fs::{NodeError, code_of, mkdtemp_random, node_error, node_error2};
use main_core::packages::ai_provider::task::{
    DirEntry, FileKind, FileStat, FsAnswer, FsOp, JsError,
};

fn thrown(e: NodeError) -> JsError {
    let mut error = JsError::error(e.message);
    if let Some(code) = e.code {
        error = error.with("code", JsonValue::String(code.into()));
    }
    error
}

fn kind_of(file_type: fs::FileType) -> FileKind {
    if file_type.is_symlink() {
        FileKind::Symlink
    } else if file_type.is_dir() {
        FileKind::Dir
    } else if file_type.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    }
}

fn stat_of(meta: &fs::Metadata) -> FileStat {
    let mtime_ms = match meta.modified().map(|t| t.duration_since(UNIX_EPOCH)) {
        Ok(Ok(after)) => after.as_secs_f64() * 1000.0,
        Ok(Err(before)) => -before.duration().as_secs_f64() * 1000.0,
        Err(_) => 0.0,
    };
    #[cfg(unix)]
    let mode = f64::from(std::os::unix::fs::MetadataExt::mode(meta));
    #[cfg(not(unix))]
    let mode = if meta.permissions().readonly() {
        // what Node reports for a read-only file or folder on Windows
        0o100444 as f64
    } else {
        0o100666 as f64
    };
    FileStat {
        kind: kind_of(meta.file_type()),
        size: meta.len() as f64,
        mtime_ms,
        mode,
    }
}

/// `open(path, flag, mode)` for the flags `writeFile` takes
fn write_options(flag: Option<&str>, mode: Option<f64>) -> Result<fs::OpenOptions, JsError> {
    let mut options = fs::OpenOptions::new();
    options.write(true);
    match flag.unwrap_or("w") {
        "w" => options.create(true).truncate(true),
        "wx" | "xw" => options.create_new(true),
        "a" => options.create(true).append(true),
        "ax" | "xa" => options.create_new(true).append(true),
        other => {
            return Err(JsError::type_error(format!(
                "The argument 'flags' is invalid. Received '{other}'"
            ))
            .with("code", JsonValue::String("ERR_INVALID_ARG_VALUE".into())));
        }
    };
    // `mode` applies to a file this call creates, as `open(2)` does
    #[cfg(unix)]
    if let Some(mode) = mode {
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode as u32);
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(options)
}

fn mkdir(path: &str, recursive: bool, mode: Option<f64>) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    if let Some(mode) = mode {
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, mode as u32);
    }
    #[cfg(not(unix))]
    let _ = mode;
    builder.create(path)
}

/// `fs.promises.rm(path, { recursive, force })`
fn rm(path: &str, recursive: bool, force: bool) -> Result<(), NodeError> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if force && code_of(&e) == Some("ENOENT") => return Ok(()),
        Err(e) => return Err(node_error(&e, "lstat", path)),
    };
    let done = if meta.is_dir() {
        if !recursive {
            return Err(NodeError {
                code: Some("ERR_FS_EISDIR"),
                message: format!("Path is a directory: rm returned EISDIR (is a directory) {path}"),
            });
        }
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    done.map_err(|e| node_error(&e, "rm", path))
}

/// `readdir`: libuv sorts the names of a scandir by byte
fn readdir(path: &str, with_types: bool) -> Result<Vec<DirEntry>, NodeError> {
    let mut entries: Vec<DirEntry> = fs::read_dir(path)
        .map_err(|e| node_error(&e, "scandir", path))?
        .filter_map(Result::ok)
        .map(|entry| DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: with_types
                .then(|| entry.file_type().ok().map(kind_of))
                .flatten(),
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// `fs.promises.realpath`: a path as Windows names it, without the `\\?\`
/// that `canonicalize` puts before it
fn realpath(path: &str) -> Result<String, NodeError> {
    let real = fs::canonicalize(path).map_err(|e| node_error(&e, "realpath", path))?;
    let text = real.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(rest.to_owned());
        }
    }
    Ok(text)
}

fn chmod(path: &str, mode: f64) -> Result<(), NodeError> {
    #[cfg(unix)]
    {
        let permissions = std::os::unix::fs::PermissionsExt::from_mode(mode as u32);
        fs::set_permissions(path, permissions).map_err(|e| node_error(&e, "chmod", path))
    }
    #[cfg(not(unix))]
    {
        // on Windows a mode only turns the read-only attribute on or off
        let mut permissions = fs::metadata(path)
            .map_err(|e| node_error(&e, "chmod", path))?
            .permissions();
        permissions.set_readonly((mode as u32) & 0o200 == 0);
        fs::set_permissions(path, permissions).map_err(|e| node_error(&e, "chmod", path))
    }
}

/// `fs.promises.access(path, mode)`
fn access(path: &str, mode: f64) -> Result<(), NodeError> {
    #[cfg(unix)]
    {
        let c_path = std::ffi::CString::new(path).map_err(|_| NodeError {
            code: Some("ERR_INVALID_ARG_VALUE"),
            message: format!("The argument 'path' must be a string without null bytes: {path}"),
        })?;
        // SAFETY: `c_path` is a valid NUL-terminated string that outlives the call
        if unsafe { libc::access(c_path.as_ptr(), mode as libc::c_int) } == 0 {
            Ok(())
        } else {
            Err(node_error(&std::io::Error::last_os_error(), "access", path))
        }
    }
    #[cfg(not(unix))]
    {
        let meta = fs::metadata(path).map_err(|e| node_error(&e, "access", path))?;
        // W_OK of a read-only file fails on Windows
        if (mode as u32) & 2 != 0 && meta.permissions().readonly() {
            return Err(node_error_named("EPERM", "access", path));
        }
        Ok(())
    }
}

/// Carries `op` out on the calling thread
pub fn run(op: &FsOp) -> Result<FsAnswer, JsError> {
    run_node(op).map_err(thrown_either)
}

/// What `run` fails with: a Node system error, or an error of the call's own
enum Failure {
    Node(NodeError),
    Js(JsError),
}

impl From<NodeError> for Failure {
    fn from(e: NodeError) -> Self {
        Failure::Node(e)
    }
}

impl From<JsError> for Failure {
    fn from(e: JsError) -> Self {
        Failure::Js(e)
    }
}

fn thrown_either(e: Failure) -> JsError {
    match e {
        Failure::Node(e) => thrown(e),
        Failure::Js(e) => e,
    }
}

fn run_node(op: &FsOp) -> Result<FsAnswer, Failure> {
    Ok(match op {
        FsOp::ReadFile { path } => {
            FsAnswer::Bytes(fs::read(path).map_err(|e| node_error(&e, "open", path))?)
        }
        FsOp::WriteFile {
            path,
            data,
            mode,
            flag,
        } => {
            let mut file = write_options(flag.as_deref(), *mode)?
                .open(path)
                .map_err(|e| node_error(&e, "open", path))?;
            file.write_all(data)
                .map_err(|e| node_error(&e, "write", path))?;
            FsAnswer::Unit
        }
        FsOp::Mkdir {
            path,
            recursive,
            mode,
        } => {
            mkdir(path, *recursive, *mode).map_err(|e| node_error(&e, "mkdir", path))?;
            FsAnswer::Unit
        }
        FsOp::Mkdtemp { prefix } => FsAnswer::Path(mkdtemp_random(prefix)?),
        FsOp::Rm {
            path,
            recursive,
            force,
        } => {
            rm(path, *recursive, *force)?;
            FsAnswer::Unit
        }
        FsOp::Readdir { path, with_types } => FsAnswer::Entries(readdir(path, *with_types)?),
        FsOp::Stat { path } => FsAnswer::Stat(stat_of(
            &fs::metadata(path).map_err(|e| node_error(&e, "stat", path))?,
        )),
        FsOp::Lstat { path } => FsAnswer::Stat(stat_of(
            &fs::symlink_metadata(path).map_err(|e| node_error(&e, "lstat", path))?,
        )),
        FsOp::Realpath { path } => FsAnswer::Path(realpath(path)?),
        FsOp::Readlink { path } => FsAnswer::Path(
            fs::read_link(path)
                .map_err(|e| node_error(&e, "readlink", path))?
                .to_string_lossy()
                .into_owned(),
        ),
        FsOp::Rename { from, to } => {
            fs::rename(from, to).map_err(|e| node_error2(&e, "rename", from, to))?;
            FsAnswer::Unit
        }
        FsOp::Chmod { path, mode } => {
            chmod(path, *mode)?;
            FsAnswer::Unit
        }
        FsOp::Access { path, mode } => {
            access(path, *mode)?;
            FsAnswer::Unit
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "seuoffice-runtime-fs-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn p(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn code(e: &JsError) -> String {
        match e.prop("code") {
            Some(JsonValue::String(code)) => code.clone(),
            other => panic!("no code: {other:?}"),
        }
    }

    fn write(path: &str, text: &str, flag: Option<&str>) -> Result<FsAnswer, JsError> {
        run(&FsOp::WriteFile {
            path: path.to_owned(),
            data: text.as_bytes().to_vec(),
            mode: None,
            flag: flag.map(str::to_owned),
        })
    }

    #[test]
    fn a_file_is_written_read_replaced_and_appended() {
        let dir = temp("write");
        let file = p(&dir.join("a.txt"));
        write(&file, "one", None).unwrap();
        write(&file, "two", None).unwrap();
        assert_eq!(
            run(&FsOp::ReadFile { path: file.clone() }).unwrap(),
            FsAnswer::Bytes(b"two".to_vec())
        );
        write(&file, "+more", Some("a")).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "two+more");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn flag_wx_fails_on_a_file_that_exists_and_leaves_it() {
        let dir = temp("wx");
        let file = p(&dir.join("lock"));
        write(&file, "first", Some("wx")).unwrap();
        let err = write(&file, "second", Some("wx")).unwrap_err();
        assert_eq!(code(&err), "EEXIST");
        assert!(err.message.starts_with("EEXIST: file already exists, open"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "first");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_flag_node_does_not_know_throws_a_type_error() {
        let dir = temp("flag");
        let err = write(&p(&dir.join("f")), "x", Some("zz")).unwrap_err();
        assert!(err.is("TypeError"));
        assert_eq!(code(&err), "ERR_INVALID_ARG_VALUE");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn mode_is_the_mode_of_the_created_file_and_chmod_changes_it() {
        let dir = temp("mode");
        let file = p(&dir.join("secret"));
        run(&FsOp::WriteFile {
            path: file.clone(),
            data: b"k".to_vec(),
            mode: Some(0o600 as f64),
            flag: None,
        })
        .unwrap();
        let FsAnswer::Stat(stat) = run(&FsOp::Stat { path: file.clone() }).unwrap() else {
            panic!("no stat")
        };
        assert_eq!(stat.mode as u32 & 0o777, 0o600);
        assert_eq!(stat.kind, FileKind::File);
        assert_eq!(stat.size, 1.0);
        run(&FsOp::Chmod {
            path: file.clone(),
            mode: 0o640 as f64,
        })
        .unwrap();
        let FsAnswer::Stat(stat) = run(&FsOp::Stat { path: file }).unwrap() else {
            panic!("no stat")
        };
        assert_eq!(stat.mode as u32 & 0o777, 0o640);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mkdir_creates_nested_folders_only_when_recursive() {
        let dir = temp("mkdir");
        let nested = p(&dir.join("a").join("b"));
        let err = run(&FsOp::Mkdir {
            path: nested.clone(),
            recursive: false,
            mode: None,
        })
        .unwrap_err();
        assert_eq!(code(&err), "ENOENT");
        run(&FsOp::Mkdir {
            path: nested.clone(),
            recursive: true,
            mode: None,
        })
        .unwrap();
        // recursive over a folder that exists is fine, plain is EEXIST
        run(&FsOp::Mkdir {
            path: nested.clone(),
            recursive: true,
            mode: None,
        })
        .unwrap();
        let err = run(&FsOp::Mkdir {
            path: nested,
            recursive: false,
            mode: None,
        })
        .unwrap_err();
        assert_eq!(code(&err), "EEXIST");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mkdtemp_makes_a_folder_named_by_the_prefix() {
        let dir = temp("mkdtemp");
        let prefix = p(&dir.join("job-"));
        let FsAnswer::Path(made) = run(&FsOp::Mkdtemp {
            prefix: prefix.clone(),
        })
        .unwrap() else {
            panic!("no path")
        };
        assert!(made.starts_with(&prefix));
        assert_eq!(made.len(), prefix.len() + 6);
        assert!(fs::metadata(&made).unwrap().is_dir());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rm_takes_files_folders_and_a_missing_path_by_force() {
        let dir = temp("rm");
        let file = p(&dir.join("f"));
        let sub = dir.join("sub");
        fs::create_dir_all(sub.join("deep")).unwrap();
        fs::write(&file, "x").unwrap();
        let rm = |path: &str, recursive, force| {
            run(&FsOp::Rm {
                path: path.to_owned(),
                recursive,
                force,
            })
        };
        rm(&file, false, false).unwrap();
        assert!(!dir.join("f").exists());
        let err = rm(&file, false, false).unwrap_err();
        assert_eq!(code(&err), "ENOENT");
        rm(&file, false, true).unwrap();
        let err = rm(&p(&sub), false, false).unwrap_err();
        assert_eq!(code(&err), "ERR_FS_EISDIR");
        rm(&p(&sub), true, false).unwrap();
        assert!(!sub.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn readdir_lists_by_name_with_the_kinds_asked_for() {
        let dir = temp("readdir");
        fs::write(dir.join("b.txt"), "x").unwrap();
        fs::write(dir.join("a.txt"), "x").unwrap();
        fs::create_dir(dir.join("c")).unwrap();
        let entry = |name: &str, kind| DirEntry {
            name: name.to_owned(),
            kind,
        };
        assert_eq!(
            run(&FsOp::Readdir {
                path: p(&dir),
                with_types: false
            })
            .unwrap(),
            FsAnswer::Entries(vec![
                entry("a.txt", None),
                entry("b.txt", None),
                entry("c", None)
            ])
        );
        assert_eq!(
            run(&FsOp::Readdir {
                path: p(&dir),
                with_types: true
            })
            .unwrap(),
            FsAnswer::Entries(vec![
                entry("a.txt", Some(FileKind::File)),
                entry("b.txt", Some(FileKind::File)),
                entry("c", Some(FileKind::Dir)),
            ])
        );
        let err = run(&FsOp::Readdir {
            path: p(&dir.join("a.txt")),
            with_types: false,
        })
        .unwrap_err();
        assert_eq!(code(&err), "ENOTDIR");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rename_moves_a_file_and_names_both_paths_on_failure() {
        let dir = temp("rename");
        let from = p(&dir.join("from"));
        let to = p(&dir.join("to"));
        fs::write(&from, "x").unwrap();
        run(&FsOp::Rename {
            from: from.clone(),
            to: to.clone(),
        })
        .unwrap();
        assert!(!dir.join("from").exists() && dir.join("to").exists());
        let err = run(&FsOp::Rename {
            from: from.clone(),
            to: to.clone(),
        })
        .unwrap_err();
        assert_eq!(code(&err), "ENOENT");
        assert!(err.message.contains(&from) && err.message.contains(&to));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn access_answers_for_what_exists_and_fails_for_what_does_not() {
        let dir = temp("access");
        let file = p(&dir.join("f"));
        fs::write(&file, "x").unwrap();
        run(&FsOp::Access {
            path: file.clone(),
            mode: 0.0,
        })
        .unwrap();
        let err = run(&FsOp::Access {
            path: p(&dir.join("none")),
            mode: 0.0,
        })
        .unwrap_err();
        assert_eq!(code(&err), "ENOENT");
        assert!(
            err.message
                .starts_with("ENOENT: no such file or directory, access")
        );
        #[cfg(unix)]
        {
            // a plain file is not executable
            let err = run(&FsOp::Access {
                path: file,
                mode: 1.0,
            })
            .unwrap_err();
            assert_eq!(code(&err), "EACCES");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn lstat_sees_a_link_stat_follows_it_and_readlink_reads_it() {
        let dir = temp("link");
        let target = dir.join("target");
        let link = dir.join("link");
        fs::write(&target, "abc").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let kind = |op: FsOp| match run(&op).unwrap() {
            FsAnswer::Stat(stat) => stat.kind,
            other => panic!("{other:?}"),
        };
        assert_eq!(kind(FsOp::Lstat { path: p(&link) }), FileKind::Symlink);
        assert_eq!(kind(FsOp::Stat { path: p(&link) }), FileKind::File);
        assert_eq!(
            run(&FsOp::Readlink { path: p(&link) }).unwrap(),
            FsAnswer::Path(p(&target))
        );
        let FsAnswer::Path(real) = run(&FsOp::Realpath { path: p(&link) }).unwrap() else {
            panic!("no path")
        };
        assert_eq!(real, p(&fs::canonicalize(&target).unwrap()));
        fs::remove_dir_all(dir).unwrap();
    }
}
