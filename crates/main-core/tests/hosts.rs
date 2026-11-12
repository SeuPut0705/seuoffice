//! main-core is called by two hosts: the Node-API addon (main-node) while
//! Electron stays, and the command layer of the Tauri 3 shell of stage 3
//! (decisions 0029 and 0030). Neither may leak into it: no dependency on a
//! host's crate, and no host's name in its code. The hosts adapt to main-core,
//! never the other way.

use std::fs;
use std::path::Path;

const HOST_CRATES: &[&str] = &[
    "napi",
    "napi-derive",
    "napi-sys",
    "tauri",
    "neon",
    "wry",
    "cef",
];

#[test]
fn the_manifest_names_no_host() {
    let manifest = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
        .expect("the manifest reads");
    for line in manifest.lines() {
        let key = line.split('=').next().unwrap_or("").trim();
        assert!(
            !HOST_CRATES.contains(&key),
            "main-core depends on the host crate {key}"
        );
    }
}

#[test]
fn the_code_names_no_host() {
    let mut offenders = Vec::new();
    walk(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut offenders,
    );
    assert!(
        offenders.is_empty(),
        "host crates used in main-core: {offenders:?}"
    );
}

fn walk(dir: &Path, offenders: &mut Vec<String>) {
    for entry in fs::read_dir(dir).expect("src reads") {
        let path = entry.expect("an entry").path();
        if path.is_dir() {
            walk(&path, offenders);
            continue;
        }
        let text = fs::read_to_string(&path).expect("a source file reads");
        for (n, line) in text.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            for host in HOST_CRATES {
                let name = host.replace('-', "_");
                if code.contains(&format!("{name}::")) || code.contains(&format!("use {name}")) {
                    offenders.push(format!("{}:{}", path.display(), n + 1));
                }
            }
        }
    }
}
