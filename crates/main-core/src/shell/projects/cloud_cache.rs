//! `apps/shell/src/main/projects/cloud-cache.ts`: a "not on this PC" verdict
//! remembered for a while.
//!
//! The clock of the TypeScript (`options.now`, `Date.now` by default) is a
//! [`CacheClock`] the caller implements.

use jscompat::JsMap;

use super::project_files::{CloudOnlyResolver, ResolveFailure};

/// How long a "not on this PC" verdict is reused for the context file list
/// (spec 5.4 item 4). Every send reads the list; without this, each send would
/// start the detector program again. A file downloaded or freed meanwhile shows
/// its new state after this long. Reads (`project_read`) never use the cache:
/// they ask the detector right before opening a file.
pub const CONTEXT_CLOUD_CACHE_MS: f64 = 60_000.0;

/// `options.now`: the time in milliseconds since the epoch
pub trait CacheClock {
    fn now(&mut self) -> f64;
}

struct Known {
    at: f64,
    cloud_only: bool,
}

/// `createCachedCloudResolver(resolve, options)`: `resolve` with each path's
/// verdict remembered for `ttl_ms`. One call asks the detector once, for the
/// paths without a fresh verdict only. A failed run is not remembered (the
/// caller treats it as "not on this PC", the safe side).
pub struct CachedCloudResolver<R, C> {
    resolve: R,
    ttl: f64,
    clock: C,
    known: JsMap<Known>,
}

impl<R: CloudOnlyResolver, C: CacheClock> CachedCloudResolver<R, C> {
    /// `options.ttlMs` is `ttl_ms`; where it is `None` it is [`CONTEXT_CLOUD_CACHE_MS`]
    pub fn new(resolve: R, ttl_ms: Option<f64>, clock: C) -> Self {
        CachedCloudResolver {
            resolve,
            ttl: ttl_ms.unwrap_or(CONTEXT_CLOUD_CACHE_MS),
            clock,
            known: JsMap::new(),
        }
    }
}

impl<R: CloudOnlyResolver, C: CacheClock> CloudOnlyResolver for CachedCloudResolver<R, C> {
    fn resolve(&mut self, paths: &[String]) -> Result<JsMap<bool>, ResolveFailure> {
        let at = self.clock.now();
        let ttl = self.ttl;
        let expired = |entry: &Known| at - entry.at >= ttl;
        if self.known.iter().any(|(_, entry)| expired(entry)) {
            self.known = std::mem::take(&mut self.known)
                .into_iter()
                .filter(|(_, entry)| !expired(entry))
                .collect();
        }
        let mut out: JsMap<bool> = JsMap::new();
        let mut missing: JsMap<()> = JsMap::new();
        for path in paths {
            match self.known.get(path) {
                Some(entry) => out.set(path.clone(), entry.cloud_only),
                None => missing.set(path.clone(), ()),
            }
        }
        if !missing.is_empty() {
            let asked: Vec<String> = missing.keys().map(str::to_owned).collect();
            let fresh = self.resolve.resolve(&asked)?;
            let done_at = self.clock.now();
            for path in asked {
                let Some(&cloud_only) = fresh.get(&path) else {
                    continue;
                };
                self.known.set(
                    path.clone(),
                    Known {
                        at: done_at,
                        cloud_only,
                    },
                );
                out.set(path, cloud_only);
            }
        }
        Ok(out)
    }
}
