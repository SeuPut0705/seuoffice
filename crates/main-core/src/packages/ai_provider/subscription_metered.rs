//! `packages/ai-provider/src/subscription/metered.ts`: "use anyway" for a
//! metered login.
//!
//! The user's choice is the boolean `AiSettings.meteredAccepted[provider]`. A
//! boolean alone cannot tell whether the login it was given for is still the
//! one in use, so next to the setting the app remembers one short value per
//! provider: the kind of login the acceptance was given for. The value is
//! always one of [`METERED_LOGIN_FINGERPRINTS`], a list of constants in code:
//! it is never built from what a CLI printed. An acceptance counts only while
//! the detected login has that same kind.

use std::rc::Rc;
use std::sync::LazyLock;

use jscompat::node_path::host;
use jscompat::{JsonValue, json_parse, json_stringify};

use super::jsval::{Obj, as_str, object, prop, text};
use super::providers::AI_SUBSCRIPTION_PROVIDERS;
use super::subscription_status::{
    SUBSCRIPTION_LOGIN_KINDS, SubscriptionDetection, subscription_login_kind,
};
use super::task::{FsAnswer, FsOp, JsError, LocalBoxFuture, Rt};

/// `MeteredAcceptanceStore`: per provider, the kind of login the metered
/// acceptance was given for (`MeteredAcceptanceRecord`, a `Partial<Record>`
/// as an object whose values are strings).
pub trait MeteredAcceptanceStore {
    fn read(&self) -> LocalBoxFuture<Result<Obj, JsError>>;
    fn write(&self, record: Obj) -> LocalBoxFuture<Result<(), JsError>>;
}

/// `SUBSCRIPTION_METERED_FILE`: file the acceptance record is kept in, inside
/// the directory the app passes
pub const SUBSCRIPTION_METERED_FILE: &str = "subscription-metered.json";

/// `METERED_LOGIN_FINGERPRINTS`: every value a remembered acceptance can
/// have: a non-subscription login method and a listed kind
pub static METERED_LOGIN_FINGERPRINTS: LazyLock<Vec<String>> = LazyLock::new(|| {
    ["metered", "unknown"]
        .iter()
        .flat_map(|login_method| {
            SUBSCRIPTION_LOGIN_KINDS
                .iter()
                .map(move |kind| format!("{login_method}:{kind}"))
        })
        .collect()
});

/// `meteredLoginFingerprint(detection)`: the kind of a metered (or unknown)
/// login, as remembered with an acceptance. `None` for anything that is not
/// a metered login.
pub fn metered_login_fingerprint(detection: &SubscriptionDetection) -> Option<String> {
    if detection.state != "metered" {
        return None;
    }
    // a detection can come from an injected detector: its kind is checked against the list again
    let login_method = if detection.login_method.as_deref() == Some("metered") {
        "metered"
    } else {
        "unknown"
    };
    Some(format!(
        "{login_method}:{}",
        subscription_login_kind(detection.login_kind.as_deref())
    ))
}

/// What [`reconcile_metered_acceptance`] answers
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MeteredOutcome {
    pub metered_accepted: bool,
    pub clear: bool,
}

/// `reconcileMeteredAcceptance(detection, stored)`: whether a stored
/// acceptance applies to the login just detected, and whether the stored
/// values must be cleared.
pub fn reconcile_metered_acceptance(
    detection: &SubscriptionDetection,
    stored_accepted: bool,
    fingerprint: Option<&str>,
) -> MeteredOutcome {
    let has_stored = stored_accepted || fingerprint.is_some_and(|f| !f.is_empty());
    // a check that could not tell says nothing about the login: keep what is stored
    if detection.state == "error" || detection.state == "not-installed" {
        return MeteredOutcome {
            metered_accepted: false,
            clear: false,
        };
    }
    let current = metered_login_fingerprint(detection);
    if let Some(current) = &current
        && stored_accepted
        && fingerprint == Some(current.as_str())
    {
        return MeteredOutcome {
            metered_accepted: true,
            clear: false,
        };
    }
    // signed out, a subscription now, another kind of metered login, or half a record
    MeteredOutcome {
        metered_accepted: false,
        clear: has_stored,
    }
}

/// `createMeteredAcceptanceFileStore(dir)`: the acceptance record as a small
/// JSON file in `dir` (the app's userData directory)
pub fn create_metered_acceptance_file_store(
    rt: &Rt,
    data_dir: &str,
) -> Rc<dyn MeteredAcceptanceStore> {
    Rc::new(FileStore {
        rt: rt.clone(),
        dir: data_dir.to_owned(),
        file: host::join(&[data_dir, SUBSCRIPTION_METERED_FILE]),
    })
}

struct FileStore {
    rt: Rt,
    dir: String,
    file: String,
}

impl MeteredAcceptanceStore for FileStore {
    fn read(&self) -> LocalBoxFuture<Result<Obj, JsError>> {
        let rt = self.rt.clone();
        let file = self.file.clone();
        Box::pin(async move {
            let mut record = Obj::new();
            let parsed = match rt.fs(FsOp::ReadFile { path: file }).await {
                Ok(FsAnswer::Bytes(bytes)) => json_parse(&String::from_utf8_lossy(&bytes)).ok(),
                _ => None,
            };
            let Some(parsed) = parsed else {
                return Ok(record);
            };
            if !matches!(parsed, JsonValue::Object(_) | JsonValue::Array(_)) {
                return Ok(record);
            }
            for provider in AI_SUBSCRIPTION_PROVIDERS {
                let value = prop(&parsed, provider);
                // anything else, a value an earlier build wrote included, is no acceptance
                if let Some(value) = as_str(value)
                    && METERED_LOGIN_FINGERPRINTS.iter().any(|f| f == value)
                {
                    record.set(provider, text(value));
                }
            }
            Ok(record)
        })
    }

    fn write(&self, record: Obj) -> LocalBoxFuture<Result<(), JsError>> {
        let rt = self.rt.clone();
        let dir = self.dir.clone();
        let file = self.file.clone();
        Box::pin(async move {
            let mut clean: Vec<(&str, JsonValue)> = Vec::new();
            for provider in AI_SUBSCRIPTION_PROVIDERS {
                if let Some(value) = as_str(record.get(provider))
                    && !value.is_empty()
                    && METERED_LOGIN_FINGERPRINTS.iter().any(|f| f == value)
                {
                    clean.push((provider, text(value)));
                }
            }
            rt.fs(FsOp::Mkdir {
                path: dir,
                recursive: true,
                mode: None,
            })
            .await?;
            let temp = format!("{file}.tmp");
            rt.fs(FsOp::WriteFile {
                path: temp.clone(),
                data: json_stringify(&object(clean)).into_bytes(),
                mode: None,
                flag: None,
            })
            .await?;
            rt.fs(FsOp::Rename {
                from: temp,
                to: file,
            })
            .await?;
            Ok(())
        })
    }
}
