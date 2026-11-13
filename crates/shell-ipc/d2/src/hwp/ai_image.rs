//! Picture channels of the Hangul editor's AI panel (`apps/hwp/src/main/ai-image.ts`):
//! `hwp:fetch-image` and `hwp:analyze-media`. (`hwp:ai-generate-image` belongs
//! to batch A.)
//!
//! The bytes are the renderer's business; this side only reaches the network
//! (`fetchImageBytes`) or the configured reader (`analyzeMediaTool`), both
//! behind [`super::HwpEngine`].

use std::sync::Arc;

use shell_contract::ipc::RegisterError;
use shell_contract::runtime::{PathName, Services};
use shell_contract::{Batch, BytesKind, IpcValue};

use super::HwpEngineHost;
use crate::kit::{self, Entry, IntoIpc, obj};

/// `FetchedImageBytes`
#[derive(Clone, Debug, PartialEq)]
pub struct FetchedImage {
    pub base64: String,
    /// `image/png`, `image/jpeg` or `image/gif`
    pub mime: String,
}

/// `String(value)` of what a renderer may send
fn js_string(v: &IpcValue) -> String {
    match v {
        IpcValue::Undefined => "undefined".to_owned(),
        IpcValue::Null => "null".to_owned(),
        IpcValue::Bool(b) => b.to_string(),
        IpcValue::Number(n) => jscompat::number_to_string(*n),
        IpcValue::String(s) => s.clone(),
        // an array joins its items with commas, `null` and `undefined` as nothing
        IpcValue::Array(items) => items
            .iter()
            .map(|item| match item {
                IpcValue::Null | IpcValue::Undefined => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        IpcValue::Bytes(BytesKind::ArrayBuffer, _) => "[object ArrayBuffer]".to_owned(),
        IpcValue::Bytes(BytesKind::Uint8Array, bytes) => bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(","),
        // a date prints in the local zone; the shell has no zone to ask
        IpcValue::Date(_) => "Invalid Date".to_owned(),
        IpcValue::Object(_) => "[object Object]".to_owned(),
    }
}

/// `/^data:image\//i`
fn is_image_data_url(url: &str) -> bool {
    url.get(..11)
        .is_some_and(|head| head.eq_ignore_ascii_case("data:image/"))
}

pub(super) fn entries(services: &Services) -> Result<Vec<Entry>, RegisterError> {
    let engine = services.hosts.need::<HwpEngineHost>(Batch::D2)?;
    let mut entries = Vec::with_capacity(2);

    entries.push(kit::invoke_later("hwp:fetch-image", {
        let engine = Arc::clone(&engine);
        let services = services.clone();
        move |_cx, args, responder| {
            let Some(url) = args.str(0).filter(|url| !url.is_empty()) else {
                return responder.reply(Ok(IpcValue::Null));
            };
            let url = url.to_owned();
            let engine = Arc::clone(&engine);
            kit::on_worker(
                &services,
                move || engine.fetch_image_bytes(url),
                move |image| {
                    responder.reply(Ok(match image {
                        Some(FetchedImage { base64, mime }) => {
                            obj([("base64", base64.into_ipc()), ("mime", mime.into_ipc())])
                        }
                        None => IpcValue::Null,
                    }))
                },
            )
        }
    }));

    // Picture understanding: the panel takes a picture out of the document and
    // sends it as an image data URL. Only data URLs are taken (this editor has
    // no path to hand over), and the call ends with its tab or when the tab's
    // AI run is stopped.
    entries.push(kit::invoke_later("hwp:analyze-media", {
        let services = services.clone();
        move |cx, args, responder| {
            let op = args.get(0);
            let media_urls: Vec<String> = match kit::field(op, "mediaUrls") {
                IpcValue::Array(urls) => urls
                    .iter()
                    .map(js_string)
                    .filter(|url| is_image_data_url(url))
                    .collect(),
                _ => Vec::new(),
            };
            if media_urls.is_empty() {
                return responder.reply(Ok(obj([(
                    "error",
                    "no picture was given to look at".into_ipc(),
                )])));
            }
            let requirements = match kit::field(op, "requirements") {
                IpcValue::Null | IpcValue::Undefined => String::new(),
                other => js_string(other),
            };
            let settings_path = services
                .paths
                .path(PathName::UserData)
                .join("ai-settings.json");
            let (view, cancel) = (cx.sender.view, cx.cancel.clone());
            let engine = Arc::clone(&engine);
            kit::on_worker(
                &services,
                move || engine.analyze_media(view, settings_path, media_urls, requirements, cancel),
                move |result| {
                    responder.reply(match result {
                        Ok(value) => Ok(kit::from_json(&value)),
                        Err(message) => Err(kit::error(message)),
                    })
                },
            )
        }
    }));

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use serde_json::json;
    use shell_contract::{Provided, Surface};

    use super::*;
    use crate::testing::Rt;

    fn reg(services: &Services, _provided: &Rc<Provided>) -> Result<Vec<Entry>, RegisterError> {
        super::entries(services)
    }

    fn rt(case: serde_json::Value) -> Rt {
        let mut rt = Rt::new(|h| crate::hwp::fakes(h, &case));
        rt.register(reg).unwrap();
        rt
    }

    fn s(text: &str) -> IpcValue {
        IpcValue::String(text.to_owned())
    }

    fn op(members: Vec<(&str, IpcValue)>) -> IpcValue {
        IpcValue::Object(
            members
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
        )
    }

    #[test]
    fn fetch_image_answers_the_picture_or_null() {
        let mut rt = rt(json!({ "fetch_image_bytes": [
            { "base64": "QUJD", "mime": "image/png" },
            null,
        ]}));
        let from = rt.view(1, Surface::Hwp);
        // what is not a non-empty string never reaches the engine
        assert_eq!(
            rt.invoke_now("hwp:fetch-image", from, vec![IpcValue::Number(5.0)])
                .unwrap(),
            IpcValue::Null
        );
        assert_eq!(
            rt.invoke_now("hwp:fetch-image", from, vec![s("")]).unwrap(),
            IpcValue::Null
        );
        assert_eq!(
            rt.invoke_now("hwp:fetch-image", from, vec![]).unwrap(),
            IpcValue::Null
        );

        assert_eq!(
            rt.invoke_now(
                "hwp:fetch-image",
                from,
                vec![s("https://example.test/a.png")]
            )
            .unwrap(),
            obj([("base64", s("QUJD")), ("mime", s("image/png"))])
        );
        // the engine refused the second address
        assert_eq!(
            rt.invoke_now("hwp:fetch-image", from, vec![s("http://127.0.0.1/a.png")])
                .unwrap(),
            IpcValue::Null
        );
    }

    #[test]
    fn analyze_media_keeps_only_image_data_urls() {
        let mut rt = rt(json!({}));
        let from = rt.view(4, Surface::Hwp);
        let reply = rt
            .invoke_now(
                "hwp:analyze-media",
                from,
                vec![op(vec![
                    (
                        "mediaUrls",
                        IpcValue::Array(vec![
                            s("data:image/png;base64,AAAA"),
                            s("https://example.test/a.png"),
                            s("DATA:IMAGE/jpeg;base64,BBBB"),
                            s("data:text/plain,hi"),
                            IpcValue::Number(7.0),
                            // `String(["data:image/gif;base64,CC"])` is the string itself
                            IpcValue::Array(vec![s("data:image/gif;base64,CC")]),
                        ]),
                    ),
                    ("requirements", s("what is shown?")),
                ])],
            )
            .unwrap();
        assert_eq!(
            kit::to_json(&reply).unwrap(),
            json!({
                "view": 4,
                "settingsPath": rt.dir.join("userData").join("ai-settings.json").to_string_lossy(),
                "mediaUrls": [
                    "data:image/png;base64,AAAA",
                    "DATA:IMAGE/jpeg;base64,BBBB",
                    "data:image/gif;base64,CC",
                ],
                "requirements": "what is shown?",
                "cancelled": false,
            })
        );
    }

    #[test]
    fn analyze_media_without_a_picture_never_reaches_the_reader() {
        // the engine would answer something else, proving it was not asked
        let mut rt = rt(json!({ "analyze_media": { "text": "asked" } }));
        let from = rt.view(1, Surface::Hwp);
        let nothing = obj([("error", s("no picture was given to look at"))]);
        let mut call =
            |args: Vec<IpcValue>| rt.invoke_now("hwp:analyze-media", from, args).unwrap();
        assert_eq!(call(vec![]), nothing);
        assert_eq!(call(vec![IpcValue::Null]), nothing);
        assert_eq!(call(vec![s("data:image/png;base64,AA")]), nothing);
        assert_eq!(
            call(vec![op(vec![("mediaUrls", s("data:image/png;base64,AA"))])]),
            nothing
        );
        assert_eq!(
            call(vec![op(vec![(
                "mediaUrls",
                IpcValue::Array(vec![s("https://x.test/a.png"), s("file:///a.png")])
            )])]),
            nothing
        );
        // one image is enough to ask
        assert_eq!(
            call(vec![op(vec![(
                "mediaUrls",
                IpcValue::Array(vec![s("data:image/webp;base64,AA")])
            )])]),
            obj([("text", s("asked"))])
        );
    }

    #[test]
    fn analyze_media_requirements_read_as_a_string() {
        let mut rt = rt(json!({}));
        let from = rt.view(1, Surface::Hwp);
        let mut requirements = |value: Option<IpcValue>| {
            let mut members = vec![(
                "mediaUrls",
                IpcValue::Array(vec![s("data:image/png;base64,AA")]),
            )];
            members.extend(value.map(|v| ("requirements", v)));
            let reply = rt
                .invoke_now("hwp:analyze-media", from, vec![op(members)])
                .unwrap();
            kit::to_json(kit::field(&reply, "requirements")).unwrap()
        };
        assert_eq!(requirements(None), json!(""));
        assert_eq!(requirements(Some(IpcValue::Null)), json!(""));
        assert_eq!(requirements(Some(IpcValue::Number(12.0))), json!("12"));
        assert_eq!(requirements(Some(s("a"))), json!("a"));
    }

    #[test]
    fn analyze_media_passes_the_tool_result_or_its_rejection() {
        let mut rt = rt(json!({ "analyze_media": [
            { "error": "no reader configured" },
            { "throws": "reader failed" },
        ]}));
        let from = rt.view(1, Surface::Hwp);
        let args = || {
            vec![op(vec![(
                "mediaUrls",
                IpcValue::Array(vec![s("data:image/png;base64,AA")]),
            )])]
        };
        assert_eq!(
            rt.invoke_now("hwp:analyze-media", from, args()).unwrap(),
            obj([("error", s("no reader configured"))])
        );
        let err = rt
            .invoke_now("hwp:analyze-media", from, args())
            .unwrap_err();
        assert_eq!(err.message, "reader failed");
    }
}
