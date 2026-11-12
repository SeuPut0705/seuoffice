use docx_engine::generate::runs::inline_runs_xml;
use docx_engine::model::Run;
use serde_json::Value;

use super::{Returned, required, value};

pub fn dispatch(function: &str, _text: &str, args: &Value) -> Returned {
    match function {
        "inlineRunsXml" => value(
            inline_runs_xml(&required::<Vec<Run>>(args, "runs")?)
                .map_err(|limit| limit.to_string())?,
        ),
        _ => Err(format!("unknown function {function}")),
    }
}
