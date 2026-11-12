//! `ink.*`: ink.ts. `constants` answers `args.name`; `INK_REL_RE` is
//! `text.match(INK_REL_RE)` and `INK_MEDIA_PATH_RE` is `.test(text)`.
//! `anchoredInkRunXml` takes `args.ink`, `args.rId` and `args.docPrId`, a
//! null docPrId standing for NaN. A number with no XML text is the call's error.

use docx_engine::ink;
use docx_engine::model::NewInkImage;
use jscompat::JsNum;
use serde_json::Value;

use super::{Returned, arg, required, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "constants" => match required::<String>(args, "name")?.as_str() {
            "INK_NAME_PREFIX" => value(ink::INK_NAME_PREFIX),
            "INK_MEDIA_PREFIX" => value(ink::INK_MEDIA_PREFIX),
            name => Err(format!("no constant {name}")),
        },
        "INK_REL_RE" => {
            let found: Vec<&str> = ink::ink_rel_re()
                .find_iter(text)
                .map(|m| m.as_str())
                .collect();
            value((!found.is_empty()).then_some(found))
        }
        "INK_MEDIA_PATH_RE" => value(ink::ink_media_path_re().test(text)),
        "anchoredInkRunXml" => value(ink::anchored_ink_run_xml(
            &required::<NewInkImage>(args, "ink")?,
            &required::<String>(args, "rId")?,
            arg::<JsNum>(args, "docPrId")?.unwrap_or(JsNum(f64::NAN)),
        )?),
        "stripInkRuns" => value(ink::strip_ink_runs(text)),
        "findInkRuns" => value(ink::find_ink_runs(text)),
        "injectInkRunsIntoParagraph" => value(ink::inject_ink_runs_into_paragraph(
            text,
            &required::<String>(args, "runsXml")?,
        )),
        _ => Err(format!("no function {function}")),
    }
}
