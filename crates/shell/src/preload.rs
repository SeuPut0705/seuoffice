//! The preloads, bundled by `bridge/preloads.mjs` into `out/preloads/` and
//! embedded here: one script per surface (the stage 3 shell contract,
//! section 4), injected as the initialization script of a webview of that
//! surface. The match has no wildcard: a surface added to the channel table
//! does not compile until its preload is listed (and `PRELOADS` has it).

use shell_contract::Surface;

macro_rules! preloads {
    ($($surface:ident),* $(,)?) => {
        /// The bundle of a surface's preload
        pub fn source(surface: Surface) -> &'static str {
            match surface {
                $(Surface::$surface => include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/out/preloads/",
                    stringify!($surface),
                    ".js"
                )),)*
            }
        }
    };
}

preloads!(
    Diagram,
    Docs,
    Epub,
    Html,
    Hwp,
    Markdown,
    Mindmap,
    Pdf,
    Sheets,
    Shell,
    ShellAgent,
    ShellDocPicker,
    ShellGenerate,
    ShellInbox,
    ShellPdfPassword,
    ShellPdfTools,
    ShellQuickLook,
    ShellUpdate,
    Slides,
);

/// The page of `--measure-dialog`: the bridge and `window.measureIpc`
pub const MEASURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/out/preloads/_measure.js"
));
