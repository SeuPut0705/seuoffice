//! The functions of group `b4-pdf` (tools/main-diff/groups/b4-pdf.ts).
//!
//! The PDF modules take what Node and Electron give the TypeScript as
//! parameters. This file builds, from the JSON of a case, the same fakes the
//! TypeScript side builds: a scripted PDFium (`fake.rs`), a scripted hb-subset
//! instance, a scripted disk watcher, note store and command runner. Every call
//! of a fake is one log line.
//!
//! A `null` argument is an argument left out where the TypeScript has a
//! default.

mod fake;

use super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::NodeError;
use crate::pdf::annot_delete::{AnnotDeleteInput, apply_annot_deletes, remove_matching_annots};
use crate::pdf::annot_flatten::flatten_annots_bytes;
use crate::pdf::atomic_write::write_pdf_atomically;
use crate::pdf::blank_pages::{
    MAX_THUMBS, PageThumb, RENDER_LONG_SIDE, THUMB_LONG_SIDE, find_blank_pages, is_nearly_white,
    shrink_bitmap,
};
use crate::pdf::disk_watch::{
    DISK_WATCH_MAX_WAITS, DISK_WATCH_MISSING_CONFIRMATIONS, DiskBaseline, DiskChangeKind,
    DiskWatch, DiskWatchDeps, FileStat, Pending, ends_like_whole_pdf, watch_disk_file,
};
use crate::pdf::export_images::{
    ExportError, build_export_image_paths, build_save_as_image_paths,
    has_valid_export_page_numbers, is_valid_export_page_number,
};
use crate::pdf::font_classes::FontScript;
use crate::pdf::font_cmap::font_covers_text;
use crate::pdf::font_locate::{FontEnv, FontLocator, Platform, is_truetype};
use crate::pdf::font_similar::{SourceFace, os2_traits, similar_font_for, source_traits};
use crate::pdf::font_subset::{Thrown as SubsetThrown, identity_cff_charset, subset_ttf};
use crate::pdf::generated_output::{exists_sync, unique_generated_pdf_path};
use crate::pdf::pdfium::PdfiumError;
use fake::{FakeHb, FakePdfium};
use jscompat::{JsRegex, JsonValue, js_regex, json_value_from_serde, sha1_hex};
use serde_json::{Map, Number, Value, json};
use std::sync::{Mutex, OnceLock};

mod rest;
use rest::rest;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "annot-delete.applyAnnotDeletes" => pdfium_call(args, cx, |m| {
            let bytes = str_arg(args, 1)?;
            let deletes = deletes_arg(args, 2)?;
            apply_annot_deletes(m, bytes.as_bytes(), &deletes)
                .map(|out| Some(Value::String(utf8(&out))))
                .map_err(pdfium_error)
        }),
        "annot-delete.removeMatchingAnnots" => pdfium_call(args, cx, |m| {
            let index = arg(args, 1).and_then(Value::as_f64).unwrap_or(0.0);
            let deletes = deletes_arg(args, 2)?;
            // the test opens the page itself, as the TypeScript test does
            use crate::pdf::pdfium::Pdfium;
            let page = m.fpdf_load_page(1, index as i32);
            remove_matching_annots(m, page, &deletes)
                .map(|()| None)
                .map_err(pdfium_error)
        }),
        "annot-flatten.flattenAnnotsBytes" => pdfium_call(args, cx, |m| {
            let bytes = str_arg(args, 1)?;
            flatten_annots_bytes(m, bytes.as_bytes())
                .map(|out| Some(Value::String(utf8(&out))))
                .map_err(pdfium_error)
        }),
        "pdf/atomic-write.writePdfAtomically" => str_arg(args, 0).and_then(|path| {
            let text = str_arg(args, 1)?;
            write_pdf_atomically(path, text.as_bytes())
                .map(|()| None)
                .map_err(masked)
        }),
        "blank-pages.RENDER_LONG_SIDE" => Ok(Some(num(RENDER_LONG_SIDE))),
        "blank-pages.THUMB_LONG_SIDE" => Ok(Some(num(THUMB_LONG_SIDE))),
        "blank-pages.MAX_THUMBS" => Ok(Some(num(MAX_THUMBS as f64))),
        "blank-pages.isNearlyWhite" => str_arg(args, 0).map(|hex| {
            let width = num_arg(args, 1);
            let height = num_arg(args, 2);
            let stride = arg(args, 3).and_then(Value::as_f64).unwrap_or(width * 4.0);
            Some(Value::Bool(is_nearly_white(&hex_decode(hex), width, height, stride)))
        }),
        "blank-pages.shrinkBitmap" => str_arg(args, 0).map(|hex| {
            let thumb = shrink_bitmap(
                &hex_decode(hex),
                num_arg(args, 1),
                num_arg(args, 2),
                num_arg(args, 3),
                num_arg(args, 4),
            );
            Some(json!({"width": num(thumb.width), "height": num(thumb.height), "bgra": hex_encode(&thumb.bgra)}))
        }),
        "blank-pages.findBlankPages" => pdfium_call(args, cx, |m| {
            let with_progress = arg(args, 1).and_then(Value::as_bool).unwrap_or(false);
            let mut progress: Vec<String> = Vec::new();
            let result = {
                let mut record = |done: i32, total: i32| progress.push(format!("progress({done},{total})"));
                if with_progress {
                    find_blank_pages(m, 1, Some(&mut record))
                } else {
                    find_blank_pages(m, 1, None)
                }
            };
            m.log.extend(progress);
            let candidates: Vec<Value> = result
                .candidates
                .iter()
                .map(|c| {
                    json!({
                        "page": c.page,
                        "reason": c.reason.as_str(),
                        "thumb": c.thumb.as_ref().map_or(Value::Null, thumb_json),
                    })
                })
                .collect();
            Ok(Some(json!({"pageCount": result.page_count, "candidates": candidates})))
        }),
        "disk-watch.DISK_WATCH_MAX_WAITS" => Ok(Some(num(f64::from(DISK_WATCH_MAX_WAITS)))),
        "disk-watch.DISK_WATCH_MISSING_CONFIRMATIONS" => {
            Ok(Some(num(f64::from(DISK_WATCH_MISSING_CONFIRMATIONS))))
        }
        "disk-watch.endsLikeWholePdf" => {
            str_arg(args, 0).map(|hex| Some(Value::Bool(ends_like_whole_pdf(&hex_decode(hex)))))
        }
        "disk-watch.watchDiskFile" => watch_call(args, cx),
        "pdf/export-images.isValidExportPageNumber" => Ok(Some(Value::Bool(
            is_valid_export_page_number(&json_arg(args, 0)),
        ))),
        "pdf/export-images.hasValidExportPageNumbers" => Ok(Some(Value::Bool(
            has_valid_export_page_numbers(&json_arg(args, 0), arg(args, 1).and_then(Value::as_f64).unwrap_or(f64::NAN)),
        ))),
        "pdf/export-images.buildExportImagePaths" => export_paths(args),
        "pdf/export-images.buildSaveAsImagePaths" => str_arg(args, 0).and_then(|target| {
            let count = arg(args, 1).and_then(Value::as_f64).unwrap_or(f64::NAN);
            build_save_as_image_paths(target, count)
                .map(|paths| {
                    Some(match paths {
                        Some(paths) => Value::Array(paths.into_iter().map(Value::String).collect()),
                        None => Value::Null,
                    })
                })
                .map_err(|e| CallError::plain(e.0))
        }),
        "font-cmap.fontCoversText" => str_arg(args, 0).and_then(|hex| {
            let text = str_arg(args, 1)?;
            Ok(Some(Value::Bool(font_covers_text(&hex_decode(hex), text))))
        }),
        "font-locate.isTruetype" => {
            str_arg(args, 0).map(|hex| Some(Value::Bool(is_truetype(&hex_decode(hex)))))
        }
        "font-locate.findSystemFont" => str_arg(args, 0).and_then(|ps| {
            let family = str_arg(args, 1)?;
            Ok(Some(face_bytes_json(
                locator().lock().expect("the font lock").find_system_font(ps, family),
            )))
        }),
        "font-locate.findFontCovering" => str_arg(args, 0).map(|text| {
            Some(face_bytes_json(
                locator().lock().expect("the font lock").find_font_covering(text),
            ))
        }),
        "font-similar.os2Traits" => {
            let font = arg(args, 0).and_then(Value::as_str).map(hex_decode);
            let traits = os2_traits(font.as_deref());
            let mut out = Map::new();
            if let Some(weight) = traits.weight {
                out.insert("weight".into(), num(weight));
            }
            if let Some(style) = traits.style {
                out.insert("style".into(), Value::from(style.as_str()));
            }
            Ok(Some(Value::Object(out)))
        }
        "font-similar.sourceTraits" => {
            let face = source_face(arg(args, 0));
            let script = arg(args, 1).and_then(Value::as_str).and_then(script_of);
            let t = source_traits(&face, script);
            let mut out = Map::new();
            if let Some(script) = t.script {
                out.insert("script".into(), Value::from(script.as_str()));
            }
            out.insert("style".into(), Value::from(t.style.as_str()));
            out.insert("bold".into(), Value::Bool(t.bold));
            out.insert("italic".into(), Value::Bool(t.italic));
            Ok(Some(Value::Object(out)))
        }
        "font-similar.similarFontFor" => str_arg(args, 1).map(|drawn| {
            let face = source_face(arg(args, 0));
            let italic = arg(args, 2).and_then(Value::as_bool).unwrap_or(false);
            let found = similar_font_for(&mut locator().lock().expect("the font lock"), &face, drawn, italic);
            Some(match found {
                Some(f) => json!({
                    "len": f.bytes.len(),
                    "sha1": sha1_hex(&f.bytes),
                    "bold": f.bold,
                    "sourceBold": f.source_bold,
                }),
                None => Value::Null,
            })
        }),
        "font-subset.identityCffCharset" => str_arg(args, 0).and_then(|hex| {
            identity_cff_charset(&hex_decode(hex))
                .map(|out| Some(Value::String(hex_encode(&out))))
                .map_err(subset_error)
        }),
        "font-subset.subsetTtf" => {
            let world = arg(args, 0).cloned().unwrap_or(Value::Null);
            let mut hb = FakeHb::new(&world);
            let hex = str_arg(args, 1);
            let text = str_arg(args, 2);
            let answer = match (hex, text) {
                (Ok(hex), Ok(text)) => subset_ttf(&mut hb, &hex_decode(hex), text)
                    .map(|out| Some(Value::String(hex_encode(&out))))
                    .map_err(subset_error),
                (Err(e), _) | (_, Err(e)) => Err(e),
            };
            for line in hb.log {
                cx.logs.push(vec![Value::String(line)]);
            }
            answer
        }
        "generated-output.uniqueGeneratedPdfPath" => str_arg(args, 0).and_then(|dir| {
            let name = arg(args, 1).map(json_value_from_serde);
            let existing: Option<Vec<String>> = arg(args, 2).and_then(Value::as_array).map(|a| {
                a.iter().filter_map(Value::as_str).map(str::to_owned).collect()
            });
            let answer = match &existing {
                Some(list) => unique_generated_pdf_path(dir, name.as_ref(), &|p| list.iter().any(|e| e == p)),
                None => unique_generated_pdf_path(dir, name.as_ref(), &exists_sync),
            };
            answer
                .map(|path| Some(Value::String(path)))
                .map_err(|e| CallError::plain(e.0))
        }),
        _ => return rest(name, args, cx),
    })
}

// ---- shared helpers (also used by rest.rs) ---------------------------------

pub(super) fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

pub(super) fn num_arg(args: &[Value], i: usize) -> f64 {
    arg(args, i).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

pub(super) fn json_arg(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

pub(super) fn utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

pub(super) fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok())
        .collect()
}

pub(super) fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn pdfium_error(e: PdfiumError) -> CallError {
    CallError::plain(e.0)
}

fn subset_error(e: SubsetThrown) -> CallError {
    CallError {
        code: e.code.map(str::to_owned),
        message: e.message,
    }
}

/// A temp file's random name in a thrown message is written `<hex>` on both sides.
fn masked(e: NodeError) -> CallError {
    let re: &JsRegex = js_regex!(r"\.[0-9a-f]{12}\.tmp", "g");
    CallError {
        code: e.code.map(str::to_owned),
        message: re.replace_all(&e.message, |_| ".<hex>.tmp".to_owned()),
    }
}

/// Runs `f` on a fake PDFium built from the world in argument 0; the calls it
/// made are the log lines of the case, also when `f` fails.
fn pdfium_call(
    args: &[Value],
    cx: &mut Context,
    f: impl FnOnce(&mut FakePdfium) -> Answer,
) -> Answer {
    let world = arg(args, 0).cloned().unwrap_or(Value::Null);
    let mut m = FakePdfium::new(&world);
    let answer = f(&mut m);
    for line in m.log {
        cx.logs.push(vec![Value::String(line)]);
    }
    answer
}

fn deletes_arg(args: &[Value], i: usize) -> Result<Vec<AnnotDeleteInput>, CallError> {
    let list = arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| CallError::plain(format!("argument {i} is not a list")))?;
    Ok(list
        .iter()
        .map(|d| {
            let rect: Vec<f64> = d
                .get("rect")
                .and_then(Value::as_array)
                .map(|r| r.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
                .unwrap_or_default();
            AnnotDeleteInput {
                page_index: d
                    .get("pageIndex")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NAN),
                obj_num: d.get("objNum").and_then(Value::as_f64).unwrap_or(f64::NAN),
                subtype: d
                    .get("subtype")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                rect: [
                    rect.first().copied().unwrap_or(f64::NAN),
                    rect.get(1).copied().unwrap_or(f64::NAN),
                    rect.get(2).copied().unwrap_or(f64::NAN),
                    rect.get(3).copied().unwrap_or(f64::NAN),
                ],
                contents: d.get("contents").and_then(Value::as_str).map(str::to_owned),
            }
        })
        .collect())
}

fn thumb_json(t: &PageThumb) -> Value {
    json!({
        "width": num(t.width),
        "height": num(t.height),
        "len": t.bgra.len(),
        "sha1": sha1_hex(&t.bgra),
    })
}

// ---- disk-watch ------------------------------------------------------------

struct WatchDeps<'a> {
    cx: &'a mut Context,
    own: Vec<bool>,
    own_at: usize,
    watch_null: bool,
    settle_ms: f64,
    case_insensitive: bool,
    next_timer: u64,
    live_timers: Vec<u64>,
}

impl WatchDeps<'_> {
    fn log(&mut self, line: String) {
        self.cx.logs.push(vec![Value::String(line)]);
    }
}

impl DiskWatchDeps for WatchDeps<'_> {
    fn watch_dir(&mut self, dir: &str) -> bool {
        self.log(format!(
            "watchDir({})",
            serde_json::to_string(dir).expect("a string prints")
        ));
        !self.watch_null
    }

    fn close_watch(&mut self) {
        self.log("handle.close()".to_owned());
    }

    fn hash(&mut self, bytes: &[u8]) -> String {
        let sum: u32 = bytes.iter().map(|&b| u32::from(b)).sum();
        let h = format!("{}:{}", bytes.len(), sum % 251);
        self.log(format!("hash={h}"));
        h
    }

    fn set_timer(&mut self, ms: f64) -> u64 {
        self.next_timer += 1;
        let handle = self.next_timer;
        self.live_timers.push(handle);
        self.log(format!(
            "setTimer({})={handle}",
            jscompat::number_to_string(ms)
        ));
        handle
    }

    fn clear_timer(&mut self, handle: u64) {
        self.live_timers.retain(|&h| h != handle);
        self.log(format!("clearTimer({handle})"));
    }

    fn own_write_in_flight(&mut self, path: &str) -> bool {
        let answer = self.own.get(self.own_at).copied().unwrap_or(false);
        self.own_at += 1;
        let _ = path;
        self.log(format!("ownWriteInFlight={answer}"));
        answer
    }

    fn on_change(&mut self, kind: DiskChangeKind) {
        self.log(format!("onChange({})", kind.as_str()));
    }

    fn settle_ms(&self) -> f64 {
        self.settle_ms
    }

    fn case_insensitive(&self) -> bool {
        self.case_insensitive
    }
}

fn baseline_of(v: Option<&Value>) -> Option<DiskBaseline> {
    let v = v?;
    if v.is_null() {
        return None;
    }
    Some(DiskBaseline {
        mtime_ms: v.get("mtimeMs").and_then(Value::as_f64).unwrap_or(f64::NAN),
        size: v.get("size").and_then(Value::as_f64).unwrap_or(f64::NAN),
        hash: v
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}

fn watch_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let path = spec
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut deps = WatchDeps {
        cx,
        own: spec
            .get("own")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|v| v.as_bool().unwrap_or(false)).collect())
            .unwrap_or_default(),
        own_at: 0,
        watch_null: spec
            .get("watchNull")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        settle_ms: spec
            .get("settleMs")
            .and_then(Value::as_f64)
            .unwrap_or(250.0),
        case_insensitive: spec
            .get("caseInsensitive")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        next_timer: 0,
        live_timers: Vec::new(),
    };
    let mut watch: DiskWatch = watch_disk_file(&path, baseline_of(spec.get("baseline")), &mut deps);
    let mut pending: Vec<Pending> = Vec::new();
    let steps = spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for step in &steps {
        let mut asked: Option<Pending> = None;
        if let Some(event) = step.get("event") {
            watch.on_event(&mut deps, event.as_str());
        } else if step.get("timer").is_some() {
            if deps.live_timers.is_empty() {
                deps.log("no timer".to_owned());
            } else {
                deps.live_timers.clear();
                asked = watch.fire_timer(&mut deps);
            }
        } else if let Some(stat) = step.get("stat") {
            if let Some(at) = pending.iter().position(|p| *p == Pending::Stat) {
                pending.remove(at);
                let answer = if stat.is_null() {
                    None
                } else {
                    Some(FileStat {
                        mtime_ms: stat
                            .get("mtimeMs")
                            .and_then(Value::as_f64)
                            .unwrap_or(f64::NAN),
                        size: stat.get("size").and_then(Value::as_f64).unwrap_or(f64::NAN),
                    })
                };
                asked = watch.answer_stat(&mut deps, answer);
            } else {
                deps.log("no stat pending".to_owned());
            }
        } else if let Some(read) = step.get("read") {
            if let Some(at) = pending.iter().position(|p| *p == Pending::Read) {
                pending.remove(at);
                let bytes = read.as_str().map(hex_decode);
                asked = watch.answer_read(&mut deps, bytes.as_deref());
            } else {
                deps.log("no read pending".to_owned());
            }
        } else if let Some(next) = step.get("rebase") {
            watch.rebase(baseline_of(Some(next)));
        } else if step.get("close").is_some() {
            watch.close(&mut deps);
        }
        match asked {
            Some(Pending::Stat) => {
                deps.log(format!(
                    "stat({})",
                    serde_json::to_string(&path).expect("a string prints")
                ));
                pending.push(Pending::Stat);
            }
            Some(Pending::Read) => {
                deps.log(format!(
                    "read({})",
                    serde_json::to_string(&path).expect("a string prints")
                ));
                pending.push(Pending::Read);
            }
            None => {}
        }
    }
    Ok(None)
}

// ---- export-images -----------------------------------------------------------

fn export_paths(args: &[Value]) -> Answer {
    let dir = str_arg(args, 0)?;
    let base = arg(args, 1).map(json_value_from_serde);
    let numbers: Vec<JsonValue> = arg(args, 2)
        .and_then(Value::as_array)
        .map(|a| a.iter().map(json_value_from_serde).collect())
        .unwrap_or_default();
    let ext = str_arg(args, 3)?;
    build_export_image_paths(dir, base.as_ref(), &numbers, ext)
        .map(|paths| Some(Value::Array(paths.into_iter().map(Value::String).collect())))
        .map_err(|ExportError(message)| CallError::plain(message))
}

// ---- fonts ---------------------------------------------------------------------

fn locator() -> &'static Mutex<FontLocator> {
    static LOCATOR: OnceLock<Mutex<FontLocator>> = OnceLock::new();
    LOCATOR.get_or_init(|| {
        let platform = if cfg!(target_os = "macos") {
            Platform::Darwin
        } else if cfg!(windows) {
            Platform::Win32
        } else {
            Platform::Other
        };
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        Mutex::new(FontLocator::new(FontEnv { platform, home }))
    })
}

fn face_bytes_json(bytes: Option<Vec<u8>>) -> Value {
    match bytes {
        Some(b) => json!({"len": b.len(), "sha1": sha1_hex(&b)}),
        None => Value::Null,
    }
}

fn script_of(name: &str) -> Option<FontScript> {
    match name {
        "ko" => Some(FontScript::Ko),
        "ja" => Some(FontScript::Ja),
        "zh" => Some(FontScript::Zh),
        "latin" => Some(FontScript::Latin),
        _ => None,
    }
}

fn source_face(v: Option<&Value>) -> SourceFace {
    let v = v.cloned().unwrap_or(Value::Null);
    SourceFace {
        ps_name: v
            .get("psName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        flags: v.get("flags").and_then(Value::as_f64).unwrap_or(0.0),
        embedded: v.get("embedded").and_then(Value::as_str).map(hex_decode),
    }
}
