//! The probe fakes of the `slides_ai` ports: the AI libraries behind
//! [`SlidesAiHost`] and the slides sessions D1 provides, scripted by the case's
//! `hosts.a.slidesAi` (the TypeScript half is tools/ipc-diff/groups/a/
//! slides-ai.ts, which reads the same value and logs the same lines).
//!
//! `hosts.a.lang` is the UI language (`ko` by default) and `hosts.a.dir` the
//! case's folder; `hosts.a.slidesAi`:
//!
//! - `sessions`: `{"<view>": {path, pages: [text], masterEdit}}`, the decks the
//!   views have open before the first call (a deck of pages named by their
//!   text, in master view when `masterEdit`; the in-memory [`World`] stands for
//!   D1's session state)
//! - `now`: `Date.now()` of the failure log (`1700000000000`)
//! - `statuses`: what `sharedSubscriptionStatuses()` answers (`{}`)
//! - `capabilities`: what `aiToolCapabilities` answers
//! - `generateImage`, `analyzeMedia`: one answer per call of the tool, in
//!   order: `{ok: value}` or `{throw: message}`; `{ok: {done: true}}` when the
//!   list runs out
//! - `images`: `{<url>: hex | null}`, what `fetchRemoteImage` downloads; a url
//!   the case does not name fails
//!
//! The host log gets one line per call named after the TypeScript call it
//! stands for: `["generateImageTool", settingsPath, request, {mediaRoots,
//! context}]`, `["analyzeMediaTool", ...]`, `["aiToolCapabilities", settings,
//! context]`, `["fetchRemoteImage", url]`.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use main_core::packages::ai_provider::jsval::{object, text};
use main_core::packages::ai_provider::settings_secrets::AiSecretCodec;
use main_core::packages::i18n::{Lang, normalize_lang};
use main_core::slides::ai_ipc::{ImageDecoder, MediaToolOptions, NativeImage};
use serde_json::{Value, json};
use shell_contract::ViewId;
use shell_contract::runtime::CancelToken;

use super::{Log, push};
use crate::slides_ai::host::{SlidesAiHost, SlidesAiHostHandle};
use crate::slides_ai::sessions::{Overrides, SessionsBuilder, SlidesAiSessions};
use crate::slides_ai::world::World;

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok())
        .collect()
}

/// `nativeImage`: the bytes are the PNG, the size is the first two bytes
struct Decoder;
struct Image(Vec<u8>);

impl NativeImage for Image {
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    fn to_png(&self) -> Vec<u8> {
        self.0.clone()
    }
    fn size(&self) -> (f64, f64) {
        (
            f64::from(self.0.first().copied().unwrap_or(0)),
            f64::from(self.0.get(1).copied().unwrap_or(0)),
        )
    }
}

impl ImageDecoder for Decoder {
    fn create_from_buffer(&self, bytes: &[u8]) -> Box<dyn NativeImage> {
        Box::new(Image(bytes.to_vec()))
    }
}

struct FakeHost {
    lang: Lang,
    case: Value,
    log: Option<Log>,
    generated: AtomicUsize,
    analyzed: AtomicUsize,
    decoder: Decoder,
}

impl FakeHost {
    /// The next scripted answer of `key`'s list
    fn next(&self, key: &str, counter: &AtomicUsize) -> Result<JsonValue, JsonValue> {
        let at = counter.fetch_add(1, Ordering::SeqCst);
        let answer = self.case[key]
            .get(at)
            .cloned()
            .unwrap_or(json!({"ok": {"done": true}}));
        match answer.get("throw").and_then(Value::as_str) {
            Some(message) => Err(object(vec![
                ("$class", text("Error")),
                ("message", text(message)),
            ])),
            None => Ok(json_value_from_serde(&answer["ok"])),
        }
    }

    fn tool(
        &self,
        name: &str,
        settings_path: &str,
        request: &JsonValue,
        options: &MediaToolOptions,
    ) {
        push(
            &self.log,
            json!([
                name,
                settings_path,
                json_value_to_serde(request),
                {
                    "mediaRoots": options.media_roots,
                    "context": json_value_to_serde(&options.context),
                },
            ]),
        );
    }
}

impl SlidesAiHost for FakeHost {
    fn ui_lang(&self) -> Lang {
        self.lang
    }

    fn secret_codec(&self) -> Option<&dyn AiSecretCodec> {
        None
    }

    fn shared_subscription_statuses(&self) -> JsonValue {
        match &self.case["statuses"] {
            Value::Null => JsonValue::Object(Default::default()),
            statuses => json_value_from_serde(statuses),
        }
    }

    fn ai_tool_capabilities(&self, settings: &JsonValue, context: &JsonValue) -> JsonValue {
        push(
            &self.log,
            json!([
                "aiToolCapabilities",
                json_value_to_serde(settings),
                json_value_to_serde(context)
            ]),
        );
        match &self.case["capabilities"] {
            Value::Null => json_value_from_serde(&json!({"webSearch": {"available": true}})),
            capabilities => json_value_from_serde(capabilities),
        }
    }

    fn generate_image(
        &self,
        settings_path: &str,
        request: &JsonValue,
        options: &MediaToolOptions,
        _signal: &CancelToken,
    ) -> Result<JsonValue, JsonValue> {
        self.tool("generateImageTool", settings_path, request, options);
        self.next("generateImage", &self.generated)
    }

    fn analyze_media(
        &self,
        settings_path: &str,
        request: &JsonValue,
        options: &MediaToolOptions,
        _signal: &CancelToken,
    ) -> Result<JsonValue, JsonValue> {
        self.tool("analyzeMediaTool", settings_path, request, options);
        self.next("analyzeMedia", &self.analyzed)
    }

    fn fetch_remote_image(&self, url: &str) -> Option<Vec<u8>> {
        push(&self.log, json!(["fetchRemoteImage", url]));
        self.case["images"][url].as_str().map(unhex)
    }

    fn image_decoder(&self) -> &dyn ImageDecoder {
        &self.decoder
    }
}

thread_local! {
    /// The world of the case being run on this thread, by the number the
    /// case's `insert` was given: both ports share it
    static WORLD: RefCell<Option<(usize, Rc<World>)>> = const { RefCell::new(None) };
}

static CASES: AtomicUsize = AtomicUsize::new(0);

fn world_of(case_number: usize, sessions: &Value) -> Rc<World> {
    WORLD.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some((number, world)) = slot.as_ref()
            && *number == case_number
        {
            return world.clone();
        }
        let world = World::new();
        if let Some(views) = sessions.as_object() {
            for (view, session) in views {
                let pages: Vec<&str> = session["pages"]
                    .as_array()
                    .map(|pages| pages.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let view = ViewId(view.parse().expect("a view number"));
                world.open(view, session["path"].as_str().unwrap_or(""), &pages);
                if session["masterEdit"].as_bool().unwrap_or(false) {
                    world.set_master_edit(view, true);
                }
            }
        }
        *slot = Some((case_number, world.clone()));
        world
    })
}

pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value, log: Option<Log>) {
    let scripted = case["slidesAi"].clone();
    let host: SlidesAiHostHandle = Arc::new(FakeHost {
        lang: normalize_lang(Some(case["lang"].as_str().unwrap_or("ko"))),
        case: scripted.clone(),
        log,
        generated: AtomicUsize::new(0),
        analyzed: AtomicUsize::new(0),
        decoder: Decoder,
    });
    hosts.insert(host);
    let number = CASES.fetch_add(1, Ordering::SeqCst);
    let sessions = scripted["sessions"].clone();
    let build: SessionsBuilder =
        Arc::new(move || -> Rc<dyn SlidesAiSessions> { world_of(number, &sessions) });
    let now = scripted["now"].as_f64().unwrap_or(1_700_000_000_000.0);
    let overrides = Overrides {
        sessions: Some(build),
        now_ms: Some(Arc::new(move || now)),
    };
    hosts.insert(crate::slides_ai::factory_with(overrides.clone()));
    hosts.insert(crate::slides_ai::proposal_factory_with(overrides));
}
