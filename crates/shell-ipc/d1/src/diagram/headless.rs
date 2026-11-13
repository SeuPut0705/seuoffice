//! `headless-main.ts`: windowless diagram jobs. The hidden window the shell
//! makes for a job asks `headless-job` for it and ends it with
//! `headless-done`; the exporter that started the job waits on `done`.

use std::time::Duration;

use shell_contract::ipc::CallContext;
use shell_contract::{IpcError, IpcValue, ViewId};

use super::DiagramViews;
use super::state::HeadlessJob;
use crate::value::{Args, obj, string};

/// Under the command line's own wait (180 s), so the app answers before it is killed
const JOB_TIMEOUT: Duration = Duration::from_millis(170_000);

fn failed(error: &str) -> IpcValue {
    obj([("ok", IpcValue::Bool(false)), ("error", string(error))])
}

/// `reportOf(value)`
fn report_of(value: &IpcValue) -> IpcValue {
    match value {
        IpcValue::Object(entries) if entries.iter().any(|(key, _)| key == "ok") => value.clone(),
        _ => failed("the diagram page sent no report"),
    }
}

impl DiagramViews {
    /// `runInHiddenWindow`'s state: `view` is the hidden window's view (made
    /// with [`DiagramViews::open_hidden_view`]); `done` gets the page's report,
    /// or a failure report when nothing comes within 170 s
    pub fn run_headless_job(&self, view: ViewId, job: IpcValue, done: Box<dyn FnOnce(IpcValue)>) {
        let generation = self.with_state(|state| {
            let generation = state.next_generation();
            state.headless.insert(
                view,
                HeadlessJob {
                    generation,
                    job,
                    done,
                },
            );
            generation
        });
        self.after(JOB_TIMEOUT, move |views| {
            let running = views.with_state(|state| match state.headless.get(&view) {
                Some(running) if running.generation == generation => state.headless.remove(&view),
                _ => None,
            });
            if let Some(running) = running {
                (running.done)(failed("the diagram editor did not finish in time"));
            }
        });
    }

    /// The hidden window's page stopped or did not load (`render-process-gone`,
    /// `did-fail-load`): the job ends with `error`
    pub fn fail_headless_job(&self, view: ViewId, error: &str) {
        let running = self.with_state(|state| state.headless.remove(&view));
        if let Some(running) = running {
            (running.done)(failed(error));
        }
    }

    pub(super) fn headless_job(&self, cx: &CallContext, _args: Args) -> Result<IpcValue, IpcError> {
        // only a hidden window made for a job gets one; every other view asks nothing
        Ok(self.with_state(|state| {
            state
                .headless
                .get(&cx.sender.view)
                .map_or(IpcValue::Null, |running| running.job.clone())
        }))
    }

    pub(super) fn headless_done(&self, cx: &CallContext, args: Args) -> Result<(), IpcError> {
        let running = self.with_state(|state| state.headless.remove(&cx.sender.view));
        if let Some(running) = running {
            (running.done)(report_of(args.get(0)));
        }
        Ok(())
    }
}
