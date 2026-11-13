//! Certificate (digital) signatures and the saved hand-drawn signatures.

use std::rc::Rc;

use jscompat::node_path::host::{dirname, join};
use jscompat::{JsonValue, buffer_from_base64, random_uuid};
use main_core::pdf::atomic_write::write_pdf_atomically;
use main_core::pdf::signature_store::{
    SavedSignature, add_signature, is_signature_data, load_signatures, remove_signature,
    save_signatures,
};
use main_core::pdf::system_certificates::{
    CertSummary, CertificateReader, SystemCertificateRef, SystemIdentity, SystemStoreEnv, Thrown,
    list_system_certificates, open_system_signer, run_command,
};
use shell_contract::hosts::{FileDialog, FileFilter};
use shell_contract::runtime::PathName;
use shell_contract::{IpcValue, ViewId};

use super::dialogs::{Dlg, tm};
use super::editors::stem;
use super::hosts::{CertMaterial, PdfEngineHost, SignFailure, SignOptions, VisibleSignature};
use super::save::is_same_redaction_copy_path;
use super::{CertEntry, Editor, now_ms, read_file};
use crate::kit::{self, Entry, IntoIpc, as_num, as_str, error, field, obj};

/// `MAX_CERTIFICATE_FILE_BYTES`
const MAX_CERTIFICATE_FILE_BYTES: u64 = 4 * 1024 * 1024;
const SIGNATURE_POSITIONS: [&str; 5] = [
    "bottom-right",
    "bottom-left",
    "top-right",
    "top-left",
    "center",
];

/// `describeCertificate` through the engine, for the system store
struct Reader(PdfEngineHost);

impl CertificateReader for Reader {
    fn read(&self, input: &[u8]) -> Option<CertSummary> {
        self.0.describe_certificate(input)
    }
}

/// The system store env a worker builds around `run`
fn with_env<R>(
    engine: PdfEngineHost,
    platform: main_core::pdf::font_locate::Platform,
    home: String,
    f: impl FnOnce(&SystemStoreEnv<'_>) -> R,
) -> R {
    let reader = Reader(engine);
    let env = SystemStoreEnv {
        platform,
        home: &home,
        run: &run_command,
        now: &now_ms,
        certificates: &reader,
    };
    f(&env)
}

/// `err instanceof SystemStoreError ? err.code : fallback`
fn store_code(err: &Thrown, fallback: &str) -> String {
    match err {
        Thrown::Store(e) => e.code.clone(),
        _ => fallback.to_owned(),
    }
}

/// `readCertificateFile(path)`
fn read_certificate_file(path: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(main_core::node_fs::namespaced(path))
        .map_err(|e| main_core::node_fs::node_error(&e, "stat", path).message)?;
    if meta.len() > MAX_CERTIFICATE_FILE_BYTES {
        return Err("certificate file too large".into());
    }
    read_file(path)
}

/// `text(value)` of `parseSignOptions`: trimmed, at most 500 UTF-16 units
fn sign_text(v: &IpcValue) -> Option<String> {
    let t = jscompat::trim(as_str(v)?);
    if t.is_empty() {
        return None;
    }
    let mut out = String::new();
    let mut units = 0;
    for c in t.chars() {
        units += c.len_utf16();
        if units > 500 {
            break;
        }
        out.push(c);
    }
    Some(out)
}

/// `parseSignOptions(request)`: `None` refuses the request
pub(super) fn parse_sign_options(request: &IpcValue) -> Option<SignOptions> {
    let certify_level = match field(request, "certifyLevel") {
        IpcValue::Undefined => None,
        IpcValue::Number(n) if [1.0, 2.0, 3.0].contains(n) => Some(*n as u8),
        _ => return None,
    };
    let mut out = SignOptions {
        reason: sign_text(field(request, "reason")),
        location: sign_text(field(request, "location")),
        contact_info: sign_text(field(request, "contactInfo")),
        certify_level,
        visible: None,
    };
    let v = field(request, "visible");
    if v != &IpcValue::Undefined {
        let num = |k| as_num(field(v, k)).filter(|n| n.is_finite());
        let page_index = num("pageIndex").filter(|n| n.fract() == 0.0 && *n >= 0.0)?;
        let position = as_str(field(v, "position")).filter(|p| SIGNATURE_POSITIONS.contains(p))?;
        let width = num("width").filter(|w| (40.0..=800.0).contains(w))?;
        let height = num("height").filter(|h| (20.0..=800.0).contains(h))?;
        let png =
            as_str(field(v, "png")).filter(|p| p.encode_utf16().count() <= 8 * 1024 * 1024)?;
        out.visible = Some(VisibleSignature {
            page_index,
            position: position.to_owned(),
            width,
            height,
            png: buffer_from_base64(png),
        });
    }
    Some(out)
}

fn signatures_ipc(list: &[SavedSignature]) -> IpcValue {
    IpcValue::Array(
        list.iter()
            .map(|s| {
                obj([
                    ("id", s.id.as_str().into_ipc()),
                    ("createdAt", s.created_at.into_ipc()),
                    ("data", kit::from_js_json(&s.data)),
                ])
            })
            .collect(),
    )
}

impl Editor {
    fn cert_entry(&self, view: ViewId, id: &IpcValue) -> Option<(String, CertEntry)> {
        let id = as_str(id)?;
        let entry = self.st.borrow().views.get(&view)?.certs.get(id).cloned()?;
        Some((id.to_owned(), entry))
    }

    /// `rememberCert(wcId, entry)`: the opaque id the renderer gets
    fn remember_cert(&self, view: ViewId, entry: CertEntry) -> String {
        let id = random_uuid();
        self.with_view(view, |v| v.certs.insert(id.clone(), entry));
        id
    }

    /// `releaseCertEntry(entry)`: a system identity's exported key goes
    fn release_cert(&self, view: ViewId, id: &str) {
        self.with_view(view, |v| {
            if let Some(CertEntry::System { identity, .. }) = v.certs.get_mut(id) {
                *identity = None;
            }
        });
    }

    fn signatures_path(&self) -> String {
        super::user_data_file(self, "pdf-signatures.json")
    }

    /// `certMaterial(entry, password, storePassword)` then
    /// `openMaterial(material)`, both on a worker; `then` gets the material
    /// with the chain's `CertificateInfo[]` (or the `CertificateErrorCode`)
    /// on the core thread. A system identity is kept on the entry.
    fn cert_material(
        self: &Rc<Self>,
        view: ViewId,
        id: String,
        entry: CertEntry,
        password: String,
        store_password: Option<String>,
        then: impl FnOnce(Result<(CertMaterial, Opened), Thrown>) + 'static,
    ) {
        let engine = self.engine.clone();
        let platform = self.shell.platform();
        let home = self.path(PathName::Home);
        let ed = self.clone();
        kit::on_worker(
            &self.services,
            move || -> Result<(CertMaterial, Option<SystemIdentity>, Opened), Thrown> {
                let (material, identity) = match entry {
                    CertEntry::File(path) => {
                        let p12 = read_certificate_file(&path).map_err(|m| {
                            Thrown::Node(main_core::node_fs::NodeError {
                                code: None,
                                message: m,
                            })
                        })?;
                        (CertMaterial::P12 { p12, password }, None)
                    }
                    CertEntry::System {
                        reference,
                        identity,
                    } => {
                        let identity = match identity {
                            Some(i) => i,
                            None => with_env(engine.clone(), platform, home, |env| {
                                open_system_signer(&reference, store_password.as_deref(), env)
                            })?,
                        };
                        let material = match &identity {
                            SystemIdentity::P12(e) => CertMaterial::P12 {
                                p12: e.p12.clone(),
                                password: e.password.clone(),
                            },
                            SystemIdentity::InPlace(s) => CertMaterial::InPlace(s.clone()),
                        };
                        (material, Some(identity))
                    }
                };
                let opened = engine.open_certificate(&material);
                Ok((material, identity, opened))
            },
            move |result| {
                then(result.map(|(material, identity, opened)| {
                    if let Some(identity) = identity {
                        ed.with_view(view, |v| {
                            if let Some(CertEntry::System { identity: slot, .. }) =
                                v.certs.get_mut(&id)
                            {
                                *slot = Some(identity);
                            }
                        });
                    }
                    (material, opened)
                }))
            },
        );
    }
}

/// `openMaterial(material)`: the chain's `CertificateInfo[]`, or the `CertificateErrorCode`
type Opened = Result<Vec<IpcValue>, String>;

fn sign_failed(message: impl Into<String>) -> IpcValue {
    obj([
        ("ok", false.into_ipc()),
        ("error", "sign-failed".into_ipc()),
        ("message", message.into().into_ipc()),
    ])
}

fn sign_error(code: impl Into<String>) -> IpcValue {
    obj([("ok", false.into_ipc()), ("error", code.into().into_ipc())])
}

fn store_password(v: &IpcValue) -> Option<String> {
    as_str(v).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn sign(e: &Rc<Editor>, view: ViewId, request: IpcValue, reply: shell_contract::ipc::Responder) {
    let Some(path) = e.granted(view, field(&request, "path")) else {
        return reply.reply(Ok(sign_failed(super::NOT_GRANTED)));
    };
    let entry = e.cert_entry(view, field(&request, "certId"));
    let (Some((id, entry)), Some(password)) = (
        entry,
        as_str(field(&request, "password")).map(str::to_owned),
    ) else {
        return reply.reply(Ok(sign_error("cert-invalid")));
    };
    let Some(options) = parse_sign_options(&request) else {
        return reply.reply(Ok(sign_failed("pdf: invalid sign request")));
    };
    let busy =
        e.st.borrow()
            .views
            .get(&view)
            .is_some_and(|v| v.redaction_flow);
    if busy || e.save_as_waiting(view) {
        return reply.reply(Ok(sign_failed("pdf: another save is in progress")));
    }
    // the signature covers the file on disk; edits still in the renderer would be left out
    if e.st.borrow().views.get(&view).is_some_and(|v| v.dirty) {
        return reply.reply(Ok(sign_failed("pdf: save pending edits before signing")));
    }
    e.with_view(view, |v| v.redaction_flow = true);
    e.set_save_as_in_flight(view, true);
    let me = Rc::downgrade(e);
    let finish_id = id.clone();
    let finish = move |answer: IpcValue| {
        if let Some(ed) = me.upgrade() {
            ed.release_cert(view, &finish_id);
            ed.with_view(view, |v| v.redaction_flow = false);
            ed.set_save_as_in_flight(view, false);
        }
        reply.reply(Ok(answer))
    };
    let ed = e.clone();
    e.cert_material(
        view,
        id,
        entry,
        password,
        store_password(field(&request, "storePassword")),
        move |material| {
            let (material, opened) = match material {
                Ok(m) => m,
                Err(Thrown::Store(err)) => return finish(sign_error(err.code)),
                Err(err) => return finish(sign_failed(thrown_message(&err))),
            };
            // fail on a wrong password before asking where to save
            if let Err(code) = opened {
                return finish(sign_error(code));
            }
            let picked = ed.dialogs.save(
                ed.contents.window_of(view),
                &FileDialog {
                    title: Some(tm(&ed.lang(), Dlg::SignedCopy).into()),
                    default_path: Some(
                        join(&[&dirname(&path), &format!("{}-signed.pdf", stem(&path))]).into(),
                    ),
                    filters: vec![FileFilter {
                        name: tm(&ed.lang(), Dlg::FilterPdf).into(),
                        extensions: vec!["pdf".into()],
                    }],
                    ..Default::default()
                },
            );
            let cancelled = || obj([("ok", false.into_ipc()), ("cancelled", true.into_ipc())]);
            let Some(target) = picked
                .map(|p| p.to_string_lossy().into_owned())
                .filter(|p| !p.is_empty())
            else {
                return finish(cancelled());
            };
            // never overwrite the source
            if is_same_redaction_copy_path(&path, &target) {
                return finish(cancelled());
            }
            let engine = ed.engine.clone();
            let ed2 = ed.clone();
            let written = target.clone();
            let source = path.clone();
            kit::on_worker(
                &ed.services,
                move || -> Result<(), SignFailure> {
                    let bytes = read_file(&path).map_err(SignFailure::Message)?;
                    let signed = engine.sign_pdf(&bytes, &material, &options)?;
                    write_pdf_atomically(&written, &signed)
                        .map_err(|e| SignFailure::Message(e.message))?;
                    Ok(())
                },
                move |result| match result {
                    Ok(()) => {
                        let ed = ed2;
                        ed.grant_only(view, &target);
                        ed.with_view(view, |v| v.open_path = Some(target.clone()));
                        // the signed file starts clean: no copy of the unsigned document follows
                        ed.st.borrow_mut().unsaved_untitled_copy.remove(&source);
                        ed.rec
                            .borrow_mut()
                            .moved_to_new_file(view, &source, &target);
                        if let Err(err) = ed.shell.redaction_saved(view, &target) {
                            eprintln!("[pdf] signed-copy hook failed: {err}");
                        }
                        finish(obj([("ok", true.into_ipc()), ("path", target.into_ipc())]))
                    }
                    Err(SignFailure::Code(code)) => finish(sign_error(code)),
                    Err(SignFailure::Message(m)) => finish(sign_failed(m)),
                },
            );
        },
    );
}

fn thrown_message(err: &Thrown) -> String {
    match err {
        Thrown::Store(e) => e.code.clone(),
        Thrown::Node(e) => e.message.clone(),
        Thrown::JsonSyntax(m) => m.clone(),
        Thrown::RegexLimit => "Maximum call stack size exceeded".into(),
    }
}

pub(super) fn entries(ed: &Rc<Editor>) -> Vec<Entry> {
    let mut all = Vec::new();

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:list-digital-signatures",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return reply.reply(Ok(IpcValue::Array(Vec::new())));
            };
            let bytes = e.document_bytes(view, &path);
            let engine = e.engine.clone();
            kit::on_worker(
                &e.services,
                move || engine.read_pdf_signatures(&bytes()?),
                move |r| reply.reply(Ok(r.unwrap_or(IpcValue::Array(Vec::new())))),
            );
        },
    ));

    // the renderer only ever sees an opaque id; the path stays here
    let e = ed.clone();
    all.push(kit::invoke("pdf:pick-certificate", move |cx, _| {
        let view = cx.sender.view;
        let lang = e.lang();
        let picked = e.dialogs.open(
            e.contents.window_of(view),
            &FileDialog {
                title: Some(tm(&lang, Dlg::PickCertificate).into()),
                properties: vec!["openFile".into()],
                filters: vec![FileFilter {
                    name: tm(&lang, Dlg::FilterCertificate).into(),
                    extensions: vec!["p12".into(), "pfx".into()],
                }],
                ..Default::default()
            },
        );
        let Some(file) = picked.and_then(|p| p.into_iter().next()) else {
            return Ok(IpcValue::Null);
        };
        let file = file.to_string_lossy().into_owned();
        let name = jscompat::node_path::host::basename(&file, None);
        let cert_id = e.remember_cert(view, CertEntry::File(file));
        Ok(obj([
            ("certId", cert_id.into_ipc()),
            ("fileName", name.into_ipc()),
        ]))
    }));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:list-system-certificates",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let password = store_password(args.get(0));
            let engine = e.engine.clone();
            let platform = e.shell.platform();
            let home = e.path(PathName::Home);
            let ed = e.clone();
            kit::on_worker(
                &e.services,
                move || {
                    with_env(engine, platform, home, |env| {
                        list_system_certificates(password.as_deref(), env)
                    })
                },
                move |listing| {
                    let listing = match listing {
                        Ok(l) => l,
                        Err(err) => return reply.reply(Err(error(thrown_message(&err)))),
                    };
                    // a fresh listing replaces the previous one
                    ed.with_view(view, |v| {
                        v.certs
                            .retain(|_, c| !matches!(c, CertEntry::System { .. }))
                    });
                    let certs = listing
                        .certs
                        .into_iter()
                        .map(|c| {
                            let reference: SystemCertificateRef = c.reference;
                            let id = ed.remember_cert(
                                view,
                                CertEntry::System {
                                    reference,
                                    identity: None,
                                },
                            );
                            obj([
                                ("certId", id.into_ipc()),
                                ("label", c.label.into_ipc()),
                                ("commonName", c.common_name.into_ipc()),
                                ("issuerCommonName", c.issuer_common_name.into_ipc()),
                                ("validTo", c.valid_to.into_ipc()),
                                ("expired", c.expired.into_ipc()),
                            ])
                        })
                        .collect();
                    reply.reply(Ok(obj([
                        (
                            "issues",
                            listing
                                .issues
                                .iter()
                                .map(|i| i.as_str())
                                .collect::<Vec<_>>()
                                .into_ipc(),
                        ),
                        ("certs", IpcValue::Array(certs)),
                    ])))
                },
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::send("pdf:release-certificate", move |cx, args| {
        if let Some(id) = args.str(0) {
            e.release_cert(cx.sender.view, id);
        }
        Ok(())
    }));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:inspect-certificate",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let entry = e.cert_entry(view, args.get(0));
            let (Some((id, entry)), Some(password)) = (entry, args.str(1).map(str::to_owned))
            else {
                return reply.reply(Ok(sign_error("cert-invalid")));
            };
            e.cert_material(
                view,
                id,
                entry,
                password,
                store_password(args.get(2)),
                move |material| {
                    let answer = match material {
                        Err(err) => sign_error(store_code(&err, "cert-invalid")),
                        Ok((_, opened)) => match opened {
                            Ok(info) => obj([
                                ("ok", true.into_ipc()),
                                (
                                    "signer",
                                    info.first().cloned().unwrap_or(IpcValue::Undefined),
                                ),
                                ("chain", IpcValue::Array(info)),
                            ]),
                            Err(code) => sign_error(code),
                        },
                    };
                    reply.reply(Ok(answer))
                },
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:sign-with-certificate",
        move |cx, mut args, reply| sign(&e, cx.sender.view, args.take(0), reply),
    ));

    let e = ed.clone();
    all.push(kit::invoke("pdf:list-signatures", move |_, _| {
        Ok(signatures_ipc(&load_signatures(&e.signatures_path())))
    }));

    let e = ed.clone();
    all.push(kit::invoke("pdf:add-signature", move |_, args| {
        let path = e.signatures_path();
        let list = load_signatures(&path);
        let data = kit::to_js_json(args.get(0)).unwrap_or(JsonValue::Null);
        if !is_signature_data(&data) {
            return Ok(signatures_ipc(&list));
        }
        let next = add_signature(&list, &data, now_ms());
        save_signatures(&path, &next, std::process::id()).map_err(|e| error(e.message))?;
        Ok(signatures_ipc(&next))
    }));

    let e = ed.clone();
    all.push(kit::invoke("pdf:remove-signature", move |_, args| {
        let path = e.signatures_path();
        let list = load_signatures(&path);
        let Some(id) = args.str(0) else {
            return Ok(signatures_ipc(&list));
        };
        let next = remove_signature(&list, id);
        if next.len() != list.len() {
            save_signatures(&path, &next, std::process::id()).map_err(|e| error(e.message))?;
        }
        Ok(signatures_ipc(&next))
    }));

    all
}
