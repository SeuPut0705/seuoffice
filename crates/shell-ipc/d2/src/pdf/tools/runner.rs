//! `pdf-structure/runner.ts` `StructureJobRunner`: one job process per job
//! (the engine's [`PdfToolsEngine::run_job`], on a worker), at most four per
//! view, ended when it answers, is cancelled, or its view goes away. A job's
//! answer comes once: a cancel answers at once and the process's late answer
//! is dropped.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use shell_contract::runtime::{CancelToken, Services};
use shell_contract::{IpcValue, ViewId};

use super::Ctx;
use super::hosts::{JobFailure, JobOutcome};
use crate::kit;

/// `MAX_JOBS_PER_OWNER`
pub const MAX_JOBS_PER_OWNER: usize = 4;

/// Progress as the job process reports it: done, total. Runs on a worker.
pub type Progress = Arc<dyn Fn(f64, f64) + Send + Sync>;

type Finish = Box<dyn FnOnce(JobOutcome)>;

struct Running {
    /// which run holds the key: a cancelled run's late answer must not end a
    /// later run that reuses its job id
    run: u64,
    cancel: CancelToken,
    finish: Finish,
}

#[derive(Default)]
struct Jobs {
    running: HashMap<(ViewId, String), Running>,
    next: u64,
}

pub struct Runner {
    jobs: Rc<RefCell<Jobs>>,
    services: Services,
}

impl Runner {
    pub fn new(services: &Services) -> Self {
        Runner {
            jobs: Rc::default(),
            services: services.clone(),
        }
    }

    /// `run(owner, jobId, job, onProgress)`: `then` gets the answer once, on
    /// the core thread
    pub fn run(
        &self,
        ctx: &Ctx,
        owner: ViewId,
        job_id: &str,
        job: IpcValue,
        progress: Option<Progress>,
        then: impl FnOnce(JobOutcome) + 'static,
    ) {
        let key = (owner, job_id.to_owned());
        {
            let jobs = self.jobs.borrow();
            if jobs.running.contains_key(&key) {
                drop(jobs);
                return then(Err(JobFailure::new("busy", Some("job id already running"))));
            }
            if jobs.running.keys().filter(|(o, _)| *o == owner).count() >= MAX_JOBS_PER_OWNER {
                drop(jobs);
                return then(Err(JobFailure::new(
                    "busy",
                    Some("too many jobs for this view"),
                )));
            }
        }
        let cancel = CancelToken::default();
        let run = {
            let mut jobs = self.jobs.borrow_mut();
            jobs.next += 1;
            let run = jobs.next;
            jobs.running.insert(
                key.clone(),
                Running {
                    run,
                    cancel: cancel.clone(),
                    finish: Box::new(then),
                },
            );
            run
        };
        let engine = ctx.engine.clone();
        let token = cancel.clone();
        let jobs = Rc::downgrade(&self.jobs);
        kit::on_worker(
            &self.services,
            move || {
                // progress after the job ended is not read (`settled`)
                let report = |done: f64, total: f64| {
                    if let Some(p) = &progress
                        && !token.is_cancelled()
                    {
                        p(done, total)
                    }
                };
                engine.run_job(job, &report, &token)
            },
            move |outcome| {
                let Some(jobs) = jobs.upgrade() else { return };
                let mine = jobs
                    .borrow()
                    .running
                    .get(&key)
                    .is_some_and(|r| r.run == run);
                if mine {
                    let ended = jobs.borrow_mut().running.remove(&key);
                    if let Some(ended) = ended {
                        // the process ends with its job
                        ended.cancel.cancel();
                        (ended.finish)(outcome)
                    }
                }
            },
        );
    }

    fn end(&self, which: impl Fn(&(ViewId, String)) -> bool, failure: JobFailure) -> usize {
        let ended: Vec<Running> = {
            let mut jobs = self.jobs.borrow_mut();
            let keys: Vec<_> = jobs.running.keys().filter(|k| which(k)).cloned().collect();
            keys.iter().filter_map(|k| jobs.running.remove(k)).collect()
        };
        let n = ended.len();
        for job in ended {
            job.cancel.cancel();
            (job.finish)(Err(failure.clone()))
        }
        n
    }

    /// `cancel(owner, jobId)`: its run answers `cancelled`; false when no such job runs
    pub fn cancel(&self, owner: ViewId, job_id: &str) -> bool {
        self.end(
            |(o, j)| *o == owner && j == job_id,
            JobFailure::new("cancelled", None),
        ) > 0
    }

    /// `cancelOwner(owner)`: the view closed
    pub fn cancel_owner(&self, owner: ViewId) -> usize {
        self.end(
            |(o, _)| *o == owner,
            JobFailure::new("cancelled", Some("the document closed")),
        )
    }

    /// `cancelAll()`: the app is quitting
    pub fn cancel_all(&self) -> usize {
        self.end(|_| true, JobFailure::new("cancelled", Some("the app quit")))
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use serde_json::json;
    use shell_contract::ViewId;

    use super::super::test_support::*;
    use super::*;

    type Got = Rc<RefCell<Vec<JobOutcome>>>;
    type Sink = Box<dyn FnOnce(JobOutcome)>;

    fn outcomes() -> (Got, impl Fn() -> Sink) {
        let got: Rc<RefCell<Vec<JobOutcome>>> = Rc::default();
        let g = got.clone();
        (got, move || {
            let g = g.clone();
            Box::new(move |o| g.borrow_mut().push(o))
        })
    }

    #[test]
    fn a_fifth_job_of_one_view_is_busy_and_a_cancel_answers_once() {
        let t = tools(json!({}));
        let tools = t.tools();
        let ctx = &tools.ctx;
        let (got, sink) = outcomes();
        // the fake answers at once, so hold the jobs by leaving the worker queue undrained
        for i in 0..4 {
            ctx.runner.run(
                ctx,
                ViewId(1),
                &format!("j{i}"),
                IpcValue::Null,
                None,
                sink(),
            );
        }
        ctx.runner
            .run(ctx, ViewId(1), "j4", IpcValue::Null, None, sink());
        ctx.runner
            .run(ctx, ViewId(1), "j0", IpcValue::Null, None, sink());
        ctx.runner
            .run(ctx, ViewId(2), "j0", IpcValue::Null, None, sink());
        assert_eq!(
            got.borrow()
                .iter()
                .map(|o| o.as_ref().unwrap_err().message.clone().unwrap())
                .collect::<Vec<_>>(),
            vec!["too many jobs for this view", "job id already running"]
        );
        assert!(ctx.runner.cancel(ViewId(1), "j1"));
        assert!(!ctx.runner.cancel(ViewId(1), "j1"));
        assert_eq!(ctx.runner.cancel_owner(ViewId(1)), 3);
        assert_eq!(got.borrow().len(), 6);
        assert_eq!(got.borrow()[2].as_ref().unwrap_err().error, "cancelled");
        assert_eq!(
            got.borrow()[3].as_ref().unwrap_err().message.as_deref(),
            Some("the document closed")
        );
        // the workers' late answers end nothing: view 2's job still answers once
        drop(got.borrow_mut().drain(..));
        let mut rt = t.rt;
        rt.drain();
        assert_eq!(got.borrow().len(), 1);
        assert_eq!(got.borrow()[0].as_ref().unwrap_err().error, "not-available");
    }
}

#[cfg(test)]
mod quit {
    use serde_json::json;
    use shell_contract::{IpcValue, ViewId};

    use super::super::test_support::*;

    #[test]
    fn quitting_ends_every_views_jobs() {
        let t = tools(json!({}));
        let tools = t.tools();
        let got = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        for view in [1, 2] {
            let g = got.clone();
            tools.ctx.runner.run(
                &tools.ctx,
                ViewId(view),
                "a",
                IpcValue::Null,
                None,
                move |o| g.borrow_mut().push(o.unwrap_err().message),
            );
        }
        assert_eq!(tools.cancel_all(), 2);
        assert_eq!(*got.borrow(), vec![Some("the app quit".to_owned()); 2]);
    }
}
