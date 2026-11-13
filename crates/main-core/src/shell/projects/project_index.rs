//! `apps/shell/src/main/projects/project-index.ts`: project folders in the
//! home search index (spec 5.8, 5.9). The functions here are handed to the
//! indexer and the reranker by `index.ts`:
//!
//! - `project_folder_roots` + `merge_index_roots`: the listed project folders
//!   join the indexer's roots (not the home folder list).
//! - `ProjectNameOnly`: inside a project folder, a file that is not on this PC
//!   is indexed by name only, so the indexer never opens (downloads) it. The
//!   rule goes by path: a project folder inside a home root gets it too, and
//!   a file outside every project folder is indexed exactly as before.
//! - `RerankIgnoreFilter`: what any project's `ignore` lists stays out of the
//!   excerpts the reranker sends out; the home results still show it.
//!
//! The functions `createProjectNameOnly` and `createRerankIgnoreFilter`
//! return are structs with one method each. `platform`, where the TypeScript
//! defaults it to `process.platform`, is `None` for the host's. The `Set` the
//! name-only source answers is a list without repeats, in the order the set
//! holds them.

use std::fs;

use super::paths::{is_inside_folder, relative_inside};
use super::project_files::{CloudOnlyResolver, thrown_limit};
use super::project_guide::ProjectAiVisibility;
use crate::node_fs::namespaced;
use crate::packages::ai_provider::agent_session_policy::process_platform;
use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::project_store::ProjectListItem;
use crate::shell::app_settings::read_projects_settings;

/// `projectFolderRoots(settingsPath)`: the listed project folders that exist
/// now (synchronous: the indexer asks once per scan)
pub fn project_folder_roots(settings_path: &str) -> Vec<String> {
    let mut out = Vec::new();
    for entry in read_projects_settings(settings_path).list {
        // a missing folder ("folder missing") is not walked
        if fs::metadata(namespaced(&entry.path)).is_ok_and(|info| info.is_dir()) {
            out.push(entry.path);
        }
    }
    out
}

/// `mergeIndexRoots(homeRoots, projectRoots, platform)`: the home roots
/// followed by the project folders that are not already inside one of them (or
/// listed twice), so a file is walked under one spelling only
pub fn merge_index_roots(
    home_roots: &[String],
    project_roots: &[String],
    platform: Option<&str>,
) -> Vec<String> {
    let platform = platform.unwrap_or(process_platform());
    let mut out: Vec<String> = home_roots.to_vec();
    for root in project_roots {
        if out
            .iter()
            .any(|kept| is_inside_folder(root, kept, platform))
        {
            continue;
        }
        out.push(root.clone());
    }
    out
}

/// `createProjectNameOnly(options)`: the indexer's `nameOnly` source: of a
/// scan's batch, the files inside a project folder that are not on this PC.
/// One detector run per batch, and none when no path is inside a project. A
/// detector that fails leaves every project path name-only (nothing gets
/// downloaded by mistake).
pub struct ProjectNameOnly<R> {
    project_roots: Box<dyn FnMut() -> Vec<String>>,
    resolve: R,
    platform: String,
}

impl<R: CloudOnlyResolver> ProjectNameOnly<R> {
    /// `options.projectRoots`, `options.resolveCloudOnly`, `options.platform`
    pub fn new(
        project_roots: Box<dyn FnMut() -> Vec<String>>,
        resolve: R,
        platform: Option<&str>,
    ) -> Self {
        ProjectNameOnly {
            project_roots,
            resolve,
            platform: platform.unwrap_or(process_platform()).to_owned(),
        }
    }

    /// the function `createProjectNameOnly` returns
    pub fn name_only(&mut self, paths: &[String]) -> Vec<String> {
        let roots = (self.project_roots)();
        if roots.is_empty() {
            return Vec::new();
        }
        let platform = self.platform.as_str();
        let inside: Vec<String> = paths
            .iter()
            .filter(|path| {
                roots
                    .iter()
                    .any(|root| is_inside_folder(path, root, platform))
            })
            .cloned()
            .collect();
        if inside.is_empty() {
            return Vec::new();
        }
        let kept: Vec<&String> = match self.resolve.resolve(&inside) {
            Ok(verdicts) => inside
                .iter()
                .filter(|path| verdicts.get(path) != Some(&false))
                .collect(),
            Err(_) => inside.iter().collect(),
        };
        // a Set: each path once, in the order it first came
        let mut set: Vec<String> = Vec::with_capacity(kept.len());
        for path in kept {
            if !set.contains(path) {
                set.push(path.clone());
            }
        }
        set
    }
}

/// `Pick<ProjectGuide, 'listProjects' | 'aiVisibility'>`
pub trait ProjectIndexGuide {
    /// `listProjects()`
    fn list_projects(&mut self) -> Result<Vec<ProjectListItem>, Thrown>;
    /// `aiVisibility(id)`: `None` (`null`) when the project is not listed
    fn ai_visibility(&mut self, id: &str) -> Result<Option<ProjectAiVisibility>, Thrown>;
}

/// `createRerankIgnoreFilter(options)`: the reranker's `sendable` filter: drops
/// each path that some project's `ignore` matches (read fresh per call). Paths
/// outside every project pass.
pub struct RerankIgnoreFilter<G> {
    guide: G,
    platform: String,
}

impl<G: ProjectIndexGuide> RerankIgnoreFilter<G> {
    /// `options.guide`, `options.platform`
    pub fn new(guide: G, platform: Option<&str>) -> Self {
        RerankIgnoreFilter {
            guide,
            platform: platform.unwrap_or(process_platform()).to_owned(),
        }
    }

    /// the function `createRerankIgnoreFilter` returns
    pub fn sendable(&mut self, paths: &[String]) -> Result<Vec<String>, Thrown> {
        let platform = self.platform.as_str();
        let projects: Vec<ProjectListItem> = self
            .guide
            .list_projects()?
            .into_iter()
            .filter(|project| !project.missing)
            .collect();
        let holding: Vec<&ProjectListItem> = projects
            .iter()
            .filter(|project| {
                paths
                    .iter()
                    .any(|path| is_inside_folder(path, &project.path, platform))
            })
            .collect();
        if holding.is_empty() {
            return Ok(paths.to_vec());
        }
        // `Promise.all` asks every project before it looks at an answer
        let asked: Vec<_> = holding
            .iter()
            .map(|project| self.guide.ai_visibility(&project.id))
            .collect();
        let mut rules: Vec<ProjectAiVisibility> = Vec::new();
        for answer in asked {
            if let Some(rule) = answer? {
                rules.push(rule);
            }
        }
        let mut sendable = Vec::new();
        for path in paths {
            let mut ignored = false;
            for rule in &rules {
                let Some(rel) = relative_inside(&rule.root, path, platform) else {
                    continue;
                };
                if rule.matcher.ignores(&rel, false).map_err(thrown_limit)? {
                    ignored = true;
                    break;
                }
            }
            if !ignored {
                sendable.push(path.clone());
            }
        }
        Ok(sendable)
    }
}
