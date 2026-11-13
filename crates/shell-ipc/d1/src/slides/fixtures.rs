//! What a probe case puts into the fake deck: `hosts.d1.slides.fixtures`, the
//! deck's notes, links, transitions and the rest the real engine reads out of
//! a pptx. `tools/ipc-diff/d1/slides-engine.ts` reads the same keys and
//! answers the same, so the handlers are compared on a deck that has something
//! in it:
//!
//! - by slide index (applied to each slide when a deck is opened, so they
//!   travel with the slide when it moves): `notes` (text), `transitions`
//!   (kind), `advanceMs` (number), `narration` (element spids),
//!   `animations` (`[{spid, effect, trigger, durationMs, delayMs, ...}]`),
//!   `headerFooter` (`{footer, slideNum, date}`);
//! - by element id: `links` (a link target), `runLinks` (`[{start, end, ...}]`),
//!   `charts` (what `getChartElementData` answers), `media` (`{kind, target,
//!   external}`: the element is a picture with this media), `models`
//!   (`{target}`: a picture with a 3D model), `redact` (a label: the element is
//!   withheld from the model);
//! - the deck as a whole: `parts` (archive entries by path, as text),
//!   `sections` (`[{id, name, slideIndices}]`), `fontFaces` (the private font
//!   list), `fontData` (by face id).
//!
//! An element's spid is the number in its id (`e3` is 3).

use serde_json::Value;
use shell_contract::IpcValue;

/// The case's fixtures
#[derive(Clone, Default)]
pub struct Fixtures(pub Value);

impl Fixtures {
    /// `fixtures[key][index]`
    pub fn at(&self, key: &str, index: usize) -> &Value {
        &self.0[key][index.to_string()]
    }

    /// `fixtures[key][id]`
    pub fn by(&self, key: &str, id: &str) -> &Value {
        &self.0[key][id]
    }

    pub fn list(&self, key: &str) -> Vec<Value> {
        self.0[key].as_array().cloned().unwrap_or_default()
    }
}

/// The spid of an element: `e12` is 12
pub fn spid_of(id: &str) -> Option<i64> {
    let digits = id.strip_prefix('e')?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

/// A fixture value as the renderer receives it
pub fn ipc_of(value: &Value) -> IpcValue {
    match value {
        Value::Null => IpcValue::Null,
        Value::Bool(flag) => IpcValue::Bool(*flag),
        Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => IpcValue::String(text.clone()),
        Value::Array(items) => IpcValue::Array(items.iter().map(ipc_of).collect()),
        Value::Object(entries) => IpcValue::Object(
            entries
                .iter()
                .map(|(key, item)| (key.clone(), ipc_of(item)))
                .collect(),
        ),
    }
}

/// `normalizeSections(sections, total)` of `sections.ts`: the slides of the
/// lead (sectionless) part and of each section, whatever the file said
pub fn normalize_sections(sections: &[Value], total: usize) -> (Vec<usize>, Vec<Vec<usize>>) {
    if sections.is_empty() {
        return ((0..total).collect(), Vec::new());
    }
    let mut starts = vec![0usize; sections.len()];
    let mut next = total;
    for i in (0..sections.len()).rev() {
        let mut own = next;
        for k in sections[i]["slideIndices"].as_array().into_iter().flatten() {
            own = own.min(k.as_f64().map_or(own, |k| k.max(0.0) as usize));
        }
        starts[i] = own.min(next);
        next = starts[i];
    }
    let lead = (0..starts[0]).collect();
    let ranges = (0..sections.len())
        .map(|i| {
            let end = starts.get(i + 1).copied().unwrap_or(total);
            (starts[i]..end).collect()
        })
        .collect();
    (lead, ranges)
}
