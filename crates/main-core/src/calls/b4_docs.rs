//! The functions of group `b4-docs` (tools/main-diff/groups/b4-docs.ts): the
//! modules of `apps/docs/src/main`, `apps/diagram/src/main` and
//! `apps/mindmap/src/main` that hold no Electron object.
//!
//! Names are `<ts-file>.<export>`; a file whose name more than one app has
//! (`atomic-write`, `save-as-formats`, `print-document`) is `<app>/<ts-file>`.
//!
//! An argument the TypeScript takes as `unknown` is the JSON value, read as
//! JavaScript would hold it: a top-level JSON `null` is `undefined` (left
//! out), and `{"$val": "null" | "NaN" | "Infinity" | "-Infinity" | "-0"}`
//! (anywhere inside) is that value, which JSON cannot carry. Bytes are hex
//! strings. What the TypeScript takes as an object with methods or a callback
//! is a fake the spec describes; each of its calls is one `logs` line, and the
//! TypeScript writes the same lines. Module state (the handoffs, the print
//! documents, the coalescer, the Zotero client) is driven as a scenario:
//! `{ ops: [...] }`, its clock a fake the `advance` op moves.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};

use jscompat::{JsObject, JsonValue, json_value_to_serde};
use serde_json::{Map, Number, Value, json};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::diagram::drawio_protocol::{
    DrawioTarget, content_type_of, drawio_csp, drawio_scheme_privilege, inject_bridge,
    print_page_csp, resolve_drawio_request, response_headers,
};
use crate::diagram::export_paths::page_file_paths;
use crate::diagram::network_guard::{
    self, DIAGRAM_PARTITION, REFUSED_ADDRESSES_KEPT, RequestLog, dev_server_origins,
    is_allowed_diagram_request, is_allowed_navigation, new_request_log, screen_request,
    window_open_action,
};
use crate::diagram::print_document::{
    PrintDocuments, PrintPage, build_print_html, inert_svg, is_print_cancel, is_print_page,
};
use crate::docs::atomic_write::{atomic_write_file, looks_like_zip};
use crate::docs::byte_handoff::{ByteHandoffs, ByteLength};
use crate::docs::copy_image_guard::{
    MAX_COPY_IMAGE_DATA_URL, copy_image_display_size, valid_copy_image_data_url,
};
use crate::docs::doc_format::{
    DocFormat, Materialized, PreparedSave, RecoveryBytesDeps, SaveBytesDeps, doc_format_of_path,
    is_odt_package, prepare_recovery_bytes, prepare_save_bytes, recovery_ext_for,
    with_doc_extension, zip_entry_names,
};
use crate::docs::external_change::{DiskFileState, is_externally_modified};
use crate::docs::hwp_export::{
    HwpConversion, HwpError, HwpExportJob, HwpExportOutcome, HwpExportReply, HwpExportRequest,
    HwpExportSteps, HwpFormat, HwpWorker, Loss, WorkerEvent, convert_in_worker, export_hwp,
    hwp_loss_message_box,
};
use crate::docs::hwp_export_strings::HWP_EXPORT_STRINGS;
use crate::docs::lazy_media_inline::{LazyMedia, inline_lazy_media_in_html};
use crate::docs::merge_output::{merge_output_file_name, merge_output_path};
use crate::docs::print_args::{
    print_job_options, print_paper_option, print_scale_option, valid_print_dim,
    valid_print_geometry, valid_print_paper, valid_print_scale,
};
use crate::docs::read_url_ipc::{
    ReadUrlRequest, normalize_read_url_request, unexpected_read_url_failure,
};
use crate::docs::save_as_formats::{
    HwpExportFormat, SaveAsFilter, hwp_export_filters, hwp_export_target, save_as_default_path,
    save_as_filters, save_as_target,
};
use crate::docs::starred_files::{
    StarredItem, assign_starred_group, drop_starred_items, parse_starred_items, read_starred_items,
    rename_starred_item, starred_group_map, starred_group_names, toggle_starred_item,
    write_starred_items,
};
use crate::docs::stream_coalesce::{STREAM_COALESCE_MS, create_chunk_coalescer};
use crate::docs::zotero_wire::{
    Handled, ZOTERO_INTEGRATION_HOST, ZOTERO_INTEGRATION_PORT, ZoteroFrameDecoder, ZoteroNet,
    ZoteroWireClient, ZoteroWireRequest, encode_zotero_frame,
};
use crate::mindmap::save_as_formats as mindmap_save_as;
use crate::node_fs::NodeError;
use crate::packages::i18n::{Lang, normalize_lang};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- apps/docs/src/main ----
        "docs/atomic-write.looksLikeZip" => {
            bytes_arg(args, 0).map(|bytes| Some(Value::Bool(looks_like_zip(&bytes))))
        }
        "docs/atomic-write.atomicWriteFile" | "mindmap/atomic-write.atomicWriteFile" => {
            atomic_write_call(args)
        }
        "byte-handoff.handOffBytes"
        | "byte-handoff.takeHandoff"
        | "byte-handoff.pendingHandoffCount" => byte_handoff_call(args),
        "copy-image-guard.MAX_COPY_IMAGE_DATA_URL" => {
            Ok(Some(Value::from(MAX_COPY_IMAGE_DATA_URL as u64)))
        }
        "copy-image-guard.validCopyImageDataUrl" => Ok(Some(Value::Bool(
            valid_copy_image_data_url(js(args, 0).as_ref()),
        ))),
        "copy-image-guard.copyImageDisplaySize" => {
            let size = copy_image_display_size(js(args, 0).as_ref());
            Ok(Some(serde_json::to_value(size).expect("a size prints")))
        }
        "doc-format.docFormatOfPath" => str_arg(args, 0).map(|path| {
            Some(doc_format_of_path(path).map_or(Value::Null, |f| Value::from(f.as_str())))
        }),
        "doc-format.zipEntryNames" => bytes_arg(args, 0).map(|bytes| {
            Some(zip_entry_names(&bytes).map_or(Value::Null, |names| {
                Value::Array(names.into_iter().map(Value::from).collect())
            }))
        }),
        "doc-format.isOdtPackage" => {
            bytes_arg(args, 0).map(|bytes| Some(Value::Bool(is_odt_package(&bytes))))
        }
        "doc-format.withDocExtension" => str_arg(args, 0).and_then(|path| {
            let fallback = format_arg(args, 1)?;
            Ok(Some(Value::from(with_doc_extension(path, fallback))))
        }),
        "doc-format.recoveryExtFor" => {
            str_arg(args, 0).map(|path| Some(Value::from(recovery_ext_for(path))))
        }
        "doc-format.prepareSaveBytes" => prepare_save_call(args, cx),
        "doc-format.prepareRecoveryBytes" => prepare_recovery_call(args, cx),
        "external-change.isExternallyModified" => external_change_call(args, cx),
        "hwp-export.convertInWorker" => convert_in_worker_call(args, cx),
        "hwp-export.HwpExportFailure" => hwp_failure_call(args),
        "hwp-export.exportHwp" => export_hwp_call(args, cx),
        "hwp-export.hwpLossMessageBox" => loss_box_call(args),
        "hwp-export-strings.HWP_EXPORT_STRINGS" => Ok(Some(strings_table())),
        "lazy-media-inline.inlineLazyMediaInHtml" => inline_media_call(args, cx),
        "merge-output.mergeOutputFileName" => {
            str_arg(args, 0).map(|name| Some(Value::from(merge_output_file_name(name))))
        }
        "merge-output.mergeOutputPath" => str_arg(args, 0).and_then(|dir| {
            let name = str_arg(args, 1)?;
            Ok(Some(Value::from(merge_output_path(dir, name))))
        }),
        "print-args.validPrintDim" => Ok(Some(Value::Bool(valid_print_dim(js(args, 0).as_ref())))),
        "print-args.validPrintScale" => {
            Ok(Some(Value::Bool(valid_print_scale(js(args, 0).as_ref()))))
        }
        "print-args.validPrintGeometry" => Ok(Some(Value::Bool(valid_print_geometry(
            js(args, 0).as_ref(),
            js(args, 1).as_ref(),
            js(args, 2).as_ref(),
        )))),
        "print-args.printScaleOption" => {
            let mut out = Map::new();
            if let Some(scale) = print_scale_option(js(args, 0).as_ref()) {
                out.insert("scale".into(), num(scale));
            }
            Ok(Some(Value::Object(out)))
        }
        "print-args.validPrintPaper" => Ok(Some(match valid_print_paper(js(args, 0).as_ref()) {
            Some(paper) => json!({
                "widthTwips": num(paper.width_twips),
                "heightTwips": num(paper.height_twips),
            }),
            None => Value::Null,
        })),
        "print-args.printPaperOption" => {
            let mut out = Map::new();
            if let Some((width, height)) = print_paper_option(js(args, 0).as_ref()) {
                out.insert(
                    "pageSize".into(),
                    json!({ "width": num(width), "height": num(height) }),
                );
            }
            Ok(Some(Value::Object(out)))
        }
        "print-args.printJobOptions" => Ok(Some(
            serde_json::to_value(print_job_options(arg(args, 0))).expect("options print"),
        )),
        "read-url-ipc.unexpectedReadUrlFailure" => {
            let failure = unexpected_read_url_failure();
            Ok(Some(json!({
                "ok": false,
                "error": failure.error,
                "errorCode": failure.error_code,
            })))
        }
        "read-url-ipc.normalizeReadUrlRequest" => Ok(Some(
            match normalize_read_url_request(js(args, 0).as_ref(), js(args, 1).as_ref()) {
                ReadUrlRequest::Ok { url, offset } => {
                    json!({ "ok": true, "url": url, "offset": num(offset) })
                }
                ReadUrlRequest::Failure(failure) => json!({
                    "ok": false,
                    "error": failure.error,
                    "errorCode": failure.error_code,
                }),
            },
        )),
        "docs/save-as-formats.saveAsFilters" => docs_filters_call(args, cx),
        "docs/save-as-formats.saveAsDefaultPath" => str_arg(args, 0).and_then(|suggestion| {
            let offer = bool_arg(args, 1)?;
            Ok(Some(Value::from(save_as_default_path(suggestion, offer))))
        }),
        "docs/save-as-formats.saveAsTarget" => str_arg(args, 0).and_then(|path| {
            let current = format_arg(args, 1)?;
            let offer = bool_arg(args, 2)?;
            let (path, kind) = save_as_target(path, current, offer);
            Ok(Some(json!({ "path": path, "kind": kind.as_str() })))
        }),
        "docs/save-as-formats.hwpExportFilters" => hwp_filters_call(args, cx),
        "docs/save-as-formats.hwpExportTarget" => str_arg(args, 0).and_then(|path| {
            let first = hwp_format_arg(args, 1)?;
            let (path, format) = hwp_export_target(path, first);
            Ok(Some(json!({ "path": path, "format": format.as_str() })))
        }),
        "starred-files.parseStarredItems" => {
            Ok(Some(items_json(&parse_starred_items(js(args, 0).as_ref()))))
        }
        "starred-files.readStarredItems" => {
            str_arg(args, 0).map(|path| Some(items_json(&read_starred_items(path))))
        }
        "starred-files.writeStarredItems" => str_arg(args, 0).and_then(|path| {
            let items = items_arg(args, 1)?;
            write_starred_items(path, &items)
                .map(|()| None)
                .map_err(masked)
        }),
        "starred-files.toggleStarredItem" => items_arg(args, 0).and_then(|items| {
            let path = str_arg(args, 1)?;
            Ok(Some(items_json(&toggle_starred_item(&items, path))))
        }),
        "starred-files.dropStarredItems" => items_arg(args, 0).and_then(|items| {
            let paths = strings_arg(args, 1)?;
            Ok(Some(
                drop_starred_items(&items, &paths).map_or(Value::Null, |next| items_json(&next)),
            ))
        }),
        "starred-files.assignStarredGroup" => items_arg(args, 0).and_then(|items| {
            let paths = strings_arg(args, 1)?;
            let group = match arg(args, 2) {
                Some(Value::String(group)) => Some(group.as_str()),
                _ => None,
            };
            Ok(Some(
                assign_starred_group(&items, &paths, group)
                    .map_or(Value::Null, |next| items_json(&next)),
            ))
        }),
        "starred-files.renameStarredItem" => items_arg(args, 0).and_then(|items| {
            let old_path = str_arg(args, 1)?;
            let new_path = str_arg(args, 2)?;
            Ok(Some(
                rename_starred_item(&items, old_path, new_path)
                    .map_or(Value::Null, |next| items_json(&next)),
            ))
        }),
        "starred-files.starredGroupNames" => items_arg(args, 0).map(|items| {
            Some(Value::Array(
                starred_group_names(&items)
                    .into_iter()
                    .map(Value::from)
                    .collect(),
            ))
        }),
        "starred-files.starredGroupMap" => items_arg(args, 0).map(|items| {
            let map = starred_group_map(&items);
            Some(Value::Array(
                map.iter()
                    .map(|(path, group)| json!([path, group]))
                    .collect(),
            ))
        }),
        "stream-coalesce.STREAM_COALESCE_MS" => Ok(Some(num(STREAM_COALESCE_MS))),
        "stream-coalesce.createChunkCoalescer" => coalescer_call(args, cx),
        "zotero-wire.ZOTERO_INTEGRATION_HOST" => Ok(Some(Value::from(ZOTERO_INTEGRATION_HOST))),
        "zotero-wire.ZOTERO_INTEGRATION_PORT" => Ok(Some(num(ZOTERO_INTEGRATION_PORT))),
        "zotero-wire.encodeZoteroFrame" => {
            let id = match js(args, 0) {
                Some(JsonValue::Number(x)) => x,
                _ => return Some(Err(bad("a transaction id"))),
            };
            str_arg(args, 1)
                .map(|payload| Some(Value::from(hex(&encode_zotero_frame(id, payload)))))
        }
        "zotero-wire.ZoteroFrameDecoder" => decoder_call(args),
        "zotero-wire.ZoteroWireClient" => zotero_client_call(args, cx),

        // ---- apps/diagram/src/main ----
        "drawio-protocol.DRAWIO_SCHEME_PRIVILEGE" => Ok(Some(
            serde_json::to_value(drawio_scheme_privilege()).expect("a scheme prints"),
        )),
        "drawio-protocol.drawioCsp" => strings_arg(args, 0).map(|ancestors| {
            let ancestors: Vec<&str> = ancestors.iter().map(String::as_str).collect();
            Some(Value::from(drawio_csp(&ancestors)))
        }),
        "drawio-protocol.PRINT_PAGE_CSP" => Ok(Some(Value::from(print_page_csp()))),
        "drawio-protocol.contentTypeOf" => {
            str_arg(args, 0).map(|path| Some(Value::from(content_type_of(path))))
        }
        "drawio-protocol.resolveDrawioRequest" => str_arg(args, 0).and_then(|root| {
            let url = str_arg(args, 1)?;
            Ok(Some(target_json(&resolve_drawio_request(root, url))))
        }),
        "drawio-protocol.injectBridge" => str_arg(args, 0).and_then(|html| {
            inject_bridge(html)
                .map(|html| Some(Value::from(html)))
                .map_err(CallError::plain)
        }),
        "drawio-protocol.responseHeaders" => str_arg(args, 0).and_then(|content_type| {
            let csp = str_arg(args, 1)?;
            let mut out = Map::new();
            for (key, value) in response_headers(content_type, csp) {
                out.insert(key.into(), Value::from(value));
            }
            Ok(Some(Value::Object(out)))
        }),
        "export-paths.pageFilePaths" => str_arg(args, 0).and_then(|chosen| {
            let ext = str_arg(args, 1)?;
            let numbers = numbers_arg(args, 2)?;
            let per_page = bool_arg(args, 3)?;
            Ok(Some(Value::Array(
                page_file_paths(chosen, ext, &numbers, per_page)
                    .into_iter()
                    .map(Value::from)
                    .collect(),
            )))
        }),
        "network-guard.DIAGRAM_PARTITION" => Ok(Some(Value::from(DIAGRAM_PARTITION))),
        "network-guard.devServerOrigins" => {
            let addresses: Vec<Option<&str>> = match arg(args, 0) {
                Some(Value::Array(items)) => items.iter().map(Value::as_str).collect(),
                _ => return Some(Err(bad("addresses"))),
            };
            bool_arg(args, 1).map(|packaged| {
                Some(Value::Array(
                    dev_server_origins(&addresses, packaged)
                        .into_iter()
                        .map(Value::from)
                        .collect(),
                ))
            })
        }
        "network-guard.isAllowedDiagramRequest" => str_arg(args, 0).and_then(|url| {
            // `devOrigins = []` when left out
            let origins = if js(args, 1).is_some() {
                strings_arg(args, 1)?
            } else {
                Vec::new()
            };
            Ok(Some(Value::Bool(is_allowed_diagram_request(url, &origins))))
        }),
        "network-guard.windowOpenAction" => Ok(Some(json!({ "action": window_open_action() }))),
        "network-guard.isAllowedNavigation" => str_arg(args, 0).and_then(|url| {
            let is_main_frame = bool_arg(args, 1)?;
            let current_url = str_arg(args, 2)?;
            Ok(Some(Value::Bool(is_allowed_navigation(
                url,
                is_main_frame,
                current_url,
            ))))
        }),
        "network-guard.REFUSED_ADDRESSES_KEPT" => {
            Ok(Some(Value::from(REFUSED_ADDRESSES_KEPT as u64)))
        }
        "network-guard.newRequestLog" => Ok(Some(log_json(&new_request_log()))),
        "network-guard.screenRequest" => screen_call(args),
        "diagram/print-document.isPrintPage" => {
            Ok(Some(Value::Bool(is_print_page(js(args, 0).as_ref()))))
        }
        "diagram/print-document.inertSvg" => {
            str_arg(args, 0).map(|svg| Some(Value::from(inert_svg(svg))))
        }
        "diagram/print-document.buildPrintHtml" => pages_arg(args, 0).map(|pages| {
            let title = match js(args, 1) {
                Some(JsonValue::String(title)) => title,
                _ => String::new(),
            };
            Some(Value::from(build_print_html(&pages, &title)))
        }),
        "diagram/print-document.isPrintCancel" => {
            Ok(Some(Value::Bool(is_print_cancel(js(args, 0).as_ref()))))
        }
        "diagram/print-document.holdPrintDocument"
        | "diagram/print-document.takePrintDocument"
        | "diagram/print-document.dropPrintDocument" => print_documents_call(args),

        // ---- apps/mindmap/src/main ----
        "mindmap/save-as-formats.saveAsFilters" => mindmap_filters_call(args, cx),
        "mindmap/save-as-formats.saveAsDefaultPath" => str_arg(args, 0).and_then(|suggestion| {
            let offer = bool_arg(args, 1)?;
            Ok(Some(Value::from(mindmap_save_as::save_as_default_path(
                suggestion, offer,
            ))))
        }),
        "mindmap/save-as-formats.saveAsTarget" => str_arg(args, 0).and_then(|path| {
            let offer = bool_arg(args, 1)?;
            let (path, kind) = mindmap_save_as::save_as_target(path, offer);
            Ok(Some(json!({ "path": path, "kind": kind.as_str() })))
        }),
        _ => return None,
    })
}

// ---- reading arguments ----

fn bad(what: &str) -> CallError {
    CallError::plain(format!("bad argument: {what}"))
}

/// a JSON number as JavaScript prints it: a non-finite one is `null`
fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>, CallError> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return Err(bad("hex"));
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).map_err(|_| bad("hex")))
        .collect()
}

fn bytes_arg(args: &[Value], i: usize) -> Result<Vec<u8>, CallError> {
    unhex(str_arg(args, i)?)
}

fn bool_arg(args: &[Value], i: usize) -> Result<bool, CallError> {
    arg(args, i)
        .and_then(Value::as_bool)
        .ok_or_else(|| bad("a boolean"))
}

fn strings_arg(args: &[Value], i: usize) -> Result<Vec<String>, CallError> {
    arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

fn numbers_arg(args: &[Value], i: usize) -> Result<Vec<f64>, CallError> {
    arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| match revive(v) {
            JsonValue::Number(x) => Ok(x),
            _ => Err(bad("a number")),
        })
        .collect()
}

fn format_arg(args: &[Value], i: usize) -> Result<DocFormat, CallError> {
    match str_arg(args, i)? {
        "docx" => Ok(DocFormat::Docx),
        "odt" => Ok(DocFormat::Odt),
        _ => Err(bad("a document format")),
    }
}

fn hwp_format_arg(args: &[Value], i: usize) -> Result<HwpExportFormat, CallError> {
    match str_arg(args, i)? {
        "hwp" => Ok(HwpExportFormat::Hwp),
        "hwpx" => Ok(HwpExportFormat::Hwpx),
        _ => Err(bad("a Hangul format")),
    }
}

/// The JSON value as JavaScript holds it (see the module): the markers become
/// the numbers and the `null` they stand for.
fn revive(value: &Value) -> JsonValue {
    match value {
        Value::Null => JsonValue::Null,
        Value::Bool(flag) => JsonValue::Bool(*flag),
        Value::Number(n) => JsonValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => JsonValue::String(text.clone()),
        Value::Array(items) => JsonValue::Array(items.iter().map(revive).collect()),
        Value::Object(map) => {
            if map.len() == 1
                && let Some(Value::String(marker)) = map.get("$val")
            {
                match marker.as_str() {
                    "null" => return JsonValue::Null,
                    "NaN" => return JsonValue::Number(f64::NAN),
                    "Infinity" => return JsonValue::Number(f64::INFINITY),
                    "-Infinity" => return JsonValue::Number(f64::NEG_INFINITY),
                    "-0" => return JsonValue::Number(-0.0),
                    _ => {}
                }
            }
            let mut object = JsObject::new();
            for (key, item) in map {
                object.set(key.clone(), revive(item));
            }
            JsonValue::Object(object)
        }
    }
}

/// The argument at `i` as `unknown`: absent or `null` is `undefined`.
fn js(args: &[Value], i: usize) -> Option<JsonValue> {
    match arg(args, i) {
        None | Some(Value::Null) => None,
        Some(value) => Some(revive(value)),
    }
}

fn field<'a>(object: &'a Value, key: &str) -> Option<&'a Value> {
    object.get(key).filter(|value| !value.is_null())
}

fn field_str<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
    field(object, key).and_then(Value::as_str)
}

fn field_f64(object: &Value, key: &str) -> Option<f64> {
    field(object, key).and_then(|value| match revive(value) {
        JsonValue::Number(x) => Some(x),
        _ => None,
    })
}

fn field_list<'a>(object: &'a Value, key: &str) -> &'a [Value] {
    field(object, key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// `list[x]` of a JavaScript array: only a whole number from 0 names an item
fn index(x: f64) -> Option<usize> {
    (x >= 0.0 && x.fract() == 0.0 && x < 1e15).then_some(x as usize)
}

fn spec_arg(args: &[Value], i: usize) -> Result<&Value, CallError> {
    arg(args, i)
        .filter(|value| value.is_object())
        .ok_or_else(|| bad("a scenario"))
}

/// `.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')`: a temp name's random part
/// differs on each side, so both sides write it as `<hex>`.
fn mask_tmp(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut at = 0;
    let mut copied = 0;
    while at + 17 <= bytes.len() {
        let window = &bytes[at..at + 17];
        if window[0] == b'.'
            && window[1..13]
                .iter()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            && &window[13..] == b".tmp"
        {
            out.push_str(&text[copied..at]);
            out.push_str(".<hex>.tmp");
            at += 17;
            copied = at;
        } else {
            at += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

fn masked(mut error: NodeError) -> CallError {
    error.message = mask_tmp(&error.message);
    error.into()
}

// ---- docs/atomic-write ----

fn atomic_write_call(args: &[Value]) -> Answer {
    let path = str_arg(args, 0)?;
    let text = str_arg(args, 1)?;
    atomic_write_file(path, text.as_bytes())
        .map(|()| None)
        .map_err(masked)
}

// ---- byte-handoff ----

/// A handoff's bytes, as the scenario describes them: a length (a fake past
/// what a test can allocate) and the content when it is small.
struct FakeBytes {
    len: u64,
    hex: Option<String>,
}

impl ByteLength for FakeBytes {
    fn byte_length(&self) -> u64 {
        self.len
    }
}

/// `{ tokens?, ops: [{ op: 'handOff', len | hex }, { op: 'take', url | ref },
/// { op: 'count' }, { op: 'advance', ms }] }`. `crypto.randomUUID()` answers
/// `tokens[n]`, else `uuid-<n + 1>`; the clock starts at 0; every timer left
/// fires at the end.
fn byte_handoff_call(args: &[Value]) -> Answer {
    let spec = spec_arg(args, 0)?;
    let tokens = field_list(spec, "tokens");
    let mut made = 0usize;
    let mut now = 0.0;
    let mut handoffs: ByteHandoffs<FakeBytes> = ByteHandoffs::new();
    let mut urls: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for op in field_list(spec, "ops") {
        match field_str(op, "op") {
            Some("handOff") => {
                let bytes = match field_str(op, "hex") {
                    Some(text) => FakeBytes {
                        len: unhex(text)?.len() as u64,
                        hex: Some(text.to_owned()),
                    },
                    None => FakeBytes {
                        len: field_f64(op, "len").unwrap_or(0.0) as u64,
                        hex: None,
                    },
                };
                let token = tokens
                    .get(made)
                    .and_then(Value::as_str)
                    .map_or_else(|| format!("uuid-{}", made + 1), str::to_owned);
                made += 1;
                let url = handoffs.hand_off_bytes(bytes, token, now);
                urls.push(url.clone());
                out.push(json!({ "op": "handOff", "url": url }));
            }
            Some("take") => {
                let url = match field_str(op, "url") {
                    Some(url) => url.to_owned(),
                    None => field_f64(op, "ref")
                        .and_then(index)
                        .and_then(|at| urls.get(at))
                        .cloned()
                        .unwrap_or_default(),
                };
                out.push(match handoffs.take_handoff(&url) {
                    None => json!({ "op": "take", "found": false }),
                    Some(bytes) => {
                        let mut entry = Map::new();
                        entry.insert("op".into(), "take".into());
                        entry.insert("found".into(), true.into());
                        entry.insert("len".into(), Value::from(bytes.len));
                        if let Some(text) = bytes.hex {
                            entry.insert("hex".into(), text.into());
                        }
                        Value::Object(entry)
                    }
                });
            }
            Some("count") => {
                out.push(json!({ "op": "count", "n": handoffs.pending_handoff_count() as u64 }))
            }
            Some("advance") => {
                now += field_f64(op, "ms").unwrap_or(0.0);
                handoffs.expire(now);
                out.push(json!({ "op": "advance", "now": num(now) }));
            }
            _ => return Err(bad("an op")),
        }
    }
    handoffs.expire(f64::INFINITY);
    Ok(Some(Value::Array(out)))
}

// ---- doc-format ----

/// A fake step's `{ throws }`, or what it describes.
fn fake_bytes(step: Option<&Value>) -> Result<Option<Vec<u8>>, CallError> {
    match step.and_then(|step| field_str(step, "append")) {
        Some(text) => unhex(text).map(Some),
        None => Ok(None),
    }
}

fn throws_of(step: Option<&Value>) -> Option<String> {
    step.and_then(|step| field_str(step, "throws"))
        .map(str::to_owned)
}

/// the lines of the fakes of `doc-format`: each call with its bytes
fn log_line(cx_logs: &RefCell<Vec<Vec<Value>>>, line: Vec<Value>) {
    cx_logs.borrow_mut().push(line);
}

/// `materialize: { append?, hashes?, throws? }` as a function
fn make_materialize<'a>(
    step: Option<&'a Value>,
    logs: &'a RefCell<Vec<Vec<Value>>>,
) -> Result<impl FnMut(&[u8]) -> Result<Materialized, String> + 'a, CallError> {
    let append = fake_bytes(step)?.unwrap_or_default();
    let throws = throws_of(step);
    let hashes: Vec<String> = step
        .map(|step| {
            field_list(step, "hashes")
                .iter()
                .filter_map(|hash| hash.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Ok(move |plain: &[u8]| {
        log_line(logs, vec!["materialize".into(), hex(plain).into()]);
        if let Some(message) = &throws {
            return Err(message.clone());
        }
        let mut bytes = plain.to_vec();
        bytes.extend_from_slice(&append);
        // `new Set(hashes)`
        let mut distinct: Vec<String> = Vec::new();
        for hash in &hashes {
            if !distinct.contains(hash) {
                distinct.push(hash.clone());
            }
        }
        Ok(Materialized {
            bytes,
            hashes: distinct,
        })
    })
}

fn prepared_json(prepared: &PreparedSave) -> Value {
    json!({
        "bytes": hex(&prepared.bytes),
        "plain": hex(&prepared.plain),
        "hashes": prepared.hashes,
        "encrypted": prepared.encrypted,
    })
}

/// `[format, hex, { materialize, encrypt: { throws? }, password }]`;
/// `encrypt(plain, password)` is `ENC:<password>` and the plain bytes.
fn prepare_save_call(args: &[Value], cx: &mut Context) -> Answer {
    let format = format_arg(args, 0)?;
    let data = bytes_arg(args, 1)?;
    let deps = arg(args, 2).ok_or_else(|| bad("deps"))?;
    let logs = RefCell::new(Vec::new());
    let mut materialize = make_materialize(field(deps, "materialize"), &logs)?;
    let encrypt_throws = throws_of(field(deps, "encrypt"));
    let mut encrypt = |plain: &[u8], password: &str| {
        log_line(
            &logs,
            vec!["encrypt".into(), hex(plain).into(), password.into()],
        );
        if let Some(message) = &encrypt_throws {
            return Err(message.clone());
        }
        let mut bytes = format!("ENC:{password}").into_bytes();
        bytes.extend_from_slice(plain);
        Ok(bytes)
    };
    let password = field_str(deps, "password");
    let result = prepare_save_bytes(
        format,
        &data,
        &mut SaveBytesDeps {
            materialize: &mut materialize,
            encrypt: &mut encrypt,
            password,
        },
    );
    drop(materialize);
    cx.logs.extend(logs.into_inner());
    result
        .map(|prepared| Some(prepared_json(&prepared)))
        .map_err(CallError::plain)
}

/// `[format, hex, { materialize, protect: { mode: 'prefix' | 'null' | 'throws' } }]`
fn prepare_recovery_call(args: &[Value], cx: &mut Context) -> Answer {
    let format = format_arg(args, 0)?;
    let data = bytes_arg(args, 1)?;
    let deps = arg(args, 2).ok_or_else(|| bad("deps"))?;
    let logs = RefCell::new(Vec::new());
    let mut materialize = make_materialize(field(deps, "materialize"), &logs)?;
    let mode = field(deps, "protect")
        .and_then(|step| field_str(step, "mode"))
        .unwrap_or("prefix")
        .to_owned();
    let mut protect = |plain: &[u8]| {
        log_line(&logs, vec!["protect".into(), hex(plain).into()]);
        match mode.as_str() {
            "null" => Ok(None),
            "throws" => Err("protect failed".to_owned()),
            _ => {
                let mut bytes = b"P:".to_vec();
                bytes.extend_from_slice(plain);
                Ok(Some(bytes))
            }
        }
    };
    let result = prepare_recovery_bytes(
        format,
        &data,
        &mut RecoveryBytesDeps {
            materialize: &mut materialize,
            protect: &mut protect,
        },
    );
    drop(materialize);
    cx.logs.extend(logs.into_inner());
    result
        .map(|bytes| Some(bytes.map_or(Value::Null, |bytes| Value::from(hex(&bytes)))))
        .map_err(CallError::plain)
}

// ---- external-change ----

/// `[recorded | null, current | null, { hash } | { throws }]`
fn external_change_call(args: &[Value], cx: &mut Context) -> Answer {
    let recorded = arg(args, 0)
        .filter(|value| !value.is_null())
        .map(|value| DiskFileState {
            mtime_ms: field_f64(value, "mtimeMs").unwrap_or(f64::NAN),
            size: field_f64(value, "size").unwrap_or(f64::NAN),
            hash: field_str(value, "hash").unwrap_or("").to_owned(),
        });
    let current = arg(args, 1).filter(|value| !value.is_null()).map(|value| {
        (
            field_f64(value, "mtimeMs").unwrap_or(f64::NAN),
            field_f64(value, "size").unwrap_or(f64::NAN),
        )
    });
    let reader = arg(args, 2).ok_or_else(|| bad("readHash"))?;
    let logs = RefCell::new(Vec::new());
    let mut read_hash = || {
        log_line(&logs, vec!["readHash".into()]);
        match field_str(reader, "throws") {
            Some(message) => Err(message.to_owned()),
            None => Ok(field_str(reader, "hash").map(str::to_owned)),
        }
    };
    let result = is_externally_modified(recorded.as_ref(), current, &mut read_hash);
    cx.logs.extend(logs.into_inner());
    result
        .map(|modified| Some(Value::Bool(modified)))
        .map_err(CallError::plain)
}

// ---- hwp-export ----

fn hwp_format_of(text: &str) -> HwpFormat {
    if text == "hwpx" {
        HwpFormat::Hwpx
    } else {
        HwpFormat::Hwp
    }
}

/// `{ kind: 'error' | 'failure' | 'string', message, code? }`: what a fake
/// step throws.
fn thrown(spec: &Value) -> HwpError {
    let message = field_str(spec, "message").unwrap_or("").to_owned();
    match field_str(spec, "kind") {
        Some("failure") => HwpError::Failure {
            code: field_str(spec, "code").unwrap_or("").to_owned(),
            message,
        },
        Some("string") => HwpError::Other(message),
        _ => HwpError::Error(message),
    }
}

fn hwp_call_error(error: HwpError) -> CallError {
    match error {
        HwpError::Failure { code, message } => CallError {
            code: Some(code),
            message,
        },
        HwpError::Error(message) | HwpError::Other(message) => CallError::plain(message),
    }
}

fn loss_of(value: &Value) -> Loss {
    Loss {
        feature: field_str(value, "feature").unwrap_or("").to_owned(),
        kind: field_str(value, "kind").unwrap_or("").to_owned(),
        count: field_f64(value, "count").unwrap_or(f64::NAN),
    }
}

fn losses_arg(value: Option<&Value>) -> Vec<Loss> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().map(loss_of).collect())
        .unwrap_or_default()
}

fn loss_json(loss: &Loss) -> Value {
    json!({ "feature": loss.feature, "kind": loss.kind, "count": num(loss.count) })
}

/// A fake worker: each event of the script, in order, after `postMessage`.
struct SpecWorker<'a> {
    events: VecDeque<WorkerEvent>,
    post_throws: Option<String>,
    logs: &'a RefCell<Vec<Vec<Value>>>,
}

impl HwpWorker for SpecWorker<'_> {
    fn post_message(&mut self, job: &HwpExportJob) -> Result<(), String> {
        log_line(
            self.logs,
            vec![
                "postMessage".into(),
                json!({
                    "docx": hex(&job.docx),
                    "format": job.format.as_str(),
                    "wasmPath": job.wasm_path,
                }),
            ],
        );
        match &self.post_throws {
            Some(message) => Err(message.clone()),
            None => Ok(()),
        }
    }

    fn next_event(&mut self) -> Option<WorkerEvent> {
        self.events.pop_front()
    }

    fn terminate(&mut self) {
        log_line(self.logs, vec!["terminate".into()]);
    }
}

fn worker_event(value: &Value) -> Result<WorkerEvent, CallError> {
    if let Some(message) = field(value, "message") {
        return Ok(WorkerEvent::Message(
            if message.get("ok") == Some(&Value::Bool(true)) {
                HwpExportReply::Ok {
                    bytes: unhex(field_str(message, "bytesHex").unwrap_or(""))?,
                    losses: losses_arg(message.get("losses")),
                }
            } else {
                HwpExportReply::Failed {
                    code: field_str(message, "code").unwrap_or("").to_owned(),
                    error: field_str(message, "error").unwrap_or("").to_owned(),
                }
            },
        ));
    }
    if let Some(message) = field_str(value, "error") {
        return Ok(WorkerEvent::Error(message.to_owned()));
    }
    match field_f64(value, "exit") {
        Some(code) => Ok(WorkerEvent::Exit(code)),
        None => Err(bad("a worker event")),
    }
}

/// `[{ docx: hex, format, wasmPath }, { spawnThrows?, postThrows?, events }]`
fn convert_in_worker_call(args: &[Value], cx: &mut Context) -> Answer {
    let job = spec_arg(args, 0)?;
    let script = spec_arg(args, 1)?;
    let job = HwpExportJob {
        docx: unhex(field_str(job, "docx").unwrap_or(""))?,
        format: hwp_format_of(field_str(job, "format").unwrap_or("hwp")),
        wasm_path: field_str(job, "wasmPath").unwrap_or("").to_owned(),
    };
    let events = field_list(script, "events")
        .iter()
        .map(worker_event)
        .collect::<Result<VecDeque<_>, _>>()?;
    let logs = RefCell::new(Vec::new());
    let mut events = Some(events);
    let mut spawn = || {
        log_line(&logs, vec!["spawn".into()]);
        if let Some(message) = field_str(script, "spawnThrows") {
            return Err(message.to_owned());
        }
        Ok(SpecWorker {
            events: events.take().unwrap_or_default(),
            post_throws: field_str(script, "postThrows").map(str::to_owned),
            logs: &logs,
        })
    };
    let result = convert_in_worker(&job, &mut spawn);
    cx.logs.extend(logs.into_inner());
    result
        .map(|conversion| {
            Some(json!({
                "bytes": hex(&conversion.bytes),
                "losses": conversion.losses.iter().map(loss_json).collect::<Vec<_>>(),
            }))
        })
        .map_err(hwp_call_error)
}

/// `new HwpExportFailure(code, message)`: `[code, message]`
fn hwp_failure_call(args: &[Value]) -> Answer {
    let code = str_arg(args, 0)?;
    let message = str_arg(args, 1)?;
    Ok(Some(json!({
        "name": "HwpExportFailure",
        "code": code,
        "message": message,
        "isError": true,
    })))
}

/// The steps of `exportHwp` as the spec describes them; each call is a line.
struct SpecSteps<'a> {
    spec: &'a Value,
    logs: &'a RefCell<Vec<Vec<Value>>>,
    still_open: Vec<bool>,
    asked: usize,
}

impl SpecSteps<'_> {
    /// a step that is `{ throws }`, or a boolean
    fn flag(&self, key: &str, default: bool) -> Result<bool, HwpError> {
        match field(self.spec, key) {
            Some(Value::Bool(flag)) => Ok(*flag),
            Some(step) => match step.get("throws") {
                Some(spec) => Err(thrown(spec)),
                None => Ok(default),
            },
            None => Ok(default),
        }
    }

    fn guard(&self, key: &str) -> Result<(), HwpError> {
        match field(self.spec, key).and_then(|step| step.get("throws")) {
            Some(spec) => Err(thrown(spec)),
            None => Ok(()),
        }
    }
}

impl HwpExportSteps for SpecSteps<'_> {
    fn authorized(&mut self, path: &str) -> Result<bool, HwpError> {
        log_line(self.logs, vec!["authorized".into(), path.into()]);
        self.flag("authorized", true)
    }

    fn pick_path(&mut self) -> Result<Option<(String, HwpFormat)>, HwpError> {
        log_line(self.logs, vec!["pickPath".into()]);
        self.guard("pick")?;
        Ok(field(self.spec, "pick").map(|pick| {
            (
                field_str(pick, "path").unwrap_or("").to_owned(),
                hwp_format_of(field_str(pick, "format").unwrap_or("hwp")),
            )
        }))
    }

    fn materialize(&mut self, docx: &[u8]) -> Result<Vec<u8>, HwpError> {
        log_line(self.logs, vec!["materialize".into(), hex(docx).into()]);
        self.guard("materialize")?;
        let mut bytes = docx.to_vec();
        if let Some(text) = field(self.spec, "materialize").and_then(|s| field_str(s, "append")) {
            bytes.extend(unhex(text).unwrap_or_default());
        }
        Ok(bytes)
    }

    fn convert(&mut self, docx: &[u8], format: HwpFormat) -> Result<HwpConversion, HwpError> {
        log_line(
            self.logs,
            vec!["convert".into(), hex(docx).into(), format.as_str().into()],
        );
        self.guard("convert")?;
        let convert = field(self.spec, "convert");
        Ok(HwpConversion {
            bytes: convert
                .and_then(|c| field_str(c, "bytesHex"))
                .map(|text| unhex(text).unwrap_or_default())
                .unwrap_or_default(),
            losses: losses_arg(convert.and_then(|c| c.get("losses"))),
        })
    }

    fn confirm(&mut self, losses: &[Loss], password_dropped: bool) -> Result<bool, HwpError> {
        log_line(
            self.logs,
            vec![
                "confirm".into(),
                Value::Array(losses.iter().map(loss_json).collect()),
                password_dropped.into(),
            ],
        );
        self.flag("confirm", true)
    }

    fn still_open(&mut self) -> Result<bool, HwpError> {
        log_line(self.logs, vec!["stillOpen".into()]);
        let answer = self
            .still_open
            .get(self.asked)
            .or(self.still_open.last())
            .copied()
            .unwrap_or(true);
        self.asked += 1;
        Ok(answer)
    }

    fn write(&mut self, path: &str, bytes: &[u8]) -> Result<(), HwpError> {
        log_line(
            self.logs,
            vec!["write".into(), path.into(), hex(bytes).into()],
        );
        self.guard("write")
    }

    fn open(&mut self, path: &str) -> Result<(), HwpError> {
        log_line(self.logs, vec!["open".into(), path.into()]);
        self.guard("open")
    }
}

/// `[{ docx, outPath?, passwordSet, authorized?, pick?, materialize?,
/// convert?, confirm?, stillOpen?, write?, open? }]`
fn export_hwp_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = spec_arg(args, 0)?;
    let request = HwpExportRequest {
        docx: unhex(field_str(spec, "docx").unwrap_or(""))?,
        out_path: field_str(spec, "outPath").map(str::to_owned),
        password_set: field(spec, "passwordSet") == Some(&Value::Bool(true)),
    };
    let logs = RefCell::new(Vec::new());
    let mut steps = SpecSteps {
        spec,
        logs: &logs,
        still_open: field_list(spec, "stillOpen")
            .iter()
            .map(|flag| flag.as_bool().unwrap_or(true))
            .collect(),
        asked: 0,
    };
    let result = export_hwp(&mut steps, &request);
    cx.logs.extend(logs.into_inner());
    result
        .map(|outcome| {
            Some(match outcome {
                HwpExportOutcome::Ok { path } => json!({ "ok": true, "path": path }),
                HwpExportOutcome::Canceled => json!({ "ok": false, "canceled": true }),
                HwpExportOutcome::Failed {
                    code,
                    error,
                    path: Some(path),
                } => json!({ "ok": false, "path": path, "code": code, "error": error }),
                HwpExportOutcome::Failed {
                    code,
                    error,
                    path: None,
                } => json!({ "ok": false, "code": code, "error": error }),
            })
        })
        .map_err(hwp_call_error)
}

/// `[losses, passwordDropped, lang]`
fn loss_box_call(args: &[Value]) -> Answer {
    let losses = losses_arg(arg(args, 0));
    let password_dropped = bool_arg(args, 1)?;
    let lang: Lang = normalize_lang(Some(str_arg(args, 2)?));
    let options = hwp_loss_message_box(&losses, password_dropped, lang);
    Ok(Some(json!({
        "type": options.kind,
        "title": options.title,
        "message": options.message,
        "detail": options.detail,
        "buttons": options.buttons,
        "defaultId": options.default_id,
        "cancelId": options.cancel_id,
        "noLink": options.no_link,
    })))
}

/// `{ en: {...}, ko: {...} }`, each in the order of the table
fn strings_table() -> Value {
    let mut en = Map::new();
    let mut ko = Map::new();
    for (key, en_text, ko_text) in HWP_EXPORT_STRINGS {
        en.insert((*key).into(), (*en_text).into());
        ko.insert((*key).into(), (*ko_text).into());
    }
    json!({ "en": Value::Object(en), "ko": Value::Object(ko) })
}

// ---- lazy-media-inline ----

/// `[html, { <url>: { hex, mime } | null | { throws } }]`: a URL the table
/// does not name is `null`.
fn inline_media_call(args: &[Value], cx: &mut Context) -> Answer {
    let html = str_arg(args, 0)?;
    let reads = arg(args, 1).ok_or_else(|| bad("reads"))?;
    let logs = RefCell::new(Vec::new());
    let mut read = |url: &str| -> Result<Option<LazyMedia>, String> {
        log_line(&logs, vec!["read".into(), url.into()]);
        let Some(entry) = field(reads, url) else {
            return Ok(None);
        };
        if let Some(message) = field_str(entry, "throws") {
            return Err(message.to_owned());
        }
        Ok(Some(LazyMedia {
            body: unhex(field_str(entry, "hex").unwrap_or("")).map_err(|e| e.message)?,
            mime: field_str(entry, "mime").unwrap_or("").to_owned(),
        }))
    };
    let result = inline_lazy_media_in_html(html, &mut read);
    cx.logs.extend(logs.into_inner());
    result
        .map(|html| Some(Value::from(html)))
        .map_err(CallError::plain)
}

// ---- save-as-formats ----

fn filters_json(filters: &[SaveAsFilter]) -> Value {
    Value::Array(
        filters
            .iter()
            .map(|filter| json!({ "name": filter.name, "extensions": filter.extensions }))
            .collect(),
    )
}

/// the label function: `L:<key>`, each call a line
fn label(cx: &mut Context) -> impl FnMut(&str) -> String + '_ {
    |key: &str| {
        cx.logs.push(vec!["label".into(), key.into()]);
        format!("L:{key}")
    }
}

fn docs_filters_call(args: &[Value], cx: &mut Context) -> Answer {
    let current = format_arg(args, 0)?;
    let offer = bool_arg(args, 1)?;
    let filters = save_as_filters(current, offer, &mut label(cx));
    Ok(Some(filters_json(&filters)))
}

fn hwp_filters_call(args: &[Value], cx: &mut Context) -> Answer {
    let first = hwp_format_arg(args, 0)?;
    let filters = hwp_export_filters(first, &mut label(cx));
    Ok(Some(filters_json(&filters)))
}

fn mindmap_filters_call(args: &[Value], cx: &mut Context) -> Answer {
    let offer = bool_arg(args, 0)?;
    let filters = mindmap_save_as::save_as_filters(offer, &mut label(cx));
    Ok(Some(filters_json(&filters)))
}

// ---- starred-files ----

fn item_json(item: &StarredItem) -> Value {
    let mut out = Map::new();
    out.insert("path".into(), item.path.clone().into());
    if let Some(group) = &item.group {
        out.insert("group".into(), group.clone().into());
    }
    Value::Object(out)
}

fn items_json(items: &[StarredItem]) -> Value {
    Value::Array(items.iter().map(item_json).collect())
}

fn items_arg(args: &[Value], i: usize) -> Result<Vec<StarredItem>, CallError> {
    arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("items"))?
        .iter()
        .map(|item| {
            Ok(StarredItem {
                path: field_str(item, "path")
                    .ok_or_else(|| bad("a path"))?
                    .to_owned(),
                group: item.get("group").and_then(Value::as_str).map(str::to_owned),
            })
        })
        .collect()
}

// ---- stream-coalesce ----

/// `[windowMs | null, [{ op: 'push', chunk } | { op: 'flush' } | { op: 'advance', ms }]]`:
/// each chunk sent is the line `send` with the chunk; each op answers whether
/// a timer is set.
fn coalescer_call(args: &[Value], cx: &mut Context) -> Answer {
    let window = js(args, 0).and_then(|value| match value {
        JsonValue::Number(x) => Some(x),
        _ => None,
    });
    let ops = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let sent: RefCell<Vec<Value>> = RefCell::new(Vec::new());
    let mut coalescer = create_chunk_coalescer(
        |chunk| {
            sent.borrow_mut()
                .push(json_value_to_serde(&JsonValue::Object(chunk)));
        },
        window,
    );
    let mut now = 0.0;
    let mut out: Vec<Value> = Vec::new();
    for op in ops {
        let name = field_str(op, "op").ok_or_else(|| bad("an op"))?;
        match name {
            "push" => match op.get("chunk").map(revive) {
                Some(JsonValue::Object(chunk)) => coalescer.push(chunk, now),
                _ => return Err(bad("a chunk")),
            },
            "flush" => coalescer.flush(),
            "advance" => {
                now += field_f64(op, "ms").unwrap_or(0.0);
                if coalescer.due_ms().is_some_and(|due| due <= now) {
                    coalescer.fire();
                }
            }
            _ => return Err(bad("an op")),
        }
        out.push(json!({ "op": name, "timer": coalescer.due_ms().is_some() }));
    }
    // the scenario ends with every timer left firing (`clock.fireAll()`)
    if coalescer.due_ms().is_some() {
        coalescer.fire();
    }
    drop(coalescer);
    for chunk in sent.into_inner() {
        cx.logs.push(vec!["send".into(), chunk]);
    }
    Ok(Some(Value::Array(out)))
}

// ---- zotero-wire ----

/// `[[hex, ...]]`: each push answers `{ frames }` or `{ error }`.
fn decoder_call(args: &[Value]) -> Answer {
    let pushes = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("pushes"))?;
    let mut decoder = ZoteroFrameDecoder::new();
    let mut out = Vec::new();
    for push in pushes {
        let chunk = unhex(push.as_str().ok_or_else(|| bad("hex"))?)?;
        out.push(match decoder.push(&chunk) {
            Ok(frames) => json!({
                "frames": frames
                    .iter()
                    .map(|frame| json!({
                        "transactionId": frame.transaction_id,
                        "payload": frame.payload,
                    }))
                    .collect::<Vec<_>>(),
            }),
            Err(message) => json!({ "error": message }),
        });
    }
    Ok(Some(Value::Array(out)))
}

/// The sockets of the scenario: each call is a line; `destroy` queues the
/// `error` and `close` events the socket raises afterwards.
struct SpecNet<'a> {
    logs: &'a RefCell<Vec<Vec<Value>>>,
    destroyed: HashSet<u32>,
    raised: VecDeque<(u32, Option<String>, bool)>,
}

impl ZoteroNet for SpecNet<'_> {
    fn write(&mut self, socket: u32, frame: &[u8]) {
        log_line(
            self.logs,
            vec!["write".into(), socket.into(), hex(frame).into()],
        );
    }

    fn end(&mut self, socket: u32) {
        log_line(self.logs, vec!["end".into(), socket.into()]);
    }

    fn destroy(&mut self, socket: u32, error: Option<&str>) {
        if !self.destroyed.insert(socket) {
            return;
        }
        log_line(
            self.logs,
            vec![
                "destroy".into(),
                socket.into(),
                error.map_or(Value::Null, Value::from),
            ],
        );
        self.raised
            .push_back((socket, error.map(str::to_owned), true));
    }

    fn destroyed(&self, socket: u32) -> bool {
        self.destroyed.contains(&socket)
    }
}

/// `{ host?, port?, handlers?: { <command>: { value } | { throws } }, ops }`
/// with the ops `run { command, connect: 'ok' | { error } }`, `data { hex,
/// socket? }`, `error { message, socket? }`, `close { socket? }` (the other
/// side closes), `clientClose`, `active`. After each op the frames waiting on
/// their handlers are answered, and what a destroyed socket raises is raised.
fn zotero_client_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = spec_arg(args, 0)?;
    let handlers = spec.get("handlers");
    let logs = RefCell::new(Vec::new());
    let mut net = SpecNet {
        logs: &logs,
        destroyed: HashSet::new(),
        raised: VecDeque::new(),
    };
    let mut client = ZoteroWireClient::new(field_str(spec, "host"), field_f64(spec, "port"));
    let mut handle = |request: &ZoteroWireRequest| -> Handled {
        log_line(
            &logs,
            vec![
                "handle".into(),
                request.command.clone().into(),
                json_value_to_serde(&JsonValue::Array(request.args.clone())),
            ],
        );
        match handlers.and_then(|table| field(table, &request.command)) {
            Some(entry) => match field_str(entry, "throws") {
                Some(message) => Err(message.to_owned()),
                None => Ok(entry.get("value").map_or(JsonValue::Null, revive)),
            },
            None => Ok(JsonValue::String(format!("ok:{}", request.command))),
        }
    };
    let mut sockets = 0u32;
    let mut runs = 0u32;
    // socket id -> the run it belongs to
    let mut run_of: HashMap<u32, u32> = HashMap::new();
    let settle = |run: u32, result: Result<(), String>| {
        log_line(
            &logs,
            vec![
                "settled".into(),
                run.into(),
                match result {
                    Ok(()) => "ok".into(),
                    Err(message) => Value::from(message),
                },
            ],
        );
    };
    for op in field_list(spec, "ops") {
        let target = |op: &Value| field_f64(op, "socket").map_or(sockets, |id| id as u32);
        match field_str(op, "op") {
            Some("run") => {
                runs += 1;
                let command = field_str(op, "command").unwrap_or("");
                match client.begin_run() {
                    Err(message) => settle(runs, Err(message)),
                    Ok(()) => {
                        log_line(
                            &logs,
                            vec![
                                "connect".into(),
                                client.host.clone().into(),
                                num(client.port),
                            ],
                        );
                        sockets += 1;
                        match field(op, "connect").and_then(|c| field_str(c, "error")) {
                            Some(message) => {
                                client.connect_failed();
                                settle(runs, Err(message.to_owned()));
                            }
                            None => {
                                run_of.insert(sockets, runs);
                                client.connected(sockets, command, &mut net);
                            }
                        }
                    }
                }
            }
            Some("data") => {
                let chunk = unhex(field_str(op, "hex").unwrap_or(""))?;
                client.on_data(target(op), &chunk, &mut handle, &mut net);
            }
            Some("error") => {
                client.on_error(target(op), field_str(op, "message").unwrap_or(""));
            }
            Some("close") => {
                let socket = target(op);
                if let Some(result) = client.on_close(socket) {
                    settle(run_of.get(&socket).copied().unwrap_or(0), result);
                }
            }
            Some("clientClose") => client.close(&mut net),
            Some("active") => {
                log_line(&logs, vec!["active".into(), client.is_active().into()]);
            }
            _ => return Err(bad("an op")),
        }
        // the microtasks, then what a destroyed socket raises
        client.drain(&mut net);
        while let Some((socket, error, close)) = net.raised.pop_front() {
            if let Some(message) = &error {
                client.on_error(socket, message);
            }
            if close && let Some(result) = client.on_close(socket) {
                settle(run_of.get(&socket).copied().unwrap_or(0), result);
            }
            client.drain(&mut net);
        }
    }
    let active = client.is_active();
    cx.logs.extend(logs.into_inner());
    Ok(Some(json!({ "active": active })))
}

// ---- diagram ----

fn target_json(target: &DrawioTarget) -> Value {
    match target {
        DrawioTarget::File { path, relative } => {
            json!({ "kind": "file", "path": path, "relative": relative })
        }
        DrawioTarget::Bridge => json!({ "kind": "bridge" }),
        DrawioTarget::Print { token } => json!({ "kind": "print", "token": token }),
        DrawioTarget::Refused { status } => json!({ "kind": "refused", "status": status }),
    }
}

fn log_json(log: &RequestLog) -> Value {
    json!({
        "allowed": log.allowed,
        "refused": log.refused,
        "blocked": log.blocked,
        "schemes": log.schemes,
    })
}

/// `[urls, devOrigins]`: every url is screened in one log; answers the
/// verdicts and the log.
fn screen_call(args: &[Value]) -> Answer {
    let urls = strings_arg(args, 0)?;
    let origins = strings_arg(args, 1)?;
    let mut log = network_guard::new_request_log();
    let verdicts: Vec<Value> = urls
        .iter()
        .map(|url| Value::Bool(screen_request(&mut log, url, &origins)))
        .collect();
    Ok(Some(json!({ "verdicts": verdicts, "log": log_json(&log) })))
}

fn pages_arg(args: &[Value], i: usize) -> Result<Vec<PrintPage>, CallError> {
    arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("pages"))?
        .iter()
        .map(|page| {
            Ok(PrintPage {
                svg: field_str(page, "svg").unwrap_or("").to_owned(),
                width: field_f64(page, "width").unwrap_or(f64::NAN),
                height: field_f64(page, "height").unwrap_or(f64::NAN),
                page_width: field_f64(page, "pageWidth").unwrap_or(f64::NAN),
                page_height: field_f64(page, "pageHeight").unwrap_or(f64::NAN),
            })
        })
        .collect()
}

/// `{ tokens?, ops: [{ op: 'hold', html } | { op: 'take', ref | token } |
/// { op: 'drop', ref | token }] }`. `randomBytes(16).toString('hex')` answers
/// `tokens[n]`, else the byte `n + 1` sixteen times.
fn print_documents_call(args: &[Value]) -> Answer {
    let spec = spec_arg(args, 0)?;
    let tokens = field_list(spec, "tokens");
    let mut documents = PrintDocuments::new();
    let mut held: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for op in field_list(spec, "ops") {
        let named = |op: &Value| match field_str(op, "token") {
            Some(token) => token.to_owned(),
            None => field_f64(op, "ref")
                .and_then(index)
                .and_then(|at| held.get(at))
                .cloned()
                .unwrap_or_default(),
        };
        match field_str(op, "op") {
            Some("hold") => {
                let n = held.len();
                let token = tokens.get(n).and_then(Value::as_str).map_or_else(
                    || format!("{:02x}", (n + 1) as u8).repeat(16),
                    str::to_owned,
                );
                let token =
                    documents.hold_print_document(field_str(op, "html").unwrap_or(""), token);
                held.push(token.clone());
                out.push(json!({ "op": "hold", "token": token }));
            }
            Some("take") => {
                let html = documents.take_print_document(&named(op));
                out.push(json!({ "op": "take", "html": html }));
            }
            Some("drop") => {
                documents.drop_print_document(&named(op));
                out.push(json!({ "op": "drop" }));
            }
            _ => return Err(bad("an op")),
        }
    }
    Ok(Some(Value::Array(out)))
}
