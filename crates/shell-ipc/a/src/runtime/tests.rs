//! The driver over a fake [`Net`] and the real file system, children and
//! timers: a core thread that queues jobs (the test thread, run by
//! [`Fixture::run_until`]) and workers that are threads.

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, ThreadId};
use std::time::{Duration, Instant};

use jscompat::JsonValue;
use main_core::packages::ai_provider::task::{
    Child, FileKind, FsAnswer, FsOp, RequestBody, ResponseHead, SpawnRequest, Stdio,
};
use serde_json::json;

use super::testing::{FakeNet, Log};
use super::*;

type Job = Box<dyn FnOnce() + Send>;

struct Core {
    jobs: Sender<Job>,
    owner: ThreadId,
}

impl Thread for Core {
    fn post(&self, job: Job) {
        let _ = self.jobs.send(job);
    }
    fn is_current(&self) -> bool {
        thread::current().id() == self.owner
    }
}

struct Threads;

impl Workers for Threads {
    fn spawn(&self, job: Job) {
        thread::spawn(job);
    }
}

struct Fixture {
    driver: Driver,
    core: Arc<dyn Thread>,
    jobs: Receiver<Job>,
}

impl Fixture {
    fn new(net: NetHost) -> Fixture {
        let (jobs_tx, jobs) = mpsc::channel();
        let core: Arc<dyn Thread> = Arc::new(Core {
            jobs: jobs_tx,
            owner: thread::current().id(),
        });
        let driver = Driver::from_parts(
            core.clone(),
            Arc::new(Threads),
            Path::new("/tmp/seuoffice-tmp"),
            Path::new("/home/seuoffice"),
            net,
        );
        Fixture { driver, core, jobs }
    }

    /// A second driver on the same core thread
    fn another(&self, net: NetHost) -> Driver {
        Driver::from_parts(
            self.core.clone(),
            Arc::new(Threads),
            Path::new("/tmp/seuoffice-tmp"),
            Path::new("/home/seuoffice"),
            net,
        )
    }

    /// Runs the jobs posted to the core thread until `done`
    fn run_until(&self, mut done: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(20);
        while !done() {
            assert!(Instant::now() < end, "timed out");
            if let Ok(job) = self.jobs.recv_timeout(Duration::from_millis(5)) {
                job();
            }
        }
    }

    /// Runs the jobs already posted
    fn drain(&self) {
        while let Ok(job) = self.jobs.try_recv() {
            job();
        }
    }

    /// Runs `future` on `driver` to its end; its output. The `then` ran once,
    /// on this (the core) thread.
    fn finish<T: 'static>(&self, driver: &Driver, future: impl Future<Output = T> + 'static) -> T {
        let slot: Rc<RefCell<Option<T>>> = Rc::new(RefCell::new(None));
        let times = Rc::new(Cell::new(0));
        let owner = thread::current().id();
        let (out, count) = (slot.clone(), times.clone());
        driver.run(future, move |value| {
            assert_eq!(thread::current().id(), owner);
            count.set(count.get() + 1);
            *out.borrow_mut() = Some(value);
        });
        self.run_until(|| slot.borrow().is_some());
        self.drain();
        assert_eq!(times.get(), 1);
        slot.take().unwrap()
    }
}

fn no_net() -> NetHost {
    FakeNet::new(&json!({}), None)
}

fn temp(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("seuoffice-driver-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().into_owned()
}

fn code(error: &JsError) -> String {
    match error.prop("code") {
        Some(JsonValue::String(code)) => code.clone(),
        other => panic!("no code: {other:?}"),
    }
}

// ---- fs ----

#[test]
fn fs_calls_run_on_workers_and_answer_in_the_order_awaited() {
    let dir = temp("fs");
    let fx = Fixture::new(no_net());
    let rt = fx.driver.rt();
    let root = dir.clone();
    let out = fx.finish(&fx.driver, async move {
        let file = format!("{root}/nested/a.txt");
        rt.fs(FsOp::Mkdir {
            path: format!("{root}/nested"),
            recursive: true,
            mode: None,
        })
        .await
        .unwrap();
        let write = |flag: &str| FsOp::WriteFile {
            path: file.clone(),
            data: b"hi".to_vec(),
            mode: None,
            flag: Some(flag.into()),
        };
        rt.fs(write("wx")).await.unwrap();
        let again = rt.fs(write("wx")).await.unwrap_err();
        let read = rt.fs(FsOp::ReadFile { path: file.clone() }).await.unwrap();
        let FsAnswer::Stat(stat) = rt.fs(FsOp::Stat { path: file.clone() }).await.unwrap() else {
            panic!("no stat")
        };
        rt.fs(FsOp::Rename {
            from: file.clone(),
            to: format!("{root}/nested/b.txt"),
        })
        .await
        .unwrap();
        let missing = rt
            .fs(FsOp::Access {
                path: file,
                mode: 0.0,
            })
            .await
            .unwrap_err();
        let FsAnswer::Entries(entries) = rt
            .fs(FsOp::Readdir {
                path: format!("{root}/nested"),
                with_types: true,
            })
            .await
            .unwrap()
        else {
            panic!("no entries")
        };
        rt.fs(FsOp::Rm {
            path: format!("{root}/nested"),
            recursive: true,
            force: false,
        })
        .await
        .unwrap();
        (code(&again), read, stat.size, code(&missing), entries)
    });
    assert_eq!(out.0, "EEXIST");
    assert_eq!(out.1, FsAnswer::Bytes(b"hi".to_vec()));
    assert_eq!(out.2, 2.0);
    assert_eq!(out.3, "ENOENT");
    assert_eq!(out.4.len(), 1);
    assert_eq!(out.4[0].name, "b.txt");
    assert_eq!(out.4[0].kind, Some(FileKind::File));
    assert!(!Path::new(&dir).join("nested").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

// ---- children ----

#[cfg(unix)]
fn sh(script: &str, stdio: [Stdio; 3]) -> SpawnRequest {
    SpawnRequest {
        command: "sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: None,
        env: None,
        stdio,
        detached: false,
        windows_hide: false,
        shell: None,
    }
}

/// Spawns, lets `act` talk to the child, and returns every event up to `close`
#[cfg(unix)]
async fn events_of(rt: &Rt, spawn: SpawnRequest, act: impl FnOnce(&Child)) -> Vec<ChildEvent> {
    let child = rt.spawn(spawn).await.unwrap();
    let events = Rc::new(RefCell::new(Vec::new()));
    let (closed, wait) = rt.deferred::<()>();
    let seen = events.clone();
    child.on(move |event| {
        seen.borrow_mut().push(event.clone());
        if matches!(event, ChildEvent::Close { .. }) {
            closed.settle(());
        }
    });
    act(&child);
    wait.await;
    events.take()
}

#[cfg(unix)]
fn joined(events: &[ChildEvent], stderr: bool) -> String {
    let bytes: Vec<u8> = events
        .iter()
        .flat_map(|event| match event {
            ChildEvent::Stdout(b) if !stderr => b.clone(),
            ChildEvent::Stderr(b) if stderr => b.clone(),
            _ => Vec::new(),
        })
        .collect();
    String::from_utf8(bytes).unwrap()
}

#[cfg(unix)]
#[test]
fn a_childs_output_comes_before_its_close_and_its_exit_code_with_both() {
    let fx = Fixture::new(no_net());
    let rt = fx.driver.rt();
    let events = fx.finish(&fx.driver, async move {
        let spawn = sh(
            "printf one; printf two >&2; printf three; exit 3",
            [Stdio::Ignore, Stdio::Pipe, Stdio::Pipe],
        );
        events_of(&rt, spawn, |_| {}).await
    });
    assert_eq!(joined(&events, false), "onethree");
    assert_eq!(joined(&events, true), "two");
    let Some(ChildEvent::Close { code, signal }) = events.last() else {
        panic!("the last event is no close: {events:?}")
    };
    assert_eq!((*code, signal.as_deref()), (Some(3.0), None));
    // exactly one exit and one close, the exit first, output never after the close
    let exits: Vec<usize> = (0..events.len())
        .filter(|i| matches!(events[*i], ChildEvent::Exit { .. }))
        .collect();
    assert_eq!(exits.len(), 1);
    assert!(matches!(
        events[exits[0]],
        ChildEvent::Exit { code: Some(c), signal: None } if c == 3.0
    ));
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, ChildEvent::Close { .. }))
            .count(),
        1
    );
}

#[cfg(unix)]
#[test]
fn a_child_gets_its_stdin_back_on_stdout_and_ends_when_stdin_ends() {
    let fx = Fixture::new(no_net());
    let rt = fx.driver.rt();
    let events = fx.finish(&fx.driver, async move {
        let spawn = sh("cat", [Stdio::Pipe, Stdio::Pipe, Stdio::Ignore]);
        events_of(&rt, spawn, |child| {
            assert!(child.stdin_writable());
            child.write(b"hello ");
            child.write("wörld".as_bytes());
            child.end_stdin();
        })
        .await
    });
    assert_eq!(joined(&events, false), "hello wörld");
    assert!(matches!(
        events.last(),
        Some(ChildEvent::Close { code: Some(c), .. }) if *c == 0.0
    ));
}

#[cfg(unix)]
#[test]
fn killing_a_child_ends_it_by_the_signal() {
    let fx = Fixture::new(no_net());
    let rt = fx.driver.rt();
    let events = fx.finish(&fx.driver, async move {
        let spawn = sh(
            "exec sleep 30",
            [Stdio::Ignore, Stdio::Ignore, Stdio::Ignore],
        );
        events_of(&rt, spawn, |child| {
            assert!(child.pid().is_some());
            child.kill(None);
        })
        .await
    });
    assert!(events.contains(&ChildEvent::Exit {
        code: None,
        signal: Some("SIGTERM".into())
    }));
    assert_eq!(
        events.last(),
        Some(&ChildEvent::Close {
            code: None,
            signal: Some("SIGTERM".into())
        })
    );
}

#[cfg(unix)]
#[test]
fn the_environment_and_folder_given_reach_the_child() {
    let dir = temp("cwd");
    let fx = Fixture::new(no_net());
    let rt = fx.driver.rt();
    let cwd = dir.clone();
    let events = fx.finish(&fx.driver, async move {
        let mut spawn = sh(
            "printf '%s|' \"$SEU_ONLY\"; pwd; printf '%s' \"${HOME-unset}\"",
            [Stdio::Ignore, Stdio::Pipe, Stdio::Ignore],
        );
        spawn.cwd = Some(cwd);
        spawn.env = Some(vec![
            ("SEU_ONLY".into(), "yes".into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ]);
        events_of(&rt, spawn, |_| {}).await
    });
    let out = joined(&events, false);
    let real = std::fs::canonicalize(&dir).unwrap();
    assert_eq!(out, format!("yes|{}\nunset", real.display()));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_child_that_cannot_start_answers_no_pid_then_error_then_close() {
    let fx = Fixture::new(no_net());
    let rt = fx.driver.rt();
    let (pid, events) = fx.finish(&fx.driver, async move {
        let spawn = SpawnRequest {
            command: "seuoffice-no-such-command".into(),
            args: vec!["--flag".into()],
            cwd: None,
            env: None,
            stdio: [Stdio::Ignore, Stdio::Pipe, Stdio::Pipe],
            detached: false,
            windows_hide: false,
            shell: None,
        };
        let child = rt.spawn(spawn).await.unwrap();
        let pid = child.pid();
        let events = Rc::new(RefCell::new(Vec::new()));
        let (closed, wait) = rt.deferred::<()>();
        let seen = events.clone();
        child.on(move |event| {
            seen.borrow_mut().push(event.clone());
            if matches!(event, ChildEvent::Close { .. }) {
                closed.settle(());
            }
        });
        wait.await;
        (pid, events.take())
    });
    assert_eq!(pid, None);
    let [
        ChildEvent::Error(error),
        ChildEvent::Close { code: exit, signal },
    ] = events.as_slice()
    else {
        panic!("unexpected events {events:?}")
    };
    assert_eq!(error.message, "spawn seuoffice-no-such-command ENOENT");
    assert_eq!(code(error), "ENOENT");
    assert_eq!(
        error.prop("spawnargs"),
        Some(&JsonValue::Array(vec![JsonValue::String("--flag".into())]))
    );
    assert_eq!(*signal, None);
    #[cfg(unix)]
    assert_eq!(*exit, Some(-2.0));
    #[cfg(not(unix))]
    assert!(exit.is_some());
}

// ---- timers ----

#[test]
fn timers_fire_in_time_order_and_a_cleared_one_never_does() {
    let fx = Fixture::new(no_net());
    let rt = fx.driver.rt();
    let started = Instant::now();
    let fired = fx.finish(&fx.driver, async move {
        let fired = Rc::new(RefCell::new(Vec::new()));
        for (label, ms) in [("slow", 50.0), ("fast", 10.0)] {
            let fired = fired.clone();
            rt.set_timeout(ms, move || fired.borrow_mut().push(label));
        }
        let cleared = {
            let fired = fired.clone();
            rt.set_timeout(20.0, move || fired.borrow_mut().push("cleared"))
        };
        rt.clear_timeout(Some(cleared));
        rt.sleep(120.0).await;
        fired.take()
    });
    assert_eq!(fired, ["fast", "slow"]);
    assert!(started.elapsed() >= Duration::from_millis(110));
}

// ---- the network ----

fn request(method: &str, body: &str) -> Request {
    Request {
        method: Some(method.into()),
        headers: vec![("x-a".into(), "1".into())],
        body: Some(RequestBody::Text(body.into())),
        redirect: None,
    }
}

fn stream_table() -> serde_json::Value {
    json!({ "fetch": [
        { "url": "https://api.test/stream", "method": "POST", "status": 200,
          "headers": { "content-type": "text/event-stream", "x-id": "7" },
          "body": ["data: a\n\n", "data: b\n\n"] },
        { "url": "https://api.test/none", "status": 404, "body": null },
        { "url": "https://api.test/down", "error": { "message": "fetch failed", "code": "ECONNRESET" } }
    ]})
}

#[test]
fn a_fetch_streams_its_body_in_two_chunks_then_ends() {
    let log: Log = Arc::default();
    let fx = Fixture::new(FakeNet::new(&stream_table(), Some(log.clone())));
    let rt = fx.driver.rt();
    let out = fx.finish(&fx.driver, async move {
        let response = rt
            .fetch(
                Fetcher::Net,
                "https://api.test/stream",
                request("POST", "{}"),
                None,
            )
            .await
            .unwrap();
        let head: ResponseHead = response.head.clone();
        let mut chunks = Vec::new();
        while let Some(chunk) = response.read().await.unwrap() {
            chunks.push(String::from_utf8(chunk).unwrap());
        }
        let none = rt
            .fetch(
                Fetcher::Node,
                "https://api.test/none",
                Request::default(),
                None,
            )
            .await
            .unwrap();
        let down = rt
            .fetch(
                Fetcher::Node,
                "https://api.test/down",
                Request::default(),
                None,
            )
            .await
            .err()
            .unwrap();
        let unknown = rt
            .fetch(
                Fetcher::Node,
                "https://api.test/other",
                Request::default(),
                None,
            )
            .await
            .err()
            .unwrap();
        (
            head,
            chunks,
            (none.status(), none.has_body()),
            down,
            unknown,
        )
    });
    let (head, chunks, none, down, unknown) = out;
    assert_eq!(head.status, 200.0);
    assert_eq!(head.status_text, "OK");
    assert!(head.has_body);
    assert_eq!(
        head.headers,
        [
            ("content-type".to_owned(), "text/event-stream".to_owned()),
            ("x-id".to_owned(), "7".to_owned())
        ]
    );
    assert_eq!(chunks, ["data: a\n\n", "data: b\n\n"]);
    assert_eq!(none, (404.0, false));
    assert!(down.is("TypeError") && down.message == "fetch failed");
    assert!(unknown.is("TypeError"));
    let lines = log.lock().unwrap().clone();
    assert_eq!(
        lines[0],
        json!([
            "fetch",
            0,
            "net",
            "POST",
            "https://api.test/stream",
            [["x-a", "1"]],
            "{}"
        ])
    );
    assert_eq!(lines.len(), 4);
}

#[test]
fn a_cloned_response_reads_what_the_original_has_not_read() {
    let fx = Fixture::new(FakeNet::new(&stream_table(), None));
    let rt = fx.driver.rt();
    let (first, original, copy) = fx.finish(&fx.driver, async move {
        let response = rt
            .fetch(
                Fetcher::Net,
                "https://api.test/stream",
                request("POST", ""),
                None,
            )
            .await
            .unwrap();
        let first = response.read().await.unwrap().unwrap();
        let copy = response.clone_response();
        (
            first,
            response.text().await.unwrap(),
            copy.text().await.unwrap(),
        )
    });
    assert_eq!(first, b"data: a\n\n");
    assert_eq!(original, "data: b\n\n");
    assert_eq!(copy, "data: b\n\n");
}

#[test]
fn cancelling_a_response_tells_the_host() {
    let log: Log = Arc::default();
    let fx = Fixture::new(FakeNet::new(&stream_table(), Some(log.clone())));
    let rt = fx.driver.rt();
    fx.finish(&fx.driver, async move {
        let response = rt
            .fetch(
                Fetcher::Net,
                "https://api.test/stream",
                request("POST", ""),
                None,
            )
            .await
            .unwrap();
        response.read().await.unwrap();
        response.cancel();
        // the cancel is carried out at the next poll
        rt.sleep(10.0).await;
    });
    let lines = log.lock().unwrap().clone();
    assert_eq!(lines.last(), Some(&json!(["cancel", 0])));
}

#[test]
fn the_fake_gives_a_cancelled_stream_no_chunk() {
    let net = FakeNet::new(&stream_table(), None);
    let fx = Fixture::new(net.clone());
    let sink = fx.driver.shared.sink();
    net.fetch(
        1,
        Fetcher::Net,
        "https://api.test/stream".into(),
        request("POST", ""),
        sink.clone(),
    );
    // the head is posted at once
    assert!(fx.jobs.try_recv().is_ok());
    net.read(2, 1, sink.clone());
    assert!(fx.jobs.try_recv().is_ok());
    net.cancel(1);
    net.read(3, 1, sink);
    assert!(fx.jobs.try_recv().is_err());
}

/// A host that holds every answer until the test gives it
#[derive(Default)]
struct HeldNet {
    fetches: Mutex<Vec<(Id, String, Sink)>>,
    cancelled: Mutex<Vec<Id>>,
}

impl Net for HeldNet {
    fn fetch(&self, id: Id, _via: Fetcher, url: String, _request: Request, sink: Sink) {
        self.fetches.lock().unwrap().push((id, url, sink));
    }
    fn read(&self, id: Id, _body: Id, sink: Sink) {
        sink.done(id, Answer::End);
    }
    fn clone_body(&self, _from: Id, _to: Id) {}
    fn cancel(&self, id: Id) {
        self.cancelled.lock().unwrap().push(id);
    }
    fn listen(&self, id: Id, _host: String, port: f64, sink: Sink) {
        sink.done(id, Answer::Listening { port });
    }
    fn respond(&self, _request: Id, _status: f64, _headers: Vec<(String, String)>, _body: Vec<u8>) {
    }
    fn close_server(&self, _server: Id) {}
}

fn head(status: f64) -> ResponseHead {
    ResponseHead {
        status,
        status_text: String::new(),
        headers: Vec::new(),
        url: String::new(),
        redirected: false,
        kind: "basic".into(),
        has_body: false,
    }
}

#[test]
fn an_aborted_fetch_is_cancelled_and_its_late_answer_is_dropped() {
    let net = Arc::new(HeldNet::default());
    let fx = Fixture::new(net.clone());
    let rt = fx.driver.rt();
    let outcome = fx.finish(&fx.driver, async move {
        let signal = rt.controller();
        let aborting = signal.clone();
        rt.set_timeout(20.0, move || aborting.abort(None));
        rt.fetch(
            Fetcher::Net,
            "https://slow.test",
            Request::default(),
            Some(&signal),
        )
        .await
        .err()
    });
    assert_eq!(outcome.map(|e| e.name), Some("AbortError".to_owned()));
    let (id, _, sink) = net.fetches.lock().unwrap().pop().unwrap();
    assert_eq!(*net.cancelled.lock().unwrap(), [id]);
    // the host answers anyway: nothing waits for it any more
    sink.done(id, Answer::Response(head(200.0)));
    fx.drain();
    assert!(fx.driver.shared.inflight.borrow().is_empty());
    assert!(fx.driver.shared.inbox.borrow().is_empty());
    // the driver goes on as before
    let rt = fx.driver.rt();
    let net2 = net.clone();
    let again = fx.driver.clone();
    again.run(
        async move {
            rt.fetch(Fetcher::Net, "https://next.test", Request::default(), None)
                .await
                .map(|r| r.status())
        },
        |_| {},
    );
    let (second, url, sink) = net2.fetches.lock().unwrap().pop().unwrap();
    assert_eq!(url, "https://next.test");
    assert_ne!(second, id);
    sink.done(second, Answer::Response(head(201.0)));
    fx.drain();
}

#[test]
fn drivers_that_share_a_host_give_it_ids_that_differ() {
    let net = Arc::new(HeldNet::default());
    let fx = Fixture::new(net.clone());
    let other = fx.another(net.clone());
    let statuses = Rc::new(RefCell::new(Vec::new()));
    for (driver, name) in [(&fx.driver, "a"), (&other, "b")] {
        let rt = driver.rt();
        let statuses = statuses.clone();
        driver.run(
            async move {
                rt.fetch(
                    Fetcher::Net,
                    &format!("https://{name}.test"),
                    Request::default(),
                    None,
                )
                .await
                .map(|r| r.status())
            },
            move |status| statuses.borrow_mut().push((name, status.unwrap())),
        );
    }
    let mut held: Vec<(Id, String, Sink)> = net.fetches.lock().unwrap().drain(..).collect();
    assert_eq!(held.len(), 2);
    assert_ne!(held[0].0, held[1].0);
    // answered in the other order: each answer reaches the driver that asked
    held.reverse();
    for (id, url, sink) in held {
        sink.done(
            id,
            Answer::Response(head(if url.contains("a.test") { 201.0 } else { 202.0 })),
        );
    }
    fx.drain();
    let mut statuses = statuses.take();
    statuses.sort_by_key(|(name, _)| *name);
    assert_eq!(statuses, [("a", 201.0), ("b", 202.0)]);
}

#[test]
fn a_server_passes_requests_in_and_its_answers_and_close_go_out() {
    let log: Log = Arc::default();
    let table = json!({ "listen": { "port": 43111, "requests": [
        { "method": "GET", "url": "/cb?code=abc", "headers": { "host": "127.0.0.1" } }
    ]}});
    let fx = Fixture::new(FakeNet::new(&table, Some(log.clone())));
    let rt = fx.driver.rt();
    let seen = fx.finish(&fx.driver, async move {
        let seen = Rc::new(RefCell::new(Vec::new()));
        let (got, wait) = rt.deferred::<()>();
        let (answering, recorded) = (rt.clone(), seen.clone());
        let (server, port) = rt
            .listen("127.0.0.1", 0.0, move |request| {
                recorded
                    .borrow_mut()
                    .push((request.method.clone(), request.url.clone()));
                answering.respond(
                    request.id,
                    200.0,
                    vec![("content-type".into(), "text/plain".into())],
                    b"ok",
                );
                got.settle(());
            })
            .await
            .unwrap();
        wait.await;
        server.close();
        (port, seen.take())
    });
    assert_eq!(seen.0, 43111.0);
    assert_eq!(seen.1, [("GET".to_owned(), "/cb?code=abc".to_owned())]);
    assert_eq!(
        *log.lock().unwrap(),
        [
            json!(["listen", "127.0.0.1", 43111.0]),
            json!(["respond", 200.0, [["content-type", "text/plain"]], "ok"]),
            json!(["closeServer"]),
        ]
    );
}

// ---- calls, promises, host values ----

#[test]
fn a_call_by_name_runs_the_function_the_shell_gave() {
    let fx = Fixture::new(no_net());
    fx.driver.on_call("openBrowser", |args, reply| {
        let JsonValue::String(url) = args else {
            return reply.fail(JsError::type_error("url"));
        };
        reply.value(JsonValue::String(format!("opened {url}")));
    });
    fx.driver.on_call("noop", |_, reply| reply.unit());
    let rt = fx.driver.rt();
    let (opened, nothing, null, missing) = fx.finish(&fx.driver, async move {
        let opened = rt
            .call("openBrowser", JsonValue::String("https://x.test".into()))
            .await
            .unwrap();
        let nothing = rt.call_exact("noop", JsonValue::Null).await.unwrap();
        let null = rt.call("noop", JsonValue::Null).await.unwrap();
        let missing = rt
            .call("noSuchFunction", JsonValue::Null)
            .await
            .unwrap_err();
        (opened, nothing, null, missing)
    });
    assert_eq!(opened, JsonValue::String("opened https://x.test".into()));
    assert_eq!(nothing, None);
    assert_eq!(null, JsonValue::Null);
    assert!(missing.is("TypeError"));
    assert_eq!(missing.message, "noSuchFunction is not a function");
}

#[test]
fn a_call_answered_later_continues_the_future_and_a_throw_rejects_it() {
    let fx = Fixture::new(no_net());
    let pending: Rc<RefCell<Vec<CallReply>>> = Rc::default();
    let queue = pending.clone();
    fx.driver
        .on_call("ask", move |_, reply| queue.borrow_mut().push(reply));
    let rt = fx.driver.rt();
    let result: Rc<RefCell<Option<(JsonValue, String)>>> = Rc::default();
    let out = result.clone();
    fx.driver.run(
        async move {
            let first = rt.call("ask", JsonValue::Null).await.unwrap();
            let second = rt.call("ask", JsonValue::Null).await.unwrap_err();
            (first, second.message)
        },
        move |value| *out.borrow_mut() = Some(value),
    );
    assert_eq!(pending.borrow().len(), 1);
    assert!(result.borrow().is_none());
    // the shell answers from somewhere else on the core thread
    let reply = pending.borrow_mut().pop().unwrap();
    reply.value(JsonValue::Number(7.0));
    assert_eq!(pending.borrow().len(), 1);
    let reply = pending.borrow_mut().pop().unwrap();
    reply.fail(JsError::error("declined"));
    assert_eq!(
        result.take(),
        Some((JsonValue::Number(7.0), "declined".to_owned()))
    );
}

#[test]
fn a_deferred_wakes_the_future_that_awaits_it() {
    let fx = Fixture::new(no_net());
    let (resolver, wait) = fx.driver.deferred::<String>();
    let done: Rc<RefCell<Option<String>>> = Rc::default();
    let out = done.clone();
    fx.driver.run(async move { wait.await }, move |v| {
        *out.borrow_mut() = Some(v)
    });
    assert!(done.borrow().is_none());
    resolver.resolve("settled".into());
    assert_eq!(done.take().as_deref(), Some("settled"));
}

#[test]
fn a_then_may_start_another_future_and_both_finish_once() {
    let fx = Fixture::new(no_net());
    let order: Rc<RefCell<Vec<&str>>> = Rc::default();
    let (first, second) = (order.clone(), order.clone());
    let driver = fx.driver.clone();
    fx.driver.run(async { 1 }, move |_| {
        first.borrow_mut().push("first");
        let second = second.clone();
        driver.run(async { 2 }, move |_| second.borrow_mut().push("second"));
    });
    assert_eq!(*order.borrow(), ["first", "second"]);
}

#[test]
fn the_host_values_are_the_machines() {
    let fx = Fixture::new(no_net());
    let rt = fx.driver.rt();
    assert_eq!(rt.platform(), crate::secrets::PLATFORM);
    assert_eq!(rt.pid(), f64::from(std::process::id()));
    assert_eq!(rt.tmpdir(), "/tmp/seuoffice-tmp");
    assert_eq!(rt.homedir(), "/home/seuoffice");
    assert!((rt.now() - now_ms()).abs() < 5_000.0);
    assert_eq!(rt.random_bytes(12).len(), 12);
    let uuid = rt.random_uuid();
    assert_ne!(uuid, rt.random_uuid());
    let parts: Vec<&str> = uuid.split('-').collect();
    assert_eq!(
        parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
        [8, 4, 4, 4, 12]
    );
    assert!(parts[2].starts_with('4') && "89ab".contains(&parts[3][..1]));
    assert!(
        rt.env_all()
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("PATH"))
    );
    let err = rt.kill_pid(0.0, None).unwrap_err();
    assert_eq!(err.message, "kill ESRCH");
}

#[test]
fn the_provider_states_are_made_once_per_driver() {
    let fx = Fixture::new(no_net());
    let (a, b) = (fx.driver.providers(), fx.driver.providers());
    assert!(Rc::ptr_eq(&a.fx, &b.fx));
    assert!(Rc::ptr_eq(&a.codex, &b.codex));
    let other = fx.another(no_net());
    assert!(!Rc::ptr_eq(&a.fx, &other.providers().fx));
}
