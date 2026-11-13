//! The recovery channels of `apps/hwp/src/main/recovery.ts`
//! (`registerHwpRecoveryIpc`) over its port in `main-core`
//! (`main_core::hwp::recovery`), and the Electron side that port calls
//! ([`Electron`]).

use std::rc::Rc;
use std::time::Duration;

use main_core::hwp::ipc::HwpFormat;
use main_core::hwp::recovery::{
    HwpRecoveryElectron, MAX_HWP_SAVE_BYTES, RecoveryBeginResult, RecoveryTimer,
};
use main_core::hwp::save_fixes::apply_save_fixes;
use main_core::hwp::save_plan::bytes_match_format;
use main_core::hwp::tab_widths::new_tabs_of;
use shell_contract::IpcValue;
use shell_contract::runtime::PathName;

use super::editor::{Hwp, tab_spots, uint8, view_of, wc};
use super::{Boxes, Parent};
use crate::kit::{self, Entry, IntoIpc, as_num, as_str, obj, on_worker, to_json};

/// recovery.ts's Electron: the views, the app's paths, the dialog and the
/// timers, as the Hangul editor's state reaches them
pub(crate) struct Electron<'a>(pub &'a Rc<Hwp>);

impl HwpRecoveryElectron for Electron<'_> {
    type Window = Parent;
    type Dialog = Boxes;

    fn is_destroyed(&self, wc_id: i64) -> bool {
        self.0.is_destroyed(view_of(wc_id))
    }

    fn send_recovery_reset(&self, wc_id: i64) {
        self.0.emit(view_of(wc_id), "hwp:recovery-reset", vec![])
    }

    fn send_recovery_flush(&self, wc_id: i64, token: u64) -> Result<(), String> {
        let view = view_of(wc_id);
        // `contents.send` on a destroyed view throws
        if self.0.is_destroyed(view) {
            return Err("Object has been destroyed".into());
        }
        self.0
            .emit(view, "hwp:recovery-flush", vec![(token as f64).into_ipc()]);
        Ok(())
    }

    fn reload(&self, wc_id: i64) {
        self.0.shell.reload(view_of(wc_id))
    }

    fn is_headless_mode(&self) -> bool {
        self.0.shell.is_headless_mode()
    }

    fn ui_lang(&self) -> String {
        self.0.shell.ui_lang()
    }

    fn user_data_dir(&self) -> String {
        self.0
            .services
            .paths
            .path(PathName::UserData)
            .to_string_lossy()
            .into_owned()
    }

    fn now_ms(&self) -> f64 {
        self.0.shell.now_ms()
    }

    fn random_uuid(&self) -> String {
        self.0.shell.random_uuid()
    }

    fn dialog(&self) -> &Boxes {
        &self.0.boxes
    }

    fn parent_of(&self, wc_id: i64) -> Option<Parent> {
        let contents = self
            .0
            .services
            .hosts
            .get::<shell_contract::ContentsHost>()
            .and_then(|c| c.window_of(view_of(wc_id)));
        contents
            .or_else(|| self.0.shell.focused_window())
            .map(Parent)
    }

    fn set_timeout(&self, timer: RecoveryTimer, ms: f64) {
        let weak = Rc::downgrade(self.0);
        let id = kit::after(
            &self.0.services,
            Duration::from_millis(ms.max(0.0) as u64),
            move || {
                let Some(hwp) = weak.upgrade() else { return };
                hwp.recovery_timers.borrow_mut().remove(&timer);
                match timer {
                    RecoveryTimer::DontSave(wc_id) => {
                        hwp.with_recovery(|r, e, _| r.dont_save_hold_ended(e, wc_id))
                    }
                    RecoveryTimer::Flush(token) => {
                        hwp.recovery.borrow_mut().flush_timed_out(token);
                    }
                }
            },
        );
        if let Some(old) = self.0.recovery_timers.borrow_mut().insert(timer, id) {
            kit::clear(old)
        }
    }

    fn clear_timeout(&self, timer: RecoveryTimer) {
        if let Some(id) = self.0.recovery_timers.borrow_mut().remove(&timer) {
            kit::clear(id)
        }
    }

    /// `console.warn`: the shell's log
    fn warn(&self, message: &str) {
        eprintln!("{message}")
    }
}

/// `data, format` of a renderer's copy, as `validBytes` checks them
fn valid_bytes(data: &IpcValue, format: &IpcValue) -> Option<(Vec<u8>, HwpFormat)> {
    let data = uint8(data)?;
    let format = as_str(format).and_then(HwpFormat::parse)?;
    (!data.is_empty() && data.len() <= MAX_HWP_SAVE_BYTES && bytes_match_format(data, format))
        .then(|| (data.to_vec(), format))
}

pub(super) fn entries(hwp: &Rc<Hwp>) -> Vec<Entry> {
    let mut all = Vec::new();

    let h = Rc::clone(hwp);
    all.push(kit::invoke("hwp:recovery-begin", move |cx, _| {
        let view = cx.sender.view;
        Ok(
            match h.with_recovery(|r, e, s| r.recovery_begin(e, s, wc(view))) {
                RecoveryBeginResult::Refused => obj([("ok", false.into_ipc())]),
                RecoveryBeginResult::Began(format) => obj([
                    ("ok", true.into_ipc()),
                    ("format", format.as_str().into_ipc()),
                ]),
            },
        )
    }));

    // the tabs a copy's bytes leave without a width: as many as the file is long
    let h = Rc::clone(hwp);
    all.push(kit::invoke_later(
        "hwp:recovery-new-tabs",
        move |cx, args, reply| {
            let view = cx.sender.view;
            if !h.recovery.borrow().has_turn(wc(view)) {
                return reply.reply(Ok(IpcValue::Array(Vec::new())));
            }
            let Some((data, format)) = valid_bytes(args.get(0), args.get(1)) else {
                return reply.reply(Ok(IpcValue::Array(Vec::new())));
            };
            on_worker(
                &h.services,
                move || tab_spots(&new_tabs_of(&data, format)),
                move |spots| reply.reply(Ok(spots)),
            );
        },
    ));

    let h = Rc::clone(hwp);
    all.push(kit::invoke_later(
        "hwp:recovery-write",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let data = uint8(args.get(0)).map(<[u8]>::to_vec);
            let format = as_str(args.get(1)).map(str::to_owned);
            let checked = h.with_recovery(|r, e, s| {
                r.recovery_write_check(e, s, wc(view), data.as_deref(), format.as_deref())
            });
            let job = match checked {
                Ok(job) => job,
                Err(outcome) => return reply.reply(Ok(outcome.as_str().into_ipc())),
            };
            let tabs: Option<Vec<serde_json::Value>> = match args.get(2) {
                IpcValue::Array(items) => Some(
                    items
                        .iter()
                        .map(|t| to_json(t).unwrap_or(serde_json::Value::Null))
                        .collect(),
                ),
                _ => None,
            };
            let data = data.unwrap_or_default();
            let (job_format, base) = (job.format, job.base.clone());
            let hwp = Rc::clone(&h);
            on_worker(
                &h.services,
                move || {
                    apply_save_fixes(&data, job_format, tabs.as_deref(), &base)
                        .bytes
                        .into_owned()
                },
                move |fixed| {
                    let outcome = hwp.with_recovery(|r, e, s| {
                        r.recovery_write_land(e, s, wc(view), job, &fixed)
                    });
                    reply.reply(Ok(outcome.as_str().into_ipc()))
                },
            );
        },
    ));

    let h = Rc::clone(hwp);
    all.push(kit::invoke("hwp:recovery-opened", move |cx, args| {
        let view = cx.sender.view;
        let protected = matches!(args.get(0), IpcValue::Bool(true));
        let opened = h.with_recovery(|r, e, _| r.recovery_opened(e, wc(view), protected));
        Ok(obj([
            ("restored", opened.restored.into_ipc()),
            ("notice", opened.notice.into_ipc()),
        ]))
    }));

    let h = Rc::clone(hwp);
    all.push(kit::send("hwp:recovery-flushed", move |_, args| {
        if let Some(token) = as_num(args.get(0)) {
            h.with_recovery(|r, e, _| r.recovery_flushed(e, token));
        }
        Ok(())
    }));

    all
}
