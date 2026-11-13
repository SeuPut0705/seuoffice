//! Font channels: the installed-font queries of the docs, sheets and slides
//! renderers, and the PDF editor's fonts.
//!
//! What sits in the `ipcMain` handler bodies (argument filtering) is ported
//! here; `familyInfoFor`'s own filtering (non-array input, 256-unit names,
//! the first 5000) stays in the `FontQueries` implementation, as does
//! `familyVerticalMetrics`' normalisation.

use std::rc::Rc;

use jscompat::array_index;
use shell_contract::IpcValue;
use shell_contract::ipc::{RegisterError, Registry};
use shell_contract::value::BytesKind;

use crate::Ctx;
use crate::handler::{invoke, invoke_later};
use crate::value::{arg, as_str, from_serde, strings, to_serde};

/// `names.slice(0, 512)`
const ALIAS_NAMES_MAX: usize = 512;
/// `raw.length > 256`, in UTF-16 units
const ALIAS_NAME_MAX_UNITS: usize = 256;

/// What a handler passes on as `unknown`: `undefined` has no JSON form and
/// reaches the ports as `null`
fn as_serde(value: &IpcValue) -> serde_json::Value {
    to_serde(value).unwrap_or(serde_json::Value::Null)
}

/// The own keys of `out` as the renderer's object holds them: array-index
/// keys first in ascending order, the rest in insertion order
fn object_order(mut entries: Vec<(String, IpcValue)>) -> Vec<(String, IpcValue)> {
    let (mut indexed, rest): (Vec<_>, Vec<_>) = entries
        .drain(..)
        .partition(|(key, _)| array_index(key).is_some());
    indexed.sort_by_key(|(key, _)| array_index(key));
    indexed.extend(rest);
    indexed
}

pub(crate) fn register(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    invoke_later(registry, "app:font-family-info", {
        let cx = cx.clone();
        move |_, args, reply| {
            let families = as_serde(arg(&args, 0));
            let fonts = cx.fonts.clone();
            cx.services.workers.spawn(Box::new(move || {
                reply.reply(Ok(from_serde(&fonts.family_info_for(&families))))
            }));
        }
    })?;

    invoke_later(registry, "docs:font-metrics", {
        let cx = cx.clone();
        move |_, args, reply| {
            let Some(family) = as_str(arg(&args, 0)).map(str::to_owned) else {
                return reply.reply(Ok(IpcValue::Null));
            };
            let fonts = cx.fonts.clone();
            cx.services.workers.spawn(Box::new(move || {
                let metrics = fonts.family_vertical_metrics(&family);
                reply.reply(Ok(metrics.as_ref().map_or(IpcValue::Null, from_serde)))
            }));
        }
    })?;

    invoke_later(registry, "docs:font-aliases", {
        let cx = cx.clone();
        move |_, args, reply| {
            let IpcValue::Array(names) = arg(&args, 0) else {
                return reply.reply(Ok(IpcValue::Object(Vec::new())));
            };
            let names: Vec<String> = names
                .iter()
                .take(ALIAS_NAMES_MAX)
                .filter_map(as_str)
                .filter(|n| {
                    let units = n.encode_utf16().count();
                    units > 0 && units <= ALIAS_NAME_MAX_UNITS
                })
                .map(str::to_owned)
                .collect();
            let fonts = cx.fonts.clone();
            cx.services.workers.spawn(Box::new(move || {
                let mut out: Vec<(String, IpcValue)> = Vec::new();
                for name in names {
                    let aliases = fonts.family_aliases(&name);
                    // `out['__proto__'] = ...` sets the prototype, not a key
                    if aliases.is_empty() || name == "__proto__" {
                        continue;
                    }
                    let aliases = strings(aliases);
                    match out.iter_mut().find(|(key, _)| *key == name) {
                        Some((_, slot)) => *slot = aliases,
                        None => out.push((name, aliases)),
                    }
                }
                reply.reply(Ok(IpcValue::Object(object_order(out))))
            }));
        }
    })?;

    invoke_later(registry, "pdf:list-edit-fonts", {
        let cx = cx.clone();
        move |_, _, reply| {
            let fonts = cx.fonts.clone();
            cx.services.workers.spawn(Box::new(move || {
                reply.reply(Ok(strings(fonts.list_edit_fonts())))
            }));
        }
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use shell_contract::channels::Surface;

    use super::*;
    use crate::testkit::{Probe, sender};
    use crate::value::object;

    fn text(value: &str) -> IpcValue {
        IpcValue::String(value.to_owned())
    }

    fn call(p: &Probe, surface: Surface, channel: &str, args: Vec<IpcValue>) -> IpcValue {
        p.call(sender(1, surface), channel, args).unwrap()
    }

    fn probe(config: serde_json::Value) -> Probe {
        Probe::new(
            config,
            vec![sender(1, Surface::Docs), sender(1, Surface::Pdf)],
        )
    }

    #[test]
    fn family_info_forwards_what_the_renderer_sent() {
        let info = json!([["Malgun Gothic", { "ko": "x", "hangul": true }]]);
        let p = probe(json!({ "familyInfo": info }));
        let answer = call(
            &p,
            Surface::Docs,
            "app:font-family-info",
            vec![strings(["A", "B"])],
        );
        assert_eq!(answer, from_serde(&info));
        // `undefined` and a non-array go through as the port gets them: null / the value
        call(&p, Surface::Docs, "app:font-family-info", vec![]);
        call(&p, Surface::Docs, "app:font-family-info", vec![text("A")]);
        assert_eq!(
            p.take_calls(),
            vec![
                r#"familyInfo ["A","B"]"#,
                "familyInfo null",
                r#"familyInfo "A""#
            ]
        );
    }

    #[test]
    fn font_metrics_answers_null_for_a_non_string_or_an_unknown_family() {
        let metrics = json!({ "unitsPerEm": 1000, "hheaAscender": 900 });
        let p = probe(json!({ "metrics": { "Batang": metrics } }));
        assert_eq!(
            call(&p, Surface::Docs, "docs:font-metrics", vec![text("Batang")]),
            from_serde(&metrics)
        );
        for arg in [
            text("Unknown"),
            IpcValue::Number(1.0),
            IpcValue::Null,
            IpcValue::Undefined,
        ] {
            assert_eq!(
                call(&p, Surface::Docs, "docs:font-metrics", vec![arg]),
                IpcValue::Null
            );
        }
        // an empty answer object is an answer, not null
        let p = probe(json!({ "metrics": { "": {} } }));
        assert_eq!(
            call(&p, Surface::Docs, "docs:font-metrics", vec![text("")]),
            IpcValue::Object(vec![])
        );
    }

    #[test]
    fn font_aliases_keeps_only_usable_names_and_the_first_512() {
        let p = probe(json!({ "aliases": {
            "Malgun": ["Malgun Gothic", "Malgun Gothic Regular"],
            "Batang": ["Batang English"],
            "late": ["Late Alias"],
            "__proto__": ["x"],
            "12": ["Twelve"],
            "Zed": ["Zed Alias"],
        } }));
        let long = "n".repeat(257);
        let names = IpcValue::Array(vec![
            text("Zed"),
            text("Malgun"),
            text(""),
            IpcValue::Number(5.0),
            text(&long),
            text("NoAliases"),
            text("Batang"),
            text("Malgun"),
            text("__proto__"),
            text("12"),
        ]);
        assert_eq!(
            call(&p, Surface::Docs, "docs:font-aliases", vec![names]),
            object([
                ("12", strings(["Twelve"])),
                ("Zed", strings(["Zed Alias"])),
                (
                    "Malgun",
                    strings(["Malgun Gothic", "Malgun Gothic Regular"])
                ),
                ("Batang", strings(["Batang English"])),
            ])
        );

        // a name of exactly 256 units is kept; astral characters count twice
        let edge = "e".repeat(256);
        let astral = "\u{1F600}".repeat(129);
        let p = probe(json!({ "aliases": { edge.clone(): ["E"], astral.clone(): ["A"] } }));
        assert_eq!(
            call(
                &p,
                Surface::Docs,
                "docs:font-aliases",
                vec![IpcValue::Array(vec![text(&edge), text(&astral)])]
            ),
            object([(edge.as_str(), strings(["E"]))])
        );

        // only the first 512 entries count, bad ones included
        let p = probe(json!({ "aliases": { "late": ["Late Alias"], "early": ["Early Alias"] } }));
        let mut many = vec![text("early")];
        many.extend((0..511).map(|_| IpcValue::Null));
        many.push(text("late"));
        assert_eq!(
            call(
                &p,
                Surface::Docs,
                "docs:font-aliases",
                vec![IpcValue::Array(many)]
            ),
            object([("early", strings(["Early Alias"]))])
        );
    }

    #[test]
    fn font_aliases_of_a_non_array_is_an_empty_object() {
        let p = probe(json!({ "aliases": { "a": ["b"] } }));
        for arg in [
            text("a"),
            IpcValue::Null,
            IpcValue::Undefined,
            object([("0", text("a"))]),
        ] {
            assert_eq!(
                call(&p, Surface::Docs, "docs:font-aliases", vec![arg]),
                IpcValue::Object(vec![])
            );
        }
    }

    #[test]
    fn list_edit_fonts_answers_the_ids_the_host_found() {
        let p = probe(json!({ "editFonts": ["arial", "courier"] }));
        assert_eq!(
            call(&p, Surface::Pdf, "pdf:list-edit-fonts", vec![]),
            strings(["arial", "courier"])
        );
        let none = probe(json!({}));
        assert_eq!(
            call(&none, Surface::Pdf, "pdf:list-edit-fonts", vec![]),
            strings(Vec::<String>::new())
        );
    }
}
