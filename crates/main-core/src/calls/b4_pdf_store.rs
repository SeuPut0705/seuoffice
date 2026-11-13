//! The functions of group `b4-pdf-store` (tools/main-diff/groups/b4-pdf-store.ts):
//! the result store of `packages/pdf-structure/src/store/` and the small
//! pieces it imports (`tree/hash`, `tree/inline` `runsText`,
//! `highlight/run-id`).
//!
//! `pdf-structure/store.<method>` runs one method of a `ResultStore` over the
//! case's real folder. Its first argument is `{ dir, runningWindowMs? }`
//! (the user-data folder and the store's options); the store's clock reads
//! the call's `now`. The rest are the method's arguments, with `null` for an
//! argument left out. A `Map` answer is an array of `[key, value]` pairs.
//!
//! The enumerations the TypeScript checks at run time (job kind, translation
//! mode, block status, job state, highlight status and state, passage kind)
//! are typed here, so a case never passes an invalid one.

use jscompat::{JsMap, JsObject, JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::Value;

use super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::pdf_structure::files::{
    EntryKind, StoreEnv, SystemEnv, file_exists, folder_size, is_temp_name, list_names,
    lock_path_of, read_json, remove_entry, remove_folder, write_json_atomic,
};
use crate::packages::pdf_structure::highlight_run_id::{highlight_run_id, normalize_label_name};
use crate::packages::pdf_structure::keys::{
    KeyUnit, TranslationBlockKey, block_key_string, normalize_source_text, translation_block_keys,
};
use crate::packages::pdf_structure::note_links::as_note_links;
use crate::packages::pdf_structure::reading::{
    HighlightBlockInput, HighlightBlockStatus, HighlightLabel, HighlightRun, HighlightSuggestion,
    HighlightSuggestionState, InsightsEntry, InsightsTerm, PassageCardInput, PassageKind,
    as_highlight_block, as_highlight_run, as_insights, as_passage_card, is_segment,
};
use crate::packages::pdf_structure::sentence_ends::{sentence_ends_pair, valid_sentence_ends};
use crate::packages::pdf_structure::store::{
    AiReadMeta, JobProgress, JobRecordInput, JobState, MigrateInput, ResultStore,
    ResultStoreOptions, StoreError, TranslationBlockInput, TranslationBlockStatus,
    TranslationMetaInput,
};
use crate::packages::pdf_structure::tree_hash::sha256_hex;
use crate::packages::pdf_structure::tree_inline::{InlineRun, runs_text};
use crate::packages::pdf_structure::{JobKind, StoreWriteError, TranslationMode};

type R<T> = Result<T, CallError>;

const STORE: &str = "pdf-structure/store.";

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    if let Some(method) = name.strip_prefix(STORE) {
        return store_call(method, args, cx.now_ms);
    }
    Some(match name {
        "pdf-structure/files.isTempName" => {
            (|| Ok(Some(Value::Bool(is_temp_name(str_arg(args, 0)?)))))()
        }
        "pdf-structure/files.lockPathOf" => {
            (|| Ok(Some(Value::from(lock_path_of(str_arg(args, 0)?)))))()
        }
        "pdf-structure/files.writeJsonAtomic" => (|| {
            let value = json_value_from_serde(arg(args, 1).unwrap_or(&Value::Null));
            write_json_atomic(&mut SystemEnv, str_arg(args, 0)?, &value).map_err(write_failed)?;
            Ok(None)
        })(),
        "pdf-structure/files.readJson" => (|| {
            let found = read_json(&mut SystemEnv, str_arg(args, 0)?);
            Ok(found.map(|v| json_value_to_serde(&v)))
        })(),
        "pdf-structure/files.listNames" => (|| {
            let kind = match str_arg(args, 1)? {
                "file" => EntryKind::File,
                "dir" => EntryKind::Dir,
                other => return Err(CallError::plain(format!("no such kind: {other}"))),
            };
            Ok(Some(strings(&list_names(str_arg(args, 0)?, kind))))
        })(),
        "pdf-structure/files.folderSize" => {
            (|| Ok(Some(Value::from(folder_size(str_arg(args, 0)?)))))()
        }
        "pdf-structure/files.fileExists" => {
            (|| Ok(Some(Value::Bool(file_exists(str_arg(args, 0)?)))))()
        }
        "pdf-structure/files.removeEntry" => (|| {
            remove_entry(&mut SystemEnv, str_arg(args, 0)?).map_err(write_failed)?;
            Ok(None)
        })(),
        "pdf-structure/files.removeFolder" => (|| {
            remove_folder(&mut SystemEnv, str_arg(args, 0)?).map_err(write_failed)?;
            Ok(None)
        })(),
        "pdf-structure/keys.normalizeSourceText" => (|| {
            let runs = runs_of(arg(args, 0))?;
            Ok(Some(Value::from(normalize_source_text(&runs))))
        })(),
        "pdf-structure/keys.translationBlockKeys" => (|| {
            let units = arg(args, 0)
                .and_then(Value::as_array)
                .ok_or_else(|| CallError::plain("argument 0 is not an array"))?;
            let mut parsed = Vec::new();
            for unit in units {
                parsed.push((
                    runs_of(unit.get("runs"))?,
                    unit.get("pageFingerprint")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                ));
            }
            let units: Vec<KeyUnit<'_>> = parsed
                .iter()
                .map(|(runs, page_fingerprint)| KeyUnit {
                    runs,
                    page_fingerprint,
                })
                .collect();
            Ok(Some(Value::Array(
                translation_block_keys(&units)
                    .iter()
                    .map(|key| json_value_to_serde(&key_json(key)))
                    .collect(),
            )))
        })(),
        "pdf-structure/keys.blockKeyString" => {
            (|| Ok(Some(Value::from(block_key_string(&key_of(arg(args, 0))?)))))()
        }
        "pdf-structure/sentence-ends.validSentenceEnds" => {
            let ends = arg(args, 0).map(json_value_from_serde);
            let length = present(args, 1).and_then(Value::as_f64);
            Ok(Some(Value::Bool(
                valid_sentence_ends(ends.as_ref(), length).is_some(),
            )))
        }
        "pdf-structure/sentence-ends.sentenceEndsPair" => (|| {
            let source = arg(args, 0).map(json_value_from_serde);
            let ends = arg(args, 1).map(json_value_from_serde);
            let length = number_of(arg(args, 2))?;
            Ok(Some(
                sentence_ends_pair(source.as_ref(), ends.as_ref(), length).map_or(
                    Value::Null,
                    |pair| {
                        let numbers = |items: &[f64]| {
                            JsonValue::Array(items.iter().map(|x| JsonValue::Number(*x)).collect())
                        };
                        json_value_to_serde(&JsonValue::Object(
                            [
                                (
                                    "sourceSentenceEnds".to_owned(),
                                    numbers(&pair.source_sentence_ends),
                                ),
                                ("sentenceEnds".to_owned(), numbers(&pair.sentence_ends)),
                            ]
                            .into_iter()
                            .collect(),
                        ))
                    },
                ),
            ))
        })(),
        "pdf-structure/reading.isSegment" => {
            let value = arg(args, 0).map(json_value_from_serde);
            Ok(Some(Value::Bool(is_segment(value.as_ref()))))
        }
        "pdf-structure/reading.asPassageCard" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            Ok(Some(
                as_passage_card(raw.as_ref())
                    .map_or(Value::Null, |card| json_value_to_serde(&card.to_value())),
            ))
        }
        "pdf-structure/reading.asHighlightRun" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            Ok(Some(
                as_highlight_run(raw.as_ref())
                    .map_or(Value::Null, |run| json_value_to_serde(&run.to_value())),
            ))
        }
        "pdf-structure/reading.asHighlightBlock" => (|| {
            let raw = arg(args, 0).map(json_value_from_serde);
            let key = key_of(arg(args, 1))?;
            Ok(Some(
                as_highlight_block(raw.as_ref(), &key)
                    .map_or(Value::Null, |entry| json_value_to_serde(&entry.to_value())),
            ))
        })(),
        "pdf-structure/reading.asInsights" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            Ok(Some(
                as_insights(raw.as_ref())
                    .map_or(Value::Null, |entry| json_value_to_serde(&entry.to_value())),
            ))
        }
        "pdf-structure/note-links.asNoteLinks" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            Ok(Some(json_value_to_serde(
                &as_note_links(raw.as_ref()).to_value(),
            )))
        }
        "tree/hash.sha256Hex" => (|| Ok(Some(Value::from(sha256_hex(str_arg(args, 0)?)))))(),
        "tree/inline.runsText" => (|| Ok(Some(Value::from(runs_text(&runs_of(arg(args, 0))?)))))(),
        "highlight/run-id.normalizeLabelName" => {
            (|| Ok(Some(Value::from(normalize_label_name(str_arg(args, 0)?)))))()
        }
        "highlight/run-id.highlightRunId" => (|| {
            let names = strings_of(arg(args, 1))?;
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            Ok(Some(Value::from(highlight_run_id(
                str_arg(args, 0)?,
                &names,
            ))))
        })(),
        _ => return None,
    })
}

// ---- reading the arguments ----

fn write_failed(error: StoreWriteError) -> CallError {
    fail(StoreError::Write(error))
}

/// what a store call throws, as the comparison sees it
fn fail(error: StoreError) -> CallError {
    match error {
        StoreError::Type(message) => CallError::plain(message),
        StoreError::Write(error) => CallError {
            code: Some(StoreWriteError::CODE.to_owned()),
            message: error.message,
        },
    }
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("argument is not {what}"))
}

/// the argument at `i`, `None` where it is left out or `null`
fn present(args: &[Value], i: usize) -> Option<&Value> {
    arg(args, i).filter(|v| !v.is_null())
}

fn text_of(v: Option<&Value>) -> R<&str> {
    v.and_then(Value::as_str).ok_or_else(|| bad("a string"))
}

fn opt_text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_owned)
}

fn number_of(v: Option<&Value>) -> R<f64> {
    v.and_then(Value::as_f64).ok_or_else(|| bad("a number"))
}

fn strings_of(v: Option<&Value>) -> R<Vec<String>> {
    v.and_then(Value::as_array)
        .ok_or_else(|| bad("an array"))?
        .iter()
        .map(|item| text_of(Some(item)).map(str::to_owned))
        .collect()
}

fn numbers_of(v: Option<&Value>) -> R<Vec<f64>> {
    v.and_then(Value::as_array)
        .ok_or_else(|| bad("an array"))?
        .iter()
        .map(|item| number_of(Some(item)))
        .collect()
}

fn strings(items: &[String]) -> Value {
    Value::Array(items.iter().map(|s| Value::from(s.as_str())).collect())
}

fn mode_of(args: &[Value], i: usize) -> R<TranslationMode> {
    match present(args, i) {
        None => Ok(TranslationMode::Translate),
        Some(v) => TranslationMode::parse(text_of(Some(v))?).ok_or_else(|| bad("a mode")),
    }
}

fn kind_of(v: Option<&Value>) -> R<JobKind> {
    JobKind::parse(text_of(v)?).ok_or_else(|| bad("a job kind"))
}

fn key_of(v: Option<&Value>) -> R<TranslationBlockKey> {
    let v = v.ok_or_else(|| bad("a block key"))?;
    Ok(TranslationBlockKey {
        page_fingerprint: text_of(v.get("pageFingerprint"))?.to_owned(),
        text_hash: text_of(v.get("textHash"))?.to_owned(),
        occurrence: number_of(v.get("occurrence"))?,
    })
}

fn key_json(key: &TranslationBlockKey) -> JsonValue {
    JsonValue::Object(
        [
            (
                "pageFingerprint".to_owned(),
                JsonValue::String(key.page_fingerprint.clone()),
            ),
            (
                "textHash".to_owned(),
                JsonValue::String(key.text_hash.clone()),
            ),
            ("occurrence".to_owned(), JsonValue::Number(key.occurrence)),
        ]
        .into_iter()
        .collect(),
    )
}

fn runs_of(v: Option<&Value>) -> R<Vec<InlineRun>> {
    let items = v.and_then(Value::as_array).ok_or_else(|| bad("runs"))?;
    items
        .iter()
        .map(|run| {
            Ok(match text_of(run.get("kind"))? {
                "text" => InlineRun::Text {
                    text: text_of(run.get("text"))?.to_owned(),
                },
                "math" => InlineRun::Math {
                    latex: text_of(run.get("latex"))?.to_owned(),
                },
                "lineBreak" => InlineRun::LineBreak,
                _ => InlineRun::FootnoteRef,
            })
        })
        .collect()
}

fn block_input(v: &Value) -> R<TranslationBlockInput> {
    let status = match text_of(v.get("status"))? {
        "translated" => TranslationBlockStatus::Translated,
        "failed" => TranslationBlockStatus::Failed,
        _ => return Err(bad("a block status")),
    };
    Ok(TranslationBlockInput {
        key: key_of(v.get("key"))?,
        status,
        text: opt_text(v.get("text")),
        runs: v.get("runs").map(json_value_from_serde),
        reason: opt_text(v.get("reason")),
        edited: v.get("edited").and_then(Value::as_bool),
        source_sentence_ends: v.get("sourceSentenceEnds").map(json_value_from_serde),
        sentence_ends: v.get("sentenceEnds").map(json_value_from_serde),
    })
}

fn job_input(v: &Value) -> R<JobRecordInput> {
    let state = match text_of(v.get("state"))? {
        "idle" => JobState::Idle,
        "running" => JobState::Running,
        "stopped" => JobState::Stopped,
        "complete" => JobState::Complete,
        _ => return Err(bad("a job state")),
    };
    let mode = match v.get("mode") {
        None => None,
        Some(mode) => {
            Some(TranslationMode::parse(text_of(Some(mode))?).ok_or_else(|| bad("a mode"))?)
        }
    };
    Ok(JobRecordInput {
        kind: kind_of(v.get("kind"))?,
        lang: opt_text(v.get("lang")),
        run_id: opt_text(v.get("runId")),
        mode,
        state,
        last_error: opt_text(v.get("last_error")),
        resets_at: v.get("resetsAt").and_then(Value::as_f64),
        outputs: match v.get("outputs") {
            None => None,
            outputs => Some(strings_of(outputs)?),
        },
        progress: match v.get("progress") {
            None => None,
            Some(p) => Some(JobProgress {
                done: number_of(p.get("done"))?,
                total: number_of(p.get("total"))?,
            }),
        },
    })
}

fn passage_input(v: &Value) -> R<PassageCardInput> {
    let kind = match text_of(v.get("kind"))? {
        "explain" => PassageKind::Explain,
        "translate" => PassageKind::Translate,
        _ => return Err(bad("a passage kind")),
    };
    let quads = v
        .get("quads")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("quads"))?
        .iter()
        .map(|quad| numbers_of(Some(quad)))
        .collect::<R<Vec<_>>>()?;
    Ok(PassageCardInput {
        id: text_of(v.get("id"))?.to_owned(),
        kind,
        page: number_of(v.get("page"))?,
        page_fingerprint: text_of(v.get("pageFingerprint"))?.to_owned(),
        quads,
        excerpt: text_of(v.get("excerpt"))?.to_owned(),
        passage_hash: text_of(v.get("passageHash"))?.to_owned(),
        lang: opt_text(v.get("lang")),
        text: text_of(v.get("text"))?.to_owned(),
        provider: text_of(v.get("provider"))?.to_owned(),
        model: text_of(v.get("model"))?.to_owned(),
        created_at: number_of(v.get("createdAt"))?,
        saved_as_note: v.get("savedAsNote").and_then(Value::as_bool),
    })
}

fn run_input(v: &Value) -> R<HighlightRun> {
    let labels = v
        .get("labels")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("labels"))?
        .iter()
        .map(|label| {
            let color = numbers_of(label.get("color"))?;
            let color: [f64; 3] = color.try_into().map_err(|_| bad("a color"))?;
            Ok(HighlightLabel {
                id: text_of(label.get("id"))?.to_owned(),
                name: text_of(label.get("name"))?.to_owned(),
                color,
            })
        })
        .collect::<R<Vec<_>>>()?;
    Ok(HighlightRun {
        run_id: text_of(v.get("runId"))?.to_owned(),
        preset_id: text_of(v.get("presetId"))?.to_owned(),
        labels,
        pages: numbers_of(v.get("pages"))?,
        provider: text_of(v.get("provider"))?.to_owned(),
        model: text_of(v.get("model"))?.to_owned(),
        created_at: number_of(v.get("createdAt"))?,
    })
}

fn suggestion_state(v: Option<&Value>) -> R<HighlightSuggestionState> {
    HighlightSuggestionState::parse(text_of(v)?).ok_or_else(|| bad("a suggestion state"))
}

fn highlight_block_input(v: &Value) -> R<HighlightBlockInput> {
    let status = match text_of(v.get("status"))? {
        "done" => HighlightBlockStatus::Done,
        "failed" => HighlightBlockStatus::Failed,
        _ => return Err(bad("a highlight status")),
    };
    let suggestions = v
        .get("suggestions")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("suggestions"))?
        .iter()
        .map(|s| {
            Ok(HighlightSuggestion {
                id: text_of(s.get("id"))?.to_owned(),
                label_id: text_of(s.get("labelId"))?.to_owned(),
                quote: text_of(s.get("quote"))?.to_owned(),
                state: suggestion_state(s.get("state"))?,
            })
        })
        .collect::<R<Vec<_>>>()?;
    Ok(HighlightBlockInput {
        key: key_of(v.get("key"))?,
        status,
        suggestions,
    })
}

fn insights_input(v: &Value) -> R<InsightsEntry> {
    let summary3 = strings_of(v.get("summary3"))?;
    let summary3: [String; 3] = summary3.try_into().map_err(|_| bad("three summaries"))?;
    let terms = v
        .get("terms")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("terms"))?
        .iter()
        .map(|t| {
            Ok(InsightsTerm {
                term: text_of(t.get("term"))?.to_owned(),
                meaning: text_of(t.get("meaning"))?.to_owned(),
                page: number_of(t.get("page"))?,
            })
        })
        .collect::<R<Vec<_>>>()?;
    Ok(InsightsEntry {
        lang: text_of(v.get("lang"))?.to_owned(),
        summary3,
        summary: text_of(v.get("summary"))?.to_owned(),
        terms,
        provider: text_of(v.get("provider"))?.to_owned(),
        model: text_of(v.get("model"))?.to_owned(),
        created_at: number_of(v.get("createdAt"))?,
        page_fingerprints: strings_of(v.get("pageFingerprints"))?,
    })
}

// ---- the answers ----

fn val(v: JsonValue) -> R<Option<Value>> {
    Ok(Some(json_value_to_serde(&v)))
}

/// a value, `null` for none
fn or_null(v: Option<JsonValue>) -> R<Option<Value>> {
    Ok(Some(v.map_or(Value::Null, |v| json_value_to_serde(&v))))
}

fn list(items: Vec<JsonValue>) -> R<Option<Value>> {
    val(JsonValue::Array(items))
}

/// a `Map` as the specs read it: an array of `[key, value]` pairs
fn pairs<V>(map: &JsMap<V>, value: impl Fn(&V) -> JsonValue) -> JsonValue {
    JsonValue::Array(
        map.iter()
            .map(|(key, v)| JsonValue::Array(vec![JsonValue::String(key.to_owned()), value(v)]))
            .collect(),
    )
}

fn text(s: String) -> R<Option<Value>> {
    Ok(Some(Value::from(s)))
}

fn done(result: Result<(), StoreError>) -> R<Option<Value>> {
    result.map_err(fail)?;
    Ok(None)
}

fn count(n: f64) -> R<Option<Value>> {
    Ok(Some(Value::from(n)))
}

// ---- the store ----

fn open(args: &[Value], now_ms: f64) -> R<ResultStore> {
    let options = arg(args, 0).ok_or_else(|| bad("the store options"))?;
    let env: Box<dyn StoreEnv> = Box::new(SystemEnv);
    ResultStore::new(
        text_of(options.get("dir"))?,
        ResultStoreOptions {
            now: Some(Box::new(move || now_ms)),
            running_window_ms: options.get("runningWindowMs").and_then(Value::as_f64),
        },
        env,
    )
    .map_err(fail)
}

/// `None` when the store has no such method
fn store_call(method: &str, args: &[Value], now_ms: f64) -> Option<Answer> {
    // a constructor that throws answers every method alike
    let mut store = match open(args, now_ms) {
        Ok(store) => store,
        Err(error) => return Some(Err(error)),
    };
    run(&mut store, method, &args[1..])
}

fn run(store: &mut ResultStore, method: &str, args: &[Value]) -> Option<Answer> {
    let answer: Answer = (|| {
        let doc = || text_of(arg(args, 0));
        match method {
            "ResultStore" => val(JsonValue::Object(
                [("dir".to_owned(), JsonValue::String(store.dir.clone()))]
                    .into_iter()
                    .collect(),
            )),
            // paths
            "documentDir" => text(store.document_dir(doc()?).map_err(fail)?),
            "aiReadPagePath" => {
                let path = store
                    .ai_read_page_path(doc()?, text_of(arg(args, 1))?)
                    .map_err(fail)?;
                text(path)
            }
            "translationDir" => {
                let path = store
                    .translation_dir(doc()?, text_of(arg(args, 1))?, mode_of(args, 2)?)
                    .map_err(fail)?;
                text(path)
            }
            "translationMetaPath" => {
                let path = store
                    .translation_meta_path(doc()?, text_of(arg(args, 1))?, mode_of(args, 2)?)
                    .map_err(fail)?;
                text(path)
            }
            "translationBlockPath" => {
                let path = store
                    .translation_block_path(
                        doc()?,
                        text_of(arg(args, 1))?,
                        &key_of(arg(args, 2))?,
                        mode_of(args, 3)?,
                    )
                    .map_err(fail)?;
                text(path)
            }
            "jobPath" => {
                let path = store
                    .job_path(
                        doc()?,
                        kind_of(arg(args, 1))?,
                        present(args, 2).and_then(Value::as_str),
                        mode_of(args, 3)?,
                    )
                    .map_err(fail)?;
                text(path)
            }
            "passagePath" => text(
                store
                    .passage_path(doc()?, text_of(arg(args, 1))?)
                    .map_err(fail)?,
            ),
            "highlightRunDir" => text(
                store
                    .highlight_run_dir(doc()?, text_of(arg(args, 1))?)
                    .map_err(fail)?,
            ),
            "highlightBlockPath" => {
                let path = store
                    .highlight_block_path(doc()?, text_of(arg(args, 1))?, &key_of(arg(args, 2))?)
                    .map_err(fail)?;
                text(path)
            }
            "insightsPath" => text(
                store
                    .insights_path(doc()?, text_of(arg(args, 1))?)
                    .map_err(fail)?,
            ),
            "noteLinksPath" => text(store.note_links_path()),
            // AI-read pages
            "writeAiReadPage" => {
                let meta = arg(args, 3);
                let meta = AiReadMeta {
                    provider: meta.and_then(|m| opt_text(m.get("provider"))),
                    model: meta.and_then(|m| opt_text(m.get("model"))),
                };
                let payload = json_value_from_serde(arg(args, 2).unwrap_or(&Value::Null));
                done(store.write_ai_read_page(doc()?, text_of(arg(args, 1))?, &payload, &meta))
            }
            "readAiReadPage" => {
                let entry = store.read_ai_read_page(doc()?, text_of(arg(args, 1))?);
                or_null(entry.map(|e| e.to_value()))
            }
            "readAiReadPages" => val(pairs(&store.read_ai_read_pages(doc()?), |e| e.to_value())),
            // translations
            "writeTranslationMeta" => {
                let meta = arg(args, 2).ok_or_else(|| bad("the meta"))?;
                let meta = TranslationMetaInput {
                    provider: text_of(meta.get("provider"))?.to_owned(),
                    model: text_of(meta.get("model"))?.to_owned(),
                };
                done(store.write_translation_meta(
                    doc()?,
                    text_of(arg(args, 1))?,
                    &meta,
                    mode_of(args, 3)?,
                ))
            }
            "writeTranslationBlock" => {
                let block = block_input(arg(args, 2).ok_or_else(|| bad("a block"))?)?;
                done(store.write_translation_block(
                    doc()?,
                    text_of(arg(args, 1))?,
                    &block,
                    mode_of(args, 3)?,
                ))
            }
            "writeEditedTranslationBlock" => done(store.write_edited_translation_block(
                doc()?,
                text_of(arg(args, 1))?,
                &key_of(arg(args, 2))?,
                text_of(arg(args, 3))?,
                mode_of(args, 4)?,
            )),
            "writeTranslationBlocks" => {
                let blocks = arg(args, 2)
                    .and_then(Value::as_array)
                    .ok_or_else(|| bad("blocks"))?
                    .iter()
                    .map(block_input)
                    .collect::<R<Vec<_>>>()?;
                done(store.write_translation_blocks(
                    doc()?,
                    text_of(arg(args, 1))?,
                    &blocks,
                    mode_of(args, 3)?,
                ))
            }
            "readTranslation" => {
                let found = store
                    .read_translation(doc()?, text_of(arg(args, 1))?, mode_of(args, 2)?)
                    .map_err(fail)?;
                or_null(found.map(|t| {
                    JsonValue::Object(
                        [
                            ("lang".to_owned(), JsonValue::String(t.lang.clone())),
                            (
                                "provider".to_owned(),
                                t.provider
                                    .clone()
                                    .map_or(JsonValue::Null, JsonValue::String),
                            ),
                            (
                                "model".to_owned(),
                                t.model.clone().map_or(JsonValue::Null, JsonValue::String),
                            ),
                            ("blocks".to_owned(), pairs(&t.blocks, |b| b.to_value())),
                        ]
                        .into_iter()
                        .collect(),
                    )
                }))
            }
            "listTranslations" => Ok(Some(strings(
                &store.list_translations(doc()?, mode_of(args, 1)?),
            ))),
            "deleteTranslation" => {
                done(store.delete_translation(doc()?, text_of(arg(args, 1))?, mode_of(args, 2)?))
            }
            "deleteTranslationExceptEdited" => {
                let removed = store
                    .delete_translation_except_edited(
                        doc()?,
                        text_of(arg(args, 1))?,
                        mode_of(args, 2)?,
                    )
                    .map_err(fail)?;
                count(removed)
            }
            "countEditedTranslationBlocks" => {
                let n = store
                    .count_edited_translation_blocks(
                        doc()?,
                        present(args, 1).and_then(Value::as_str),
                        mode_of(args, 2)?,
                    )
                    .map_err(fail)?;
                count(n)
            }
            // job records
            "writeJob" => {
                let job = job_input(arg(args, 1).ok_or_else(|| bad("a job"))?)?;
                done(store.write_job(doc()?, &job))
            }
            "heartbeatJob" => {
                let beat = store
                    .heartbeat_job(
                        doc()?,
                        kind_of(arg(args, 1))?,
                        present(args, 2).and_then(Value::as_str),
                        mode_of(args, 3)?,
                    )
                    .map_err(fail)?;
                Ok(Some(Value::Bool(beat)))
            }
            "readJob" => {
                let status = store.read_job(
                    doc()?,
                    kind_of(arg(args, 1))?,
                    present(args, 2).and_then(Value::as_str),
                    mode_of(args, 3)?,
                );
                val(status.to_value())
            }
            "listJobs" => list(
                store
                    .list_jobs(doc()?)
                    .iter()
                    .map(|j| j.to_value())
                    .collect(),
            ),
            "unfinishedJobs" => list(
                store
                    .unfinished_jobs(doc()?)
                    .iter()
                    .map(|j| j.to_value())
                    .collect(),
            ),
            // passage cards
            "writePassage" => {
                let card = passage_input(arg(args, 1).ok_or_else(|| bad("a card"))?)?;
                done(store.write_passage(doc()?, &card))
            }
            "readPassage" => {
                let card = store.read_passage(doc()?, text_of(arg(args, 1))?);
                or_null(card.map(|c| c.to_value()))
            }
            "readPassages" => list(
                store
                    .read_passages(doc()?)
                    .iter()
                    .map(|c| c.to_value())
                    .collect(),
            ),
            "deletePassage" => done(store.delete_passage(doc()?, text_of(arg(args, 1))?)),
            "countPassages" => count(store.count_passages(doc()?)),
            // AI highlights
            "writeHighlightRun" => {
                let run = run_input(arg(args, 1).ok_or_else(|| bad("a run"))?)?;
                done(store.write_highlight_run(doc()?, &run))
            }
            "readHighlightRun" => {
                let run = store.read_highlight_run(doc()?, text_of(arg(args, 1))?);
                or_null(run.map(|r| r.to_value()))
            }
            "listHighlightRuns" => list(
                store
                    .list_highlight_runs(doc()?)
                    .iter()
                    .map(|r| r.to_value())
                    .collect(),
            ),
            "writeHighlightBlock" => {
                let block = highlight_block_input(arg(args, 2).ok_or_else(|| bad("a block"))?)?;
                done(store.write_highlight_block(doc()?, text_of(arg(args, 1))?, &block))
            }
            "writeHighlightBlocks" => {
                let blocks = arg(args, 2)
                    .and_then(Value::as_array)
                    .ok_or_else(|| bad("blocks"))?
                    .iter()
                    .map(highlight_block_input)
                    .collect::<R<Vec<_>>>()?;
                done(store.write_highlight_blocks(doc()?, text_of(arg(args, 1))?, &blocks))
            }
            "readHighlightBlock" => {
                let entry = store.read_highlight_block(
                    doc()?,
                    text_of(arg(args, 1))?,
                    &key_of(arg(args, 2))?,
                );
                or_null(entry.map(|e| e.to_value()))
            }
            "readHighlightBlocks" => {
                let blocks = store.read_highlight_blocks(doc()?, text_of(arg(args, 1))?);
                val(pairs(&blocks, |b| b.to_value()))
            }
            "setHighlightSuggestionStates" => {
                let mut states = JsObject::new();
                if let Some(Value::Object(map)) = arg(args, 3) {
                    for (id, state) in map {
                        states.set(id.as_str(), suggestion_state(Some(state))?);
                    }
                }
                let changed = store
                    .set_highlight_suggestion_states(
                        doc()?,
                        text_of(arg(args, 1))?,
                        &key_of(arg(args, 2))?,
                        &states,
                    )
                    .map_err(fail)?;
                Ok(Some(Value::Bool(changed)))
            }
            "deleteHighlightRun" => {
                done(store.delete_highlight_run(doc()?, text_of(arg(args, 1))?))
            }
            // insights
            "writeInsights" => {
                let entry = insights_input(arg(args, 1).ok_or_else(|| bad("an entry"))?)?;
                done(store.write_insights(doc()?, &entry))
            }
            "readInsights" => {
                let entry = store.read_insights(doc()?, text_of(arg(args, 1))?);
                or_null(entry.map(|e| e.to_value()))
            }
            "listInsights" => Ok(Some(strings(&store.list_insights(doc()?)))),
            "deleteInsights" => done(store.delete_insights(doc()?, text_of(arg(args, 1))?)),
            // note links
            "readNoteLinks" => val(store.read_note_links().to_value()),
            "findNoteLink" => {
                let found = store.find_note_link(text_of(arg(args, 0))?, text_of(arg(args, 1))?);
                or_null(found.map(|f| f.to_value()))
            }
            "setNoteLink" => {
                let link = arg(args, 1).ok_or_else(|| bad("a link"))?;
                done(store.set_note_link(
                    text_of(arg(args, 0))?,
                    text_of(link.get("notePath"))?,
                    text_of(link.get("docHash"))?,
                ))
            }
            "updateNoteLinkDocHash" => {
                let changed = store
                    .update_note_link_doc_hash(text_of(arg(args, 0))?, text_of(arg(args, 1))?)
                    .map_err(fail)?;
                Ok(Some(Value::Bool(changed)))
            }
            // migration, delete and size
            "migrateDocument" => {
                let input = arg(args, 0).ok_or_else(|| bad("the input"))?;
                let keep = match input.get("keepBlockKeys") {
                    None => None,
                    Some(keys) => Some(
                        keys.as_array()
                            .ok_or_else(|| bad("keys"))?
                            .iter()
                            .map(|key| key_of(Some(key)))
                            .collect::<R<Vec<_>>>()?,
                    ),
                };
                let input = MigrateInput {
                    old_doc_hash: text_of(input.get("oldDocHash"))?.to_owned(),
                    new_doc_hash: text_of(input.get("newDocHash"))?.to_owned(),
                    page_fingerprints: strings_of(input.get("pageFingerprints"))?,
                    keep_block_keys: keep,
                };
                let moved = store.migrate_document(&input).map_err(fail)?;
                val(moved.to_value())
            }
            "deleteDocument" => done(store.delete_document(doc()?)),
            "deleteAll" => done(store.delete_all()),
            "size" => count(store.size(present(args, 0).and_then(Value::as_str))),
            _ => Err(CallError::plain(format!("no such method: {method}"))),
        }
    })();
    // a method the store has not is no function of this group
    if matches!(&answer, Err(e) if e.message.starts_with("no such method: ")) {
        return None;
    }
    Some(answer)
}
