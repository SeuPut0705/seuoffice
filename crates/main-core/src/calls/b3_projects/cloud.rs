//! Part `cloud` of group `b3-projects` (tools/main-diff/groups/
//! b3-projects-cloud.ts): `cloud-files.ts` and `cloud-cache.ts`. The attribute
//! reader a case names is built from its spec: `{ listings, fail? }` is a
//! reader of the caller, `{ run: { out?, fail? }, env? }` is the PowerShell
//! reader over a fake program runner. Each call of a fake is one `logs` line,
//! written as the TypeScript fakes of the spec write it. A case without a
//! reader never reaches one; a reader that is asked for anyway logs
//! `unexpected reader`, which the TypeScript does not, so the comparison
//! shows it. The cache scenario runs a list of operations over one
//! [`CachedCloudResolver`], each with its clock and the detector's answer.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use jscompat::{JsMap, JsObject};
use serde_json::{Number, Value, json};

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::shell::projects::cloud_cache::{
    CONTEXT_CLOUD_CACHE_MS, CacheClock, CachedCloudResolver,
};
use crate::shell::projects::cloud_files::{
    AttributeReader, CLOUD_ONLY_ATTRIBUTES, DEFAULT_LISTING_TIMEOUT_MS, DetectOptions,
    DirectoryAttributes, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
    FILE_ATTRIBUTE_RECALL_ON_OPEN, ListingFailure, ListingRun, ListingRunOptions,
    POWERSHELL_LISTING_SCRIPT, PowerShellAttributeReader, ResolveOptions, SyncFolderOptions,
    detect_cloud_only_files, is_cloud_only_attributes, is_on_google_drive_stream,
    is_under_known_sync_folder, known_sync_folders, parse_attribute_listing, resolve_cloud_only,
};
use crate::shell::projects::project_files::{CloudOnlyResolver, ResolveFailure};

type Log = Vec<Vec<Value>>;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "cloud-files.FILE_ATTRIBUTE_OFFLINE" => Ok(Some(Value::from(FILE_ATTRIBUTE_OFFLINE))),
        "cloud-files.FILE_ATTRIBUTE_RECALL_ON_OPEN" => {
            Ok(Some(Value::from(FILE_ATTRIBUTE_RECALL_ON_OPEN)))
        }
        "cloud-files.FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS" => {
            Ok(Some(Value::from(FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)))
        }
        "cloud-files.CLOUD_ONLY_ATTRIBUTES" => Ok(Some(Value::from(CLOUD_ONLY_ATTRIBUTES))),
        "cloud-files.DEFAULT_LISTING_TIMEOUT_MS" => Ok(Some(num(DEFAULT_LISTING_TIMEOUT_MS))),
        "cloud-files.POWERSHELL_LISTING_SCRIPT" => Ok(Some(Value::from(POWERSHELL_LISTING_SCRIPT))),
        "cloud-files.isCloudOnlyAttributes" => number_arg(args, 0)
            .map(|attributes| Some(Value::from(is_cloud_only_attributes(attributes)))),
        "cloud-files.parseAttributeListing" => parse_call(args),
        "cloud-files.createPowerShellAttributeReader" => reader_call(args, cx),
        "cloud-files.detectCloudOnlyFiles" => detect_call(args, cx),
        "cloud-files.knownSyncFolders" => known_call(args),
        "cloud-files.isOnGoogleDriveStream" => str_arg(args, 0).and_then(|path| {
            let platform = str_arg(args, 1)?;
            Ok(Some(Value::from(is_on_google_drive_stream(path, platform))))
        }),
        "cloud-files.isUnderKnownSyncFolder" => under_call(args),
        "cloud-files.resolveCloudOnly" => resolve_call(args, cx),
        "cloud-cache.CONTEXT_CLOUD_CACHE_MS" => Ok(Some(num(CONTEXT_CLOUD_CACHE_MS))),
        "cloud-cache.createCachedCloudResolver" => cache_call(args, cx),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn number_arg(args: &[Value], i: usize) -> Result<f64, CallError> {
    arg(args, i)
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("a number"))
}

fn string_list(value: Option<&Value>) -> Result<Vec<String>, CallError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

/// a field of an object spec, `None` where it is absent or `null`
fn field<'a>(spec: &'a Value, key: &str) -> Option<&'a Value> {
    spec.get(key).filter(|v| !v.is_null())
}

fn field_str<'a>(spec: &'a Value, key: &str) -> Option<&'a str> {
    field(spec, key).and_then(Value::as_str)
}

fn print<T: serde::Serialize>(value: &T) -> Answer {
    Ok(Some(serde_json::to_value(value).expect("an answer prints")))
}

/// `process.env` of a spec: an object of strings
fn env_of(spec: Option<&Value>) -> JsObject<String> {
    let mut env = JsObject::new();
    if let Some(Value::Object(entries)) = spec {
        for (key, value) in entries {
            if let Some(value) = value.as_str() {
                env.set(key.clone(), value.to_owned());
            }
        }
    }
    env
}

fn failure(error: ListingFailure) -> CallError {
    CallError::plain(error.0)
}

// ---- the attribute readers of the specs ----

/// `{ listings, fail? }`: logs `read dirs timeoutMs`, then rejects with `fail`
/// or answers the listings
struct ScriptReader<'a> {
    spec: &'a Value,
    logs: &'a mut Log,
}

impl AttributeReader for ScriptReader<'_> {
    fn read(
        &mut self,
        dirs: &[String],
        timeout_ms: f64,
    ) -> Result<JsMap<DirectoryAttributes>, ListingFailure> {
        self.logs
            .push(vec![Value::from("read"), json!(dirs), num(timeout_ms)]);
        if let Some(message) = field_str(self.spec, "fail") {
            return Err(ListingFailure(message.to_owned()));
        }
        let mut out: JsMap<DirectoryAttributes> = JsMap::new();
        let listings = field(self.spec, "listings").and_then(Value::as_array);
        for listing in listings.into_iter().flatten() {
            let Some(dir) = listing.get(0).and_then(Value::as_str) else {
                continue;
            };
            let entries = listing.get(1).and_then(Value::as_array).map(|entries| {
                let mut map: JsMap<f64> = JsMap::new();
                for entry in entries {
                    if let (Some(name), Some(attributes)) = (
                        entry.get(0).and_then(Value::as_str),
                        entry.get(1).and_then(Value::as_f64),
                    ) {
                        map.set(name, attributes);
                    }
                }
                map
            });
            out.set(dir, entries);
        }
        Ok(out)
    }
}

/// `{ out?, fail? }`: logs `run file args { cwd, timeoutMs, input, env }`, then
/// rejects with `fail` or answers `out`
struct ScriptRun<'a> {
    out: Option<&'a str>,
    fail: Option<&'a str>,
    logs: &'a mut Log,
}

impl ListingRun for ScriptRun<'_> {
    fn run(
        &mut self,
        file: &str,
        args: &[String],
        options: &ListingRunOptions<'_>,
    ) -> Result<String, ListingFailure> {
        self.logs.push(vec![
            Value::from("run"),
            Value::from(file),
            json!(args),
            json!({
                "cwd": options.cwd,
                "timeoutMs": num(options.timeout_ms),
                "input": options.input,
                "env": serde_json::to_value(options.env).expect("an environment prints"),
            }),
        ]);
        if let Some(message) = self.fail {
            return Err(ListingFailure(message.to_owned()));
        }
        Ok(self.out.unwrap_or("").to_owned())
    }
}

/// the reader a case names, or the one that shows it was asked for
enum SpecReader<'a> {
    Script(ScriptReader<'a>),
    PowerShell(PowerShellAttributeReader<ScriptRun<'a>>),
    Absent(&'a mut Log),
}

impl AttributeReader for SpecReader<'_> {
    fn read(
        &mut self,
        dirs: &[String],
        timeout_ms: f64,
    ) -> Result<JsMap<DirectoryAttributes>, ListingFailure> {
        match self {
            SpecReader::Script(reader) => reader.read(dirs, timeout_ms),
            SpecReader::PowerShell(reader) => reader.read(dirs, timeout_ms),
            SpecReader::Absent(logs) => {
                logs.push(vec![Value::from("unexpected reader")]);
                Err(ListingFailure("unexpected reader".to_owned()))
            }
        }
    }
}

fn run_of<'a>(spec: &'a Value, logs: &'a mut Log) -> ScriptRun<'a> {
    let run = spec.get("run").unwrap_or(&Value::Null);
    ScriptRun {
        out: field_str(run, "out"),
        fail: field_str(run, "fail"),
        logs,
    }
}

fn make_reader<'a>(spec: Option<&'a Value>, logs: &'a mut Log) -> SpecReader<'a> {
    match spec.filter(|spec| !spec.is_null()) {
        None => SpecReader::Absent(logs),
        Some(spec) if spec.get("run").is_some() => SpecReader::PowerShell(
            PowerShellAttributeReader::new(env_of(spec.get("env")), run_of(spec, logs)),
        ),
        Some(spec) => SpecReader::Script(ScriptReader { spec, logs }),
    }
}

// ---- cloud-files ----

/// `[stdout, dirs]`
fn parse_call(args: &[Value]) -> Answer {
    let stdout = str_arg(args, 0)?;
    let dirs = string_list(arg(args, 1))?;
    parse_attribute_listing(stdout, &dirs)
        .map_err(failure)
        .and_then(|listing| print(&listing))
}

/// `[cfg: { env?, run }, dirs, timeoutMs]`
fn reader_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("cfg"))?;
    let dirs = string_list(arg(args, 1))?;
    let timeout_ms = number_arg(args, 2)?;
    let mut reader =
        PowerShellAttributeReader::new(env_of(spec.get("env")), run_of(spec, &mut cx.logs));
    reader
        .read(&dirs, timeout_ms)
        .map_err(failure)
        .and_then(|listing| print(&listing))
}

/// `[paths, { platform, timeoutMs?, reader? }]`
fn detect_call(args: &[Value], cx: &mut Context) -> Answer {
    let paths = string_list(arg(args, 0))?;
    let cfg = arg(args, 1).ok_or_else(|| bad("cfg"))?;
    let options = DetectOptions {
        platform: field_str(cfg, "platform").unwrap_or_default(),
        timeout_ms: field(cfg, "timeoutMs").and_then(Value::as_f64),
    };
    let mut reader = make_reader(cfg.get("reader"), &mut cx.logs);
    print(&detect_cloud_only_files(&paths, &options, &mut reader))
}

/// `{ platform, homeDir?, extraRoots?, osHome }` of a spec
struct SyncSpec<'a> {
    platform: &'a str,
    home_dir: Option<&'a str>,
    os_home_dir: &'a str,
    extra_roots: Vec<String>,
}

impl<'a> SyncSpec<'a> {
    fn of(spec: &'a Value) -> Result<Self, CallError> {
        Ok(SyncSpec {
            platform: field_str(spec, "platform").unwrap_or_default(),
            home_dir: field_str(spec, "homeDir"),
            os_home_dir: field_str(spec, "osHome").unwrap_or_default(),
            extra_roots: match field(spec, "extraRoots") {
                Some(roots) => string_list(Some(roots))?,
                None => Vec::new(),
            },
        })
    }

    fn options(&self) -> SyncFolderOptions<'_> {
        SyncFolderOptions {
            platform: self.platform,
            home_dir: self.home_dir,
            os_home_dir: self.os_home_dir,
            extra_roots: &self.extra_roots,
        }
    }
}

/// `[env, options]`
fn known_call(args: &[Value]) -> Answer {
    let env = env_of(arg(args, 0));
    let spec = SyncSpec::of(arg(args, 1).ok_or_else(|| bad("options"))?)?;
    print(&known_sync_folders(&env, &spec.options()))
}

/// `[path, env, options]`
fn under_call(args: &[Value]) -> Answer {
    let path = str_arg(args, 0)?;
    let env = env_of(arg(args, 1));
    let spec = SyncSpec::of(arg(args, 2).ok_or_else(|| bad("options"))?)?;
    Ok(Some(Value::from(is_under_known_sync_folder(
        path,
        &env,
        &spec.options(),
    ))))
}

/// `[paths, env, { ...sync options, timeoutMs?, reader? }]`
fn resolve_call(args: &[Value], cx: &mut Context) -> Answer {
    let paths = string_list(arg(args, 0))?;
    let env = env_of(arg(args, 1));
    let cfg = arg(args, 2).ok_or_else(|| bad("cfg"))?;
    let spec = SyncSpec::of(cfg)?;
    let options = ResolveOptions {
        platform: spec.platform,
        timeout_ms: field(cfg, "timeoutMs").and_then(Value::as_f64),
        home_dir: spec.home_dir,
        os_home_dir: spec.os_home_dir,
        extra_roots: &spec.extra_roots,
    };
    let mut reader = make_reader(cfg.get("reader"), &mut cx.logs);
    print(&resolve_cloud_only(&paths, &env, &options, &mut reader))
}

// ---- cloud-cache ----

/// what the fake detector and the fake clock of a scenario share
struct World {
    answers: JsMap<bool>,
    fail: Option<String>,
    times: VecDeque<f64>,
    last: f64,
    logs: Log,
}

struct WorldResolver(Rc<RefCell<World>>);

impl CloudOnlyResolver for WorldResolver {
    fn resolve(&mut self, paths: &[String]) -> Result<JsMap<bool>, ResolveFailure> {
        let mut world = self.0.borrow_mut();
        world.logs.push(vec![Value::from("resolve"), json!(paths)]);
        match &world.fail {
            Some(message) => Err(ResolveFailure(message.clone())),
            None => Ok(world.answers.clone()),
        }
    }
}

struct WorldClock(Rc<RefCell<World>>);

impl CacheClock for WorldClock {
    fn now(&mut self) -> f64 {
        let mut world = self.0.borrow_mut();
        if let Some(time) = world.times.pop_front() {
            world.last = time;
        }
        world.last
    }
}

/// `[{ ttlMs? }, ops]`: an op is `{ paths, now, answers?, fail? }`
fn cache_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?;
    let ops = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let world = Rc::new(RefCell::new(World {
        answers: JsMap::new(),
        fail: None,
        times: VecDeque::new(),
        last: 0.0,
        logs: Vec::new(),
    }));
    let mut cache = CachedCloudResolver::new(
        WorldResolver(Rc::clone(&world)),
        field(cfg, "ttlMs").and_then(Value::as_f64),
        WorldClock(Rc::clone(&world)),
    );
    let mut out: Vec<Value> = Vec::new();
    for op in ops {
        {
            let mut world = world.borrow_mut();
            world.answers = JsMap::new();
            if let Some(Value::Object(answers)) = op.get("answers") {
                for (path, answer) in answers {
                    world
                        .answers
                        .set(path.clone(), answer.as_bool().unwrap_or(false));
                }
            }
            world.fail = field_str(op, "fail").map(str::to_owned);
            world.times = match op.get("now") {
                Some(Value::Array(times)) => times.iter().filter_map(Value::as_f64).collect(),
                Some(time) => time.as_f64().into_iter().collect(),
                None => VecDeque::new(),
            };
        }
        let paths = string_list(op.get("paths"))?;
        out.push(match cache.resolve(&paths) {
            Ok(resolved) => {
                json!({ "ok": serde_json::to_value(&resolved).expect("an answer prints") })
            }
            Err(ResolveFailure(message)) => json!({ "error": message }),
        });
    }
    cx.logs.append(&mut world.borrow_mut().logs);
    Ok(Some(Value::Array(out)))
}
