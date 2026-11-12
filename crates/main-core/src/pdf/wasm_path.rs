//! `apps/pdf/src/main/wasm-path.ts`: where the runtime wasm assets live.
//!
//! They sit in `node_modules` during dev and tests; the packaged app ships no
//! `node_modules`, and electron-builder copies them into `Resources/wasm`.
//! `createRequire(import.meta.url).resolve(...)`, `existsSync` and
//! `process.resourcesPath` are the caller's: a [`WasmEnv`].

use crate::node_fs::NodeError;
use jscompat::node_path::host;

pub struct WasmEnv<'a> {
    /// `createRequire(import.meta.url).resolve(specifier)`; `None` is the throw
    pub resolve: &'a dyn Fn(&str) -> Option<String>,
    /// `existsSync(path)`
    pub exists: &'a dyn Fn(&str) -> bool,
    /// `process.resourcesPath`, `None` outside Electron
    pub resources_path: Option<&'a str>,
}

/// `join(process.resourcesPath, 'wasm', fileName)`: `path.join(undefined, ...)` throws
fn packaged_path(env: &WasmEnv<'_>, file_name: &str) -> Result<String, NodeError> {
    match env.resources_path {
        Some(resources) => Ok(host::join(&[resources, "wasm", file_name])),
        None => Err(NodeError {
            code: Some("ERR_INVALID_ARG_TYPE"),
            message: "The \"path\" argument must be of type string. Received undefined".to_owned(),
        }),
    }
}

pub fn pdfium_wasm_path(env: &WasmEnv<'_>) -> Result<String, NodeError> {
    match (env.resolve)("@embedpdf/pdfium/pdfium.wasm") {
        Some(path) => Ok(path),
        None => packaged_path(env, "pdfium.wasm"),
    }
}

/// qpdf, for adding and removing a PDF's password (the PDF tools window)
pub fn qpdf_wasm_path(env: &WasmEnv<'_>) -> Result<String, NodeError> {
    match (env.resolve)("@neslinesli93/qpdf-wasm") {
        Some(entry) => Ok(host::join(&[&host::dirname(&entry), "qpdf.wasm"])),
        None => packaged_path(env, "qpdf.wasm"),
    }
}

pub fn hb_subset_wasm_path(env: &WasmEnv<'_>) -> Result<String, NodeError> {
    // harfbuzzjs <=0.10 ships hb-subset.wasm at the package root with no exports map
    if let Some(path) = (env.resolve)("harfbuzzjs/hb-subset.wasm") {
        return Ok(path);
    }
    // harfbuzzjs >=1.x seals subpaths; the wasm sits next to the exported entry point
    if let Some(entry) = (env.resolve)("harfbuzzjs") {
        let p = host::join(&[&host::dirname(&entry), "harfbuzz-subset.wasm"]);
        if (env.exists)(&p) {
            return Ok(p);
        }
    }
    packaged_path(env, "hb-subset.wasm")
}
