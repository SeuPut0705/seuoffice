# tauri-runtime-cef 3.0.0-alpha.7, vendored

The CEF runtime of the Tauri shell in `crates/shell`. This directory is the crate
as crates.io publishes it, plus the patch below, and is used through
`[patch.crates-io]` in `crates/shell/Cargo.toml` (the shell is its own workspace).
It is not a member of the `crates/` workspace (`exclude = ["vendor", ...]` in
`crates/Cargo.toml`): `cargo fmt`, `cargo clippy` and the workspace tests leave it
as it is.

- **Source**: <https://crates.io/crates/tauri-runtime-cef/3.0.0-alpha.7>,
  repository <https://github.com/tauri-apps/tauri>, path `crates/tauri-runtime-cef`
  at `81bfb7ca8f1a17be1e48c9b0d167c77b2137f9d3` (`.cargo_vcs_info.json`).
- **Archive checksum** (SHA-256 of `tauri-runtime-cef-3.0.0-alpha.7.crate`, as
  `crates/shell/Cargo.lock` recorded it before vendoring):
  `c17121b17ba1bc49b9346ece93a42da70a43abdd0d793493838c4f0d8620ec36`.
- **License**: Apache-2.0 OR MIT (`Cargo.toml`), Copyright 2019-2024 Tauri
  Programme within The Commons Conservancy (source headers).
- **Not from the archive**: the archive carries no licence text. `LICENSE-MIT` and
  `LICENSE-APACHE-2.0` here are the copies the sibling crate `tauri-utils` 2.10.2
  ships. The archive's `.cargo-ok` registry marker is left out.
- **Otherwise unmodified**: every other file, including `Cargo.lock` and `tests/`.

## Why

The runtime builds Chrome style browsers and always shows Chrome's own page context
menu, filtered in `src/cef_impl/client/context_menu.rs`. CEF lets a client replace
that menu only from `CefContextMenuHandler::RunContextMenu`, and the runtime has no
hook to it. The shell must replace it: the docs editor draws its own menu in the
renderer, and every other page gets a native menu with spelling suggestions and
cut/copy/paste/select all/view image/copy image/save image as, built by main-core.

## Patches

`patches/0001-context-menu-hook.patch` (`diff -ruN` of the pristine tree against
this one, `a/` = pristine):

1. **Context menu hook**
   - `src/context_menu.rs` (new): `set_context_menu_handler`, `ContextMenuParams`,
     `EditFlags`, `ContextMenuDone`, re-exported from `src/lib.rs` (line 9).
     The handler is process wide and runs on the CEF UI thread with the webview's
     label; returning `true` takes the menu over, `false` keeps the filtered Chrome
     menu. `ContextMenuDone` holds the CEF callback (`RefGuard` is `Send`) and
     cancels on drop; `cancel` from another thread posts to the UI thread.
   - `src/cef_impl/client/context_menu.rs`: `run_context_menu` added to the handler
     (calls `crate::context_menu::run`); the handler struct takes the webview
     `label`.
   - `src/cef_impl/client/mod.rs:254`: passes `self.label.clone()`.

## Re-vendoring

Unpack the new release over this directory, keep the two licence files, apply
`patches/0001-context-menu-hook.patch` (`patch -p1`), fix what moved, regenerate the
patch with `diff -ruN` against the pristine copy, and update the version and
checksum above. Check with
`cargo check --manifest-path crates/vendor/tauri-runtime-cef/Cargo.toml --features cef/dox`
and `bash crates/shell/ci/check-local.sh check`. Drop the directory and the
`[patch.crates-io]` entry when upstream has an equivalent hook.
