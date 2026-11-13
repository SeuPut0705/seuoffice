//! `apps/shell/src/main/projects/project-files.ts`.
//!
//! Only `CloudOnlyResolver` is here for now: `cloud_cache` needs it. The rest
//! of the file is ported later and appended below.

use jscompat::JsMap;

/// What a resolver rejects with (`error.message`)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveFailure(pub String);

/// `CloudOnlyResolver`: `resolveCloudOnly` from cloud-files, one detector run
/// per call, `true` = not on this PC. The real resolver and the cache of
/// `cloud_cache` both implement it.
pub trait CloudOnlyResolver {
    fn resolve(&mut self, paths: &[String]) -> Result<JsMap<bool>, ResolveFailure>;
}
