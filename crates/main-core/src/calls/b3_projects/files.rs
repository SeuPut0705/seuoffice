//! Part `files` of group `b3-projects` (tools/main-diff/groups/
//! b3-projects-files.ts): `project-files.ts`, `project-index.ts`,
//! `project-tools.ts` and `project-dialog-text.ts`, and the pieces of
//! `knowledge-base.ts` and file-parse's `attachable.ts` they call.
//!
//! Each collaborator a case names is a fake that logs every call as one `logs`
//! line, written as the TypeScript fakes of the spec write it: a resolver
//! `{ answers?, fail? }`, a lister `{ files?, fail? }`, a visibility
//! `{ root, ignore?, fold?, ruleKey? }`. The scenarios (`createCachedFileLister`
//! and `ProjectFolderTools`) run a list of operations over one object. The
//! scopes of the tools scenario are a stand-in for `KbRunScopes`, the pages a
//! stand-in for `readKnowledgeFilePage` over `.txt`, `.md` and `.py` files (the
//! engine that parses other documents is not here: any other file is unreadable),
//! the index store and the download question are scripted.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::fs;
use std::rc::Rc;

use jscompat::node_path::host::{extname, join};
use jscompat::{
    JsMap, JsNum, JsObject, JsonValue, json_value_from_serde, json_value_to_serde,
    number_to_string, slice_utf16, to_iso_string,
};
use serde_json::{Map, Number, Value, json};

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::electron_utils::unsaved_files::{
    OpenFileState, OpenFilesHolder, OpenFilesSource, OpenFilesSourceFailed, assert_file_saved,
};
use crate::packages::file_parse::attachable::attachable_max_bytes;
use crate::packages::i18n::Lang;
use crate::packages::project_store::{
    ProjectFileEntry, ProjectId, ProjectListItem, ProjectTrustPrompt,
};
use crate::shell::knowledge_base::{KB_READ_MAX_BYTES, kb_read_max_bytes};
use crate::shell::projects::cloud_cache::CacheClock;
use crate::shell::projects::ignore::{IgnoreOptions, compile_ignore};
use crate::shell::projects::paths::canonical_path;
use crate::shell::projects::project_dialog_text::{
    IntlFormat, PROJECT_DIALOG_STRINGS, ProjectFolderPickPurpose, ProjectTrustChoice,
    TRUST_CHATS_SHOWN, TRUST_TEXT_SHOWN_CHARS, download_prompt_options, folder_picker_options,
    project_dialog_text, shown_excerpt, shown_text, trust_choice_of, trust_prompt_options,
    use_existing_prompt_options,
};
use crate::shell::projects::project_files::{
    CachedFileLister, CloudOnlyResolver, ContextFilesSource, ListVisibleFiles,
    PROJECT_CONTEXT_FILES_LIMIT, PROJECT_FILE_LIST_CACHE_MS, PROJECT_MENTION_FILES_LIMIT,
    ResolveFailure, VisibleFile, VisibleFileLister, list_ignored_files, list_visible_files,
    project_mention_files, slice_bounds, to_entry, with_cloud_flags,
};
use crate::shell::projects::project_guide::{ContextFilesRequest, ProjectAiVisibility};
use crate::shell::projects::project_index::{
    ProjectIndexGuide, ProjectNameOnly, RerankIgnoreFilter, merge_index_roots, project_folder_roots,
};
use crate::shell::projects::project_tools::{
    DownloadAsk, IndexHit, IndexSearchOptions, IndexSearchResult, IndexStore, KbReadPage,
    KnowledgePages, PROJECT_LIST_DEFAULT_LIMIT, PROJECT_SCOPE_UNKNOWN,
    PROJECT_SEARCH_DEFAULT_LIMIT, PROJECT_UNAVAILABLE, ProjectFolderTools, ProjectToolsDeps,
    ProjectToolsGuide, ProjectToolsScopes, ProjectToolsStore,
};

type Logs = Rc<RefCell<Vec<Vec<Value>>>>;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "project-files.PROJECT_CONTEXT_FILES_LIMIT" => Ok(Some(num(PROJECT_CONTEXT_FILES_LIMIT))),
        "project-files.PROJECT_FILE_LIST_CACHE_MS" => Ok(Some(num(PROJECT_FILE_LIST_CACHE_MS))),
        "project-files.PROJECT_MENTION_FILES_LIMIT" => Ok(Some(num(PROJECT_MENTION_FILES_LIMIT))),
        "project-files.listVisibleFiles" => make_vis(arg(args, 0))
            .and_then(|vis| list_visible_files(&vis).map_err(limit_error))
            .and_then(|files| print(&files)),
        "project-files.listIgnoredFiles" => make_vis(arg(args, 0))
            .and_then(|vis| list_ignored_files(&vis).map_err(limit_error))
            .and_then(|files| print(&files)),
        "project-files.withCloudFlags" => with_flags_call(args, cx),
        "project-files.toEntry" => {
            visible_file(arg(args, 0)).and_then(|file| print(&to_entry(&file)))
        }
        "project-files.projectMentionFiles" => mention_call(args, cx),
        "project-files.createContextFiles" => context_call(args, cx),
        "project-files.createCachedFileLister" => cached_lister_call(args, cx),

        "project-index.projectFolderRoots" => roots_call(args),
        "project-index.mergeIndexRoots" => merge_call(args),
        "project-index.createProjectNameOnly" => name_only_call(args, cx),
        "project-index.createRerankIgnoreFilter" => rerank_call(args, cx),

        "project-tools.PROJECT_SCOPE_UNKNOWN" => Ok(Some(Value::from(PROJECT_SCOPE_UNKNOWN))),
        "project-tools.PROJECT_UNAVAILABLE" => Ok(Some(Value::from(PROJECT_UNAVAILABLE))),
        "project-tools.PROJECT_LIST_DEFAULT_LIMIT" => Ok(Some(num(PROJECT_LIST_DEFAULT_LIMIT))),
        "project-tools.PROJECT_SEARCH_DEFAULT_LIMIT" => Ok(Some(num(PROJECT_SEARCH_DEFAULT_LIMIT))),
        "project-tools.ProjectFolderTools" => tools_call(args, cx),

        "project-dialog-text.PROJECT_DIALOG_STRINGS" => Ok(Some(dialog_strings())),
        "project-dialog-text.TRUST_TEXT_SHOWN_CHARS" => {
            Ok(Some(Value::from(TRUST_TEXT_SHOWN_CHARS)))
        }
        "project-dialog-text.TRUST_CHATS_SHOWN" => Ok(Some(Value::from(TRUST_CHATS_SHOWN))),
        "project-dialog-text.projectDialogText" => text_call(args),
        "project-dialog-text.shownText" => max_arg(args)
            .and_then(|max| str_arg(args, 0).map(|text| Some(Value::from(shown_text(text, max))))),
        "project-dialog-text.shownExcerpt" => max_arg(args).and_then(|max| {
            let shown = shown_excerpt(str_arg(args, 0)?, max);
            Ok(Some(json!({ "text": shown.text, "more": shown.more })))
        }),
        "project-dialog-text.trustPromptOptions" => trust_call(args),
        "project-dialog-text.trustChoiceOf" => number_arg(args, 0).map(|response| {
            Some(match trust_choice_of(response) {
                Some(ProjectTrustChoice::Answer(answer)) => Value::from(answer.as_str()),
                Some(ProjectTrustChoice::View) => Value::from("view"),
                None => Value::Null,
            })
        }),
        "project-dialog-text.downloadPromptOptions" => lang_arg(args, 0)
            .and_then(|lang| print(&download_prompt_options(lang, str_arg(args, 1)?))),
        "project-dialog-text.useExistingPromptOptions" => lang_arg(args, 0)
            .and_then(|lang| print(&use_existing_prompt_options(lang, str_arg(args, 1)?))),
        "project-dialog-text.folderPickerOptions" => picker_call(args),

        "knowledge-base.KB_READ_MAX_BYTES" => Ok(Some(num(KB_READ_MAX_BYTES))),
        "knowledge-base.kbReadMaxBytes" => {
            str_arg(args, 0).map(|path| Some(num(kb_read_max_bytes(path))))
        }
        "attachable.attachableMaxBytes" => {
            str_arg(args, 0).map(|ext| Some(num(attachable_max_bytes(ext))))
        }
        _ => return None,
    })
}

// ---- helpers ----

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

/// a number as the comparison prints it: a non-finite one is `null`
fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn number_arg(args: &[Value], i: usize) -> Result<f64, CallError> {
    arg(args, i)
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("a number"))
}

fn lang_arg(args: &[Value], i: usize) -> Result<Lang, CallError> {
    match str_arg(args, i)? {
        "en" => Ok(Lang::En),
        "ko" => Ok(Lang::Ko),
        _ => Err(bad("a language")),
    }
}

/// a field of an object spec, `None` where it is absent or `null`
fn field<'a>(spec: &'a Value, key: &str) -> Option<&'a Value> {
    spec.get(key).filter(|v| !v.is_null())
}

fn field_str<'a>(spec: &'a Value, key: &str) -> Option<&'a str> {
    field(spec, key).and_then(Value::as_str)
}

fn string_list(value: Option<&Value>) -> Result<Vec<String>, CallError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

fn print<T: serde::Serialize>(value: &T) -> Answer {
    Ok(Some(to_value(value)))
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("an answer prints")
}

fn limit_error(error: jscompat::RegexLimit) -> CallError {
    CallError::plain(error.to_string())
}

fn thrown(error: Thrown) -> CallError {
    CallError::plain(error.0)
}

fn log(logs: &Logs, line: Vec<Value>) {
    logs.borrow_mut().push(line);
}

fn flush(logs: &Logs, cx: &mut Context) {
    cx.logs.append(&mut logs.borrow_mut());
}

/// `{ ok }` or `{ error }` of one call
fn settled(result: Result<Value, Thrown>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(Thrown(message)) => json!({ "error": message }),
    }
}

/// the guide's `aiVisibility` of one rule: `{ root, ignore?, fold?, ruleKey? }`
fn make_vis(spec: Option<&Value>) -> Result<ProjectAiVisibility, CallError> {
    let spec = spec.ok_or_else(|| bad("a visibility"))?;
    let root = field_str(spec, "root").ok_or_else(|| bad("root"))?;
    let fold = field(spec, "fold")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let matcher = compile_ignore(
        field_str(spec, "ignore").unwrap_or(""),
        IgnoreOptions {
            case_insensitive: fold,
        },
    )
    .map_err(|error| CallError::plain(error.to_string()))?;
    Ok(ProjectAiVisibility {
        root: root.to_owned(),
        matcher,
        rule_key: field_str(spec, "ruleKey").map(str::to_owned),
    })
}

/// a listed file `{ path, relPath, ext, sizeBytes, mtimeMs, cloudOnly }`
fn visible_file(value: Option<&Value>) -> Result<VisibleFile, CallError> {
    let value = value.ok_or_else(|| bad("a file"))?;
    let text = |key: &str| {
        field_str(value, key)
            .map(str::to_owned)
            .ok_or_else(|| bad(key))
    };
    Ok(VisibleFile {
        path: text("path")?,
        entry: ProjectFileEntry {
            rel_path: text("relPath")?,
            ext: text("ext")?,
            size_bytes: field(value, "sizeBytes")
                .and_then(Value::as_u64)
                .ok_or_else(|| bad("sizeBytes"))?,
            mtime_ms: JsNum(
                field(value, "mtimeMs")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| bad("mtimeMs"))?,
            ),
            cloud_only: field(value, "cloudOnly")
                .and_then(Value::as_bool)
                .ok_or_else(|| bad("cloudOnly"))?,
        },
    })
}

/// `vf(path, relPath, mtimeMs)` of the spec: the lister's file
fn listed_file(path: String, rel_path: &str, mtime_ms: f64) -> VisibleFile {
    let ext = rel_path
        .rfind('.')
        .map_or(String::new(), |dot| rel_path[dot + 1..].to_lowercase());
    VisibleFile {
        path,
        entry: ProjectFileEntry {
            rel_path: rel_path.to_owned(),
            ext,
            size_bytes: 10,
            mtime_ms: JsNum(mtime_ms),
            cloud_only: false,
        },
    }
}

// ---- the fakes ----

/// a resolver `{ answers?, fail? }`: logs `[label, paths]`, then rejects with
/// `fail` or answers `answers`
struct FakeResolver {
    answers: JsMap<bool>,
    fail: Option<String>,
    label: &'static str,
    logs: Logs,
}

impl FakeResolver {
    fn new(spec: Option<&Value>, label: &'static str, logs: &Logs) -> Self {
        let mut answers: JsMap<bool> = JsMap::new();
        if let Some(Value::Object(entries)) = spec.and_then(|spec| spec.get("answers")) {
            for (path, answer) in entries {
                answers.set(path.clone(), answer.as_bool().unwrap_or(false));
            }
        }
        FakeResolver {
            answers,
            fail: spec
                .and_then(|spec| field_str(spec, "fail"))
                .map(str::to_owned),
            label,
            logs: Rc::clone(logs),
        }
    }
}

impl CloudOnlyResolver for FakeResolver {
    fn resolve(&mut self, paths: &[String]) -> Result<JsMap<bool>, ResolveFailure> {
        log(&self.logs, vec![Value::from(self.label), json!(paths)]);
        match &self.fail {
            Some(message) => Err(ResolveFailure(message.clone())),
            None => Ok(self.answers.clone()),
        }
    }
}

/// what a lister answers: the relative names it lists and its failure
#[derive(Default)]
struct ListerWorld {
    files: Vec<String>,
    fail: Option<String>,
}

/// a lister `{ files?, fail? }`: logs `["list", root]`, then rejects with
/// `fail` or answers the files, each at `<root>/<name>` with mtime 1000
struct FakeLister {
    world: Rc<RefCell<ListerWorld>>,
    logs: Logs,
}

impl FakeLister {
    fn of(spec: Option<&Value>, logs: &Logs) -> Result<Self, CallError> {
        let mut world = ListerWorld::default();
        if let Some(spec) = spec {
            if let Some(files) = field(spec, "files") {
                world.files = string_list(Some(files))?;
            }
            world.fail = field_str(spec, "fail").map(str::to_owned);
        }
        Ok(FakeLister {
            world: Rc::new(RefCell::new(world)),
            logs: Rc::clone(logs),
        })
    }
}

impl VisibleFileLister for FakeLister {
    fn list(&mut self, visibility: &ProjectAiVisibility) -> Result<Vec<VisibleFile>, Thrown> {
        log(
            &self.logs,
            vec![Value::from("list"), Value::from(visibility.root.as_str())],
        );
        let world = self.world.borrow();
        if let Some(message) = &world.fail {
            return Err(Thrown(message.clone()));
        }
        Ok(world
            .files
            .iter()
            .map(|name| listed_file(format!("{}/{name}", visibility.root), name, 1000.0))
            .collect())
    }
}

// ---- project-files ----

/// `[files, resolver]`
fn with_flags_call(args: &[Value], cx: &mut Context) -> Answer {
    let files: Vec<VisibleFile> = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list of files"))?
        .iter()
        .map(|file| visible_file(Some(file)))
        .collect::<Result<_, _>>()?;
    let logs = Logs::default();
    let mut resolver = FakeResolver::new(arg(args, 1), "resolve", &logs);
    let flagged = with_cloud_flags(&files, &mut resolver);
    flush(&logs, cx);
    print(&flagged)
}

/// `[vis, limit | null, lister | null]`
fn mention_call(args: &[Value], cx: &mut Context) -> Answer {
    let vis = make_vis(arg(args, 0))?;
    let limit = arg(args, 1).and_then(Value::as_f64);
    let logs = Logs::default();
    let mut lister: Box<dyn VisibleFileLister> = match arg(args, 2).filter(|spec| !spec.is_null()) {
        None => Box::new(ListVisibleFiles),
        Some(spec) => Box::new(FakeLister::of(Some(spec), &logs)?),
    };
    let result = project_mention_files(&vis, limit, &mut *lister);
    flush(&logs, cx);
    result.map_err(thrown).and_then(|files| print(&files))
}

/// `[{ limit?, resolve?, list? }, vis]`: `{ ok: { files, omitted } }` or `{ error }`
fn context_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?;
    let vis = make_vis(arg(args, 1))?;
    let logs = Logs::default();
    let resolver = FakeResolver::new(field(cfg, "resolve"), "resolve", &logs);
    let lister: Box<dyn VisibleFileLister> = match field(cfg, "list") {
        None => Box::new(ListVisibleFiles),
        Some(spec) => Box::new(FakeLister::of(Some(spec), &logs)?),
    };
    let mut source = ContextFilesSource::new(
        resolver,
        field(cfg, "limit").and_then(Value::as_f64),
        lister,
    );
    let request = ContextFilesRequest {
        id: "p".to_owned(),
        root: vis.root.clone(),
        visibility: vis,
    };
    let result = source.context_files(&request).map(|files| to_value(&files));
    flush(&logs, cx);
    Ok(Some(settled(result)))
}

/// what the clock of the cache scenario reads
struct ClockWorld {
    times: VecDeque<f64>,
    last: f64,
}

struct WorldClock(Rc<RefCell<ClockWorld>>);

impl CacheClock for WorldClock {
    fn now(&mut self) -> f64 {
        let mut world = self.0.borrow_mut();
        if let Some(time) = world.times.pop_front() {
            world.last = time;
        }
        world.last
    }
}

/// `[{ ttlMs? }, ops]`: an op is `{ vis, now, files?, fail? }` or `{ invalidate }`
fn cached_lister_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?;
    let ops = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let logs = Logs::default();
    let clock = Rc::new(RefCell::new(ClockWorld {
        times: VecDeque::new(),
        last: 0.0,
    }));
    let underlying = FakeLister::of(None, &logs)?;
    let world = Rc::clone(&underlying.world);
    let mut lister = CachedFileLister::new(
        field(cfg, "ttlMs").and_then(Value::as_f64),
        WorldClock(Rc::clone(&clock)),
        underlying,
    );
    let mut out: Vec<Value> = Vec::new();
    for op in ops {
        if let Some(root) = op.get("invalidate") {
            lister.invalidate(root.as_str());
            out.push(json!({ "invalidated": root }));
            continue;
        }
        {
            let mut world = world.borrow_mut();
            world.files = match field(op, "files") {
                Some(files) => string_list(Some(files))?,
                None => Vec::new(),
            };
            world.fail = field_str(op, "fail").map(str::to_owned);
        }
        clock.borrow_mut().times = match op.get("now") {
            Some(Value::Array(times)) => times.iter().filter_map(Value::as_f64).collect(),
            Some(time) => time.as_f64().into_iter().collect(),
            None => VecDeque::new(),
        };
        let vis = make_vis(op.get("vis"))?;
        let result = lister.list(&vis).map(|files| {
            Value::from(
                files
                    .iter()
                    .map(|file| file.entry.rel_path.clone())
                    .collect::<Vec<String>>(),
            )
        });
        out.push(settled(result));
    }
    flush(&logs, cx);
    Ok(Some(Value::Array(out)))
}

// ---- project-index ----

/// `[dir, settingsText | null]`: the text is written to `<dir>/app-settings.json` first
fn roots_call(args: &[Value]) -> Answer {
    let dir = str_arg(args, 0)?;
    let path = join(&[dir, "app-settings.json"]);
    if let Some(text) = arg(args, 1).and_then(Value::as_str) {
        fs::write(&path, text).map_err(|error| bad(&error.to_string()))?;
    }
    Ok(Some(Value::from(project_folder_roots(&path))))
}

/// `[homeRoots, projectRoots, platform]`
fn merge_call(args: &[Value]) -> Answer {
    let home = string_list(arg(args, 0))?;
    let projects = string_list(arg(args, 1))?;
    let platform = str_arg(args, 2)?;
    Ok(Some(Value::from(merge_index_roots(
        &home,
        &projects,
        Some(platform),
    ))))
}

/// `[{ roots, platform?, resolve? }, batches]`
fn name_only_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?;
    let batches = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("batches"))?;
    let roots = string_list(cfg.get("roots"))?;
    let logs = Logs::default();
    let roots_logs = Rc::clone(&logs);
    let mut name_only = ProjectNameOnly::new(
        Box::new(move || {
            log(&roots_logs, vec![Value::from("roots")]);
            roots.clone()
        }),
        FakeResolver::new(field(cfg, "resolve"), "resolve", &logs),
        field_str(cfg, "platform"),
    );
    let mut out: Vec<Value> = Vec::new();
    for batch in batches {
        let paths = string_list(Some(batch))?;
        out.push(settled(Ok(Value::from(name_only.name_only(&paths)))));
    }
    flush(&logs, cx);
    Ok(Some(Value::Array(out)))
}

/// the guide of the rerank filter: `{ projects, fail? }`
struct FakeIndexGuide {
    projects: Vec<Value>,
    fail: Option<String>,
    logs: Logs,
}

impl ProjectIndexGuide for FakeIndexGuide {
    fn list_projects(&mut self) -> Result<Vec<ProjectListItem>, Thrown> {
        log(&self.logs, vec![Value::from("listProjects")]);
        Ok(self
            .projects
            .iter()
            .map(|project| {
                let id = field_str(project, "id").unwrap_or_default();
                ProjectListItem {
                    id: id.to_owned(),
                    name: id.to_owned(),
                    path: field_str(project, "path").unwrap_or_default().to_owned(),
                    pinned: false,
                    last_used_at: "2026-01-01T00:00:00.000Z".to_owned(),
                    missing: field(project, "missing")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    unwritable: false,
                    sync_folder: false,
                }
            })
            .collect())
    }

    fn ai_visibility(&mut self, id: &str) -> Result<Option<ProjectAiVisibility>, Thrown> {
        log(
            &self.logs,
            vec![Value::from("aiVisibility"), Value::from(id)],
        );
        if self.fail.as_deref() == Some(id) {
            return Err(Thrown("guide failed".to_owned()));
        }
        let Some(project) = self
            .projects
            .iter()
            .find(|project| field_str(project, "id") == Some(id))
        else {
            return Ok(None);
        };
        let spec = json!({
            "root": field_str(project, "path").unwrap_or_default(),
            "ignore": field_str(project, "ignore").unwrap_or(""),
            "fold": field(project, "fold").and_then(Value::as_bool).unwrap_or(false),
        });
        make_vis(Some(&spec))
            .map(Some)
            .map_err(|e| Thrown(e.message))
    }
}

/// `[{ platform?, projects, fail? }, paths]`
fn rerank_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?;
    let paths = string_list(arg(args, 1))?;
    let logs = Logs::default();
    let guide = FakeIndexGuide {
        projects: cfg
            .get("projects")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        fail: field_str(cfg, "fail").map(str::to_owned),
        logs: Rc::clone(&logs),
    };
    let mut filter = RerankIgnoreFilter::new(guide, field_str(cfg, "platform"));
    let result = filter.sendable(&paths).map(Value::from);
    flush(&logs, cx);
    Ok(Some(settled(result)))
}

// ---- project-tools ----

/// `{ projects }` of the scenario: id -> `{ dir, ignore?, fold?, ruleKey?, fails? }`,
/// shared with the operation that removes a project
type Projects = Rc<RefCell<Map<String, Value>>>;

/// `$ROOT(name)` of a string: the canonical path of `<dir>/<name>`
fn expand_root(text: &str, dir: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find("$ROOT(") {
        out.push_str(&rest[..at]);
        let after = &rest[at + "$ROOT(".len()..];
        let word = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        if word > 0 && after[word..].starts_with(')') {
            out.push_str(&canonical_path(&join(&[dir, &after[..word]])));
            rest = &after[word + 1..];
        } else {
            out.push_str("$ROOT(");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// `expand(value)` of the spec: `$ROOT(name)` in every string and key
fn expand(value: &Value, dir: &str) -> Value {
    match value {
        Value::String(text) => Value::String(expand_root(text, dir)),
        Value::Array(items) => Value::Array(items.iter().map(|item| expand(item, dir)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (expand_root(key, dir), expand(item, dir)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// the guide of the tools scenario
struct FakeToolsGuide {
    projects: Projects,
    dir: String,
    logs: Logs,
}

impl ProjectToolsGuide for FakeToolsGuide {
    fn ai_visibility(&mut self, id: &str) -> Result<Option<ProjectAiVisibility>, Thrown> {
        log(
            &self.logs,
            vec![Value::from("aiVisibility"), Value::from(id)],
        );
        let projects = self.projects.borrow();
        let Some(project) = projects.get(id) else {
            return Ok(None);
        };
        if field(project, "fails").and_then(Value::as_bool) == Some(true) {
            return Err(Thrown("guide failed".to_owned()));
        }
        let root = canonical_path(&join(&[&self.dir, field_str(project, "dir").unwrap_or("")]));
        let mut spec = json!({
            "root": root,
            "ignore": field_str(project, "ignore").unwrap_or(""),
            "fold": field(project, "fold").and_then(Value::as_bool).unwrap_or(false),
        });
        if let Some(key) = field_str(project, "ruleKey") {
            spec["ruleKey"] = Value::from(key);
        }
        make_vis(Some(&spec))
            .map(Some)
            .map_err(|e| Thrown(e.message))
    }
}

/// `KB_SCOPE_UNKNOWN` of knowledge-base.ts
const KB_SCOPE_UNKNOWN: &str = "knowledge-base scope is not open";

/// `KB_SCOPES_MAX` of knowledge-base.ts
const KB_SCOPES_MAX: usize = 16;

/// the `KbRunScopes` methods the tools call, over a counter: scopes `scope-1`, ...
#[derive(Default)]
struct FakeScopes {
    held: JsMap<(i64, ProjectId)>,
    counter: u32,
}

impl ProjectToolsScopes for FakeScopes {
    fn open_project(&mut self, owner: i64, project_id: &str) -> String {
        self.counter += 1;
        let scope = format!("scope-{}", self.counter);
        self.held.set(scope.clone(), (owner, project_id.to_owned()));
        while self.held.len() > KB_SCOPES_MAX {
            let Some(oldest) = self.held.keys().next().map(str::to_owned) else {
                break;
            };
            self.held.delete(&oldest);
        }
        scope
    }

    fn close(&mut self, owner: i64, scope: Option<&JsonValue>) {
        if let Some(JsonValue::String(scope)) = scope
            && self.held.get(scope).is_some_and(|held| held.0 == owner)
        {
            self.held.delete(scope);
        }
    }

    fn project_of(&mut self, owner: i64, raw: &JsonValue) -> Result<Option<ProjectId>, Thrown> {
        let scope = match raw {
            JsonValue::Object(object) => object.get("scope"),
            _ => None,
        };
        let Some(scope) = scope else {
            return Ok(None);
        };
        let held = match scope {
            JsonValue::String(scope) => self.held.get(scope),
            _ => None,
        };
        match held {
            Some((held_owner, project)) if *held_owner == owner => Ok(Some(project.clone())),
            _ => Err(Thrown(KB_SCOPE_UNKNOWN.to_owned())),
        }
    }
}

/// a row the scripted index holds
struct IndexRow {
    path: String,
    name: String,
    ext: String,
    mtime_ms: f64,
    snippet: Option<Vec<String>>,
}

/// the scripted index: `{ rows, indexed, ignoreWithin? }`
struct FakeIndex {
    rows: Vec<IndexRow>,
    indexed: Vec<String>,
    ignore_within: bool,
    logs: Logs,
}

impl IndexStore for FakeIndex {
    fn search(
        &mut self,
        input: &str,
        options: &mut IndexSearchOptions<'_>,
    ) -> Result<IndexSearchResult, Thrown> {
        let mut shown = Map::new();
        shown.insert("offset".to_owned(), num(options.offset));
        shown.insert("limit".to_owned(), num(options.limit));
        if let Some(exts) = &options.exts {
            shown.insert("exts".to_owned(), json!(exts));
        }
        log(
            &self.logs,
            vec![
                Value::from("search"),
                Value::from(input),
                Value::Object(shown),
            ],
        );
        let mut kept: Vec<&IndexRow> = Vec::new();
        for row in &self.rows {
            let ext_ok = options
                .exts
                .as_ref()
                .is_none_or(|exts| exts.contains(&row.ext));
            if ext_ok && (self.ignore_within || (options.within)(&row.path)?) {
                kept.push(row);
            }
        }
        let range = slice_bounds(kept.len(), options.offset, options.offset + options.limit);
        Ok(IndexSearchResult {
            hits: kept[range]
                .iter()
                .map(|row| IndexHit {
                    path: row.path.clone(),
                    name: row.name.clone(),
                    ext: row.ext.clone(),
                    mtime_ms: row.mtime_ms,
                    snippet: row.snippet.clone(),
                })
                .collect(),
            total: kept.len() as u64,
        })
    }

    fn paths_indexed_as_on_disk(&mut self, paths: &[String]) -> Vec<String> {
        log(&self.logs, vec![Value::from("indexed"), json!(paths)]);
        paths
            .iter()
            .filter(|path| self.indexed.contains(path))
            .cloned()
            .collect()
    }
}

/// `store()` of the deps: the scripted index, or none
struct FakeStoreProvider(Option<FakeIndex>);

impl ProjectToolsStore for FakeStoreProvider {
    fn store(&mut self) -> Option<&mut dyn IndexStore> {
        self.0.as_mut().map(|index| index as &mut dyn IndexStore)
    }
}

/// `KB_READ_CHUNK_CHARS` of knowledge-base.ts
const KB_READ_CHUNK_CHARS: f64 = 24_000.0;

/// `readKnowledgeFilePage` over `.txt`, `.md` and `.py` files: the
/// unsaved-changes check, the size cap, the text as UTF-8, then the page.
/// Another file is unreadable: the engine that parses documents is not here.
struct FakePages {
    open_files: Rc<OpenFilesHolder>,
}

impl KnowledgePages for FakePages {
    fn read_page(&mut self, file_path: &str, offset: f64) -> Result<KbReadPage, Thrown> {
        assert_file_saved(&self.open_files, file_path)
            .map_err(|message| Thrown(message.to_owned()))?;
        let info = fs::metadata(file_path).map_err(|error| Thrown(error.to_string()))?;
        if info.len() as f64 > kb_read_max_bytes(file_path) {
            return Err(Thrown("file too large to read".to_owned()));
        }
        let extension = extname(file_path).to_lowercase();
        if ![".txt", ".md", ".py"].contains(&extension.as_str()) {
            return Err(Thrown("unreadable file".to_owned()));
        }
        let bytes = fs::read(file_path).map_err(|error| Thrown(error.to_string()))?;
        let text = String::from_utf8_lossy(&bytes);
        let length = text.encode_utf16().count() as f64;
        let start = if offset.is_finite() {
            offset.floor().max(0.0)
        } else {
            0.0
        };
        if start >= length {
            return Ok(KbReadPage {
                text: String::new(),
                total_chars: length as u64,
                offset: start,
            });
        }
        Ok(KbReadPage {
            text: slice_utf16(&text, start, Some(start + KB_READ_CHUNK_CHARS)),
            total_chars: length as u64,
            offset: start,
        })
    }
}

/// the open-file list the case names: none, `"throws"`, a list of dirty paths,
/// or `{ after, paths }` (none for the first `after` questions)
fn open_source(spec: &Value) -> Result<Option<OpenFilesSource>, CallError> {
    let dirty = |paths: &[String]| -> Vec<OpenFileState> {
        paths
            .iter()
            .map(|path| OpenFileState {
                file_path: Some(path.clone()),
                dirty: true,
            })
            .collect()
    };
    Ok(match spec {
        Value::Null => None,
        Value::String(_) => Some(Box::new(|| Err(OpenFilesSourceFailed))),
        Value::Array(_) => {
            let paths = string_list(Some(spec))?;
            Some(Box::new(move || Ok(dirty(&paths))))
        }
        Value::Object(_) => {
            let after = spec.get("after").and_then(Value::as_u64).unwrap_or(0);
            let paths = string_list(spec.get("paths"))?;
            let questions = Cell::new(0_u64);
            Some(Box::new(move || {
                questions.set(questions.get() + 1);
                Ok(if questions.get() > after {
                    dirty(&paths)
                } else {
                    Vec::new()
                })
            }))
        }
        _ => return Err(bad("open")),
    })
}

/// `[cfg, ops]`: see `ToolsCfg` and `ToolOp` of the spec
fn tools_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?;
    let ops = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let dir = field_str(cfg, "dir").ok_or_else(|| bad("dir"))?.to_owned();
    let platform = field_str(cfg, "platform").ok_or_else(|| bad("platform"))?;
    let logs = Logs::default();
    let projects: Projects = Rc::new(RefCell::new(
        cfg.get("projects")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    ));

    let store = match field(cfg, "store") {
        None => FakeStoreProvider(None),
        Some(store) => {
            let store = expand(store, &dir);
            let rows = store
                .get("rows")
                .and_then(Value::as_array)
                .ok_or_else(|| bad("rows"))?
                .iter()
                .map(|row| {
                    Ok(IndexRow {
                        path: field_str(row, "path")
                            .ok_or_else(|| bad("path"))?
                            .to_owned(),
                        name: field_str(row, "name")
                            .ok_or_else(|| bad("name"))?
                            .to_owned(),
                        ext: field_str(row, "ext").ok_or_else(|| bad("ext"))?.to_owned(),
                        mtime_ms: field(row, "mtimeMs")
                            .and_then(Value::as_f64)
                            .ok_or_else(|| bad("mtimeMs"))?,
                        snippet: match field(row, "snippet") {
                            None => None,
                            Some(parts) => Some(string_list(Some(parts))?),
                        },
                    })
                })
                .collect::<Result<Vec<IndexRow>, CallError>>()?;
            FakeStoreProvider(Some(FakeIndex {
                rows,
                indexed: string_list(store.get("indexed"))?,
                ignore_within: field(&store, "ignoreWithin")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                logs: Rc::clone(&logs),
            }))
        }
    };

    let ask = cfg.get("ask").cloned().unwrap_or(Value::Bool(false));
    let ask_logs = Rc::clone(&logs);

    let mut holder = OpenFilesHolder::new();
    holder.set_open_files_source(open_source(&expand(
        cfg.get("open").unwrap_or(&Value::Null),
        &dir,
    ))?);
    let holder = Rc::new(holder);

    let expanded_cloud = expand(cfg.get("cloud").unwrap_or(&Value::Null), &dir);
    let expanded_list_cloud = field(cfg, "listCloud").map(|spec| expand(spec, &dir));
    let mut tools = ProjectFolderTools::new(ProjectToolsDeps {
        guide: Box::new(FakeToolsGuide {
            projects: Rc::clone(&projects),
            dir: dir.clone(),
            logs: Rc::clone(&logs),
        }),
        scopes: Box::new(FakeScopes::default()),
        store: Box::new(store),
        resolve_cloud_only: Box::new(FakeResolver::new(
            Some(&expanded_cloud).filter(|spec| !spec.is_null()),
            "resolve",
            &logs,
        )),
        list_cloud_only: expanded_list_cloud.as_ref().map(|spec| {
            Box::new(FakeResolver::new(Some(spec), "list-resolve", &logs))
                as Box<dyn CloudOnlyResolver>
        }),
        list_files: None,
        ask_download: Box::new(move |question: &DownloadAsk| {
            log(&ask_logs, vec![Value::from("ask"), to_value(question)]);
            match &ask {
                Value::String(_) => Err(Thrown("ask failed".to_owned())),
                other => Ok(other.as_bool() == Some(true)),
            }
        }),
        pages: Box::new(FakePages {
            open_files: Rc::clone(&holder),
        }),
        platform: Some(platform.to_owned()),
    });

    let mut out: Vec<Value> = Vec::new();
    for raw in ops {
        let op = expand(raw, &dir);
        let result = run_op(&mut tools, &holder, &projects, &op)?;
        out.push(result);
    }
    flush(&logs, cx);
    Ok(Some(Value::Array(out)))
}

/// one operation of the tools scenario: `{ ok }` or `{ error }`
fn run_op(
    tools: &mut ProjectFolderTools,
    holder: &Rc<OpenFilesHolder>,
    projects: &Projects,
    op: &Value,
) -> Result<Value, CallError> {
    let owner = || {
        op.get("owner")
            .and_then(Value::as_i64)
            .ok_or_else(|| bad("owner"))
    };
    let raw = || json_value_from_serde(op.get("raw").unwrap_or(&Value::Null));
    let name = op
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("op"))?;
    Ok(match name {
        "openScope" => settled(tools.open_scope(owner()?, &raw()).map(Value::from)),
        "closeScope" => {
            tools.close_scope(owner()?, &raw());
            json!({ "ok": null })
        }
        "isAvailable" => {
            let id = json_value_from_serde(op.get("projectId").unwrap_or(&Value::Null));
            settled(tools.is_available(Some(&id)).map(Value::from))
        }
        "listFiles" => settled(tools.list_files(owner()?, &raw()).map(|r| to_value(&r))),
        "search" => settled(
            tools
                .search(holder, owner()?, &raw())
                .map(|result| to_value(&result)),
        ),
        "read" => settled(
            tools
                .read(holder, owner()?, &raw())
                .map(|result| to_value(&result)),
        ),
        "readPath" => settled(
            tools
                .read_path(
                    holder,
                    owner()?,
                    field_str(op, "projectId").ok_or_else(|| bad("projectId"))?,
                    field_str(op, "path").ok_or_else(|| bad("path"))?,
                    op.get("offset")
                        .and_then(Value::as_f64)
                        .ok_or_else(|| bad("offset"))?,
                )
                .map(|result| to_value(&result)),
        ),
        "visibleTest" => {
            let id = field_str(op, "projectId").ok_or_else(|| bad("projectId"))?;
            let paths = string_list(op.get("paths"))?;
            settled(tools.visible_test(id).and_then(|test| {
                match test {
                    None => Ok(Value::Null),
                    Some(test) => paths
                        .iter()
                        .map(|path| test.test(path).map(Value::from))
                        .collect::<Result<Vec<Value>, Thrown>>()
                        .map(Value::Array),
                }
            }))
        }
        "removeProject" => {
            let id = field_str(op, "id").ok_or_else(|| bad("id"))?;
            projects.borrow_mut().shift_remove(id);
            json!({ "ok": null })
        }
        _ => return Err(bad("an operation")),
    })
}

// ---- project-dialog-text ----

/// `PROJECT_DIALOG_STRINGS`: `{ en, ko }`, each its keys in table order
fn dialog_strings() -> Value {
    let mut en = Map::new();
    let mut ko = Map::new();
    for (key, en_text, ko_text) in PROJECT_DIALOG_STRINGS {
        en.insert((*key).to_owned(), Value::from(*en_text));
        ko.insert((*key).to_owned(), Value::from(*ko_text));
    }
    json!({ "en": Value::Object(en), "ko": Value::Object(ko) })
}

/// `[lang, key, params | null]`
fn text_call(args: &[Value]) -> Answer {
    let lang = lang_arg(args, 0)?;
    let key = str_arg(args, 1)?;
    let params: Option<JsObject<JsonValue>> = match arg(args, 2).filter(|params| !params.is_null())
    {
        None => None,
        Some(params) => match json_value_from_serde(params) {
            JsonValue::Object(object) => Some(object),
            _ => return Err(bad("params")),
        },
    };
    Ok(Some(Value::from(project_dialog_text(
        lang,
        key,
        params.as_ref(),
    ))))
}

/// `[text, max | null]`: the `max` of `shownText` and `shownExcerpt`
fn max_arg(args: &[Value]) -> Result<Option<usize>, CallError> {
    match arg(args, 1).filter(|max| !max.is_null()) {
        None => Ok(None),
        Some(max) => max
            .as_u64()
            .map(|max| Some(max as usize))
            .ok_or_else(|| bad("max")),
    }
}

/// the spec's `Intl`: `n:<lang>:<number>` and `d:<lang>:<ISO time>:medium/short`;
/// `numberThrows`, `dateThrows` and `bothThrow` make one or both throw
struct FakeIntl {
    number_throws: bool,
    date_throws: bool,
}

impl IntlFormat for FakeIntl {
    fn format_number(&self, count: f64, lang: Lang) -> Result<String, Thrown> {
        if self.number_throws {
            return Err(Thrown("number format".to_owned()));
        }
        Ok(format!("n:{}:{}", lang.as_str(), number_to_string(count)))
    }

    fn format_date_time(&self, at_ms: f64, lang: Lang) -> Result<String, Thrown> {
        if self.date_throws {
            return Err(Thrown("date format".to_owned()));
        }
        let iso = to_iso_string(at_ms).ok_or_else(|| Thrown("Invalid time value".to_owned()))?;
        Ok(format!("d:{}:{iso}:medium/short", lang.as_str()))
    }
}

/// `[lang, prompt, mode]`
fn trust_call(args: &[Value]) -> Answer {
    let lang = lang_arg(args, 0)?;
    let prompt: ProjectTrustPrompt =
        serde_json::from_value(arg(args, 1).cloned().unwrap_or(Value::Null))
            .map_err(|error| bad(&error.to_string()))?;
    let mode = str_arg(args, 2)?;
    let intl = FakeIntl {
        number_throws: mode == "numberThrows" || mode == "bothThrow",
        date_throws: mode == "dateThrows" || mode == "bothThrow",
    };
    print(&trust_prompt_options(lang, &prompt, &intl))
}

/// `[lang, purpose]`
fn picker_call(args: &[Value]) -> Answer {
    let lang = lang_arg(args, 0)?;
    let purpose = match str_arg(args, 1)? {
        "add" => ProjectFolderPickPurpose::Add,
        "relocate" => ProjectFolderPickPurpose::Relocate,
        "parent" => ProjectFolderPickPurpose::Parent,
        _ => return Err(bad("a purpose")),
    };
    Ok(Some(json_value_to_serde(&JsonValue::Object(
        folder_picker_options(lang, purpose),
    ))))
}
