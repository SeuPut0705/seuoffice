//! The run property builders of generate.ts, called by name.

use docx_engine::generate::rpr::merge_r_pr_model;
use docx_engine::model::Run;
use serde_json::Value;

use super::{Returned, arg, required, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "mergeRPrModel" => {
            let run: Run = required(args, "run")?;
            let inside_link: bool = arg(args, "insideLink")?.unwrap_or(false);
            value(merge_r_pr_model(text, &run, inside_link).map_err(|limit| limit.to_string())?)
        }
        _ => Err(format!("genRpr has no function {function}")),
    }
}
