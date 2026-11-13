//! The probe fakes of the `template_selection` port: the slides sessions
//! batch D1 provides. `hosts.a.slidesDocs` maps a view to its deck,
//! `{ "<view>": { "id": n, "path": "..." } }` (`path` "" for a deck never
//! saved); a view not listed has no session. The TypeScript side of the group
//! (`groups/a/template-selection.ts`) puts the same sessions in
//! `session-state.ts`'s map.

use std::rc::Rc;

use serde_json::Value;
use shell_contract::Hosts;
use shell_contract::ViewId;
use shell_contract::slides::{SlidesDocument, SlidesDocuments};

use crate::Factory;
use crate::ports::SlidesTemplateSelection;

struct Decks(Vec<(u32, SlidesDocument)>);

impl SlidesDocuments for Decks {
    fn document(&self, view: ViewId) -> Option<SlidesDocument> {
        self.0
            .iter()
            .find(|(v, _)| *v == view.0)
            .map(|(_, doc)| doc.clone())
    }
}

fn decks(case: &Value) -> Vec<(u32, SlidesDocument)> {
    let Some(listed) = case["slidesDocs"].as_object() else {
        return Vec::new();
    };
    listed
        .iter()
        .filter_map(|(view, doc)| {
            Some((
                view.parse().ok()?,
                SlidesDocument {
                    id: doc["id"].as_u64()?,
                    path: doc["path"].as_str().unwrap_or("").to_owned(),
                },
            ))
        })
        .collect()
}

/// The port over the case's sessions
pub fn insert(hosts: &mut Hosts, case: &Value) {
    let listed = decks(case);
    let build = crate::template_selection::factory().0;
    hosts.insert(Factory::<dyn SlidesTemplateSelection>::new(
        move |services, provided| {
            provided.add::<dyn SlidesDocuments>(Rc::new(Decks(listed.clone())));
            build(services, provided)
        },
    ));
}
