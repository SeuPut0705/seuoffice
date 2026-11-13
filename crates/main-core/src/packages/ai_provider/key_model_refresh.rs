//! `packages/ai-provider/src/key-model-refresh.ts`: when the main process asks
//! the key providers for their models, and how the answer reaches the
//! settings file.
//!
//! A provider is listed once per app run, and again whenever its key or base
//! URL changes. `providers.<id>.models` belongs to the main process.
//!
//! `withStoredKeyModels` and `withStoredMainFields` of the TypeScript file
//! live in `stored_settings.rs`, next to the settings code that shares their
//! helpers; they are not repeated here.
//!
//! The refresher of the TypeScript is [`KeyModelRefresher`]: its two
//! module-level collections (`askedWith`, `inFlight`) are its own state, and
//! the three dependencies are [`KeyModelRefresherDeps`], closures the caller
//! passes in. `withKeyProviderModels` answers `None` where the TypeScript
//! returns the very `settings` object it was given (nothing changed).

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsMap, JsonValue, json_stringify, trim};
use sha2::{Digest, Sha256};

use super::effort::ai_model_efforts_of;
use super::fetch::{AiFetch, KeyedFetchBase};
use super::jsval::{entries_of, js_string, prop, spread, text, without};
use super::key_models::{
    KeyListConfig, KeyModelListing, list_key_provider_model_listing, lists_key_provider_models,
};
use super::providers::listed_models_of;
use super::task::{Fetcher, JsError, LocalBoxFuture, Rt, Wait};

/// `fingerprintOf(config)`: what the list was asked with; a hash, so the key
/// itself is not kept beside the settings. A key or base URL that is neither
/// text nor nothing throws the `TypeError` of `.trim()` on it.
fn fingerprint_of(config: &JsonValue) -> Result<String, JsError> {
    let api_key = match prop(config, "apiKey") {
        Some(JsonValue::String(key)) => trim(key).to_owned(),
        None => {
            return Err(JsError::type_error(
                "Cannot read properties of undefined (reading 'trim')",
            ));
        }
        Some(JsonValue::Null) => {
            return Err(JsError::type_error(
                "Cannot read properties of null (reading 'trim')",
            ));
        }
        Some(_) => return Err(JsError::type_error("config.apiKey.trim is not a function")),
    };
    let base_url = match prop(config, "baseUrl") {
        Some(JsonValue::String(url)) => trim(url).to_owned(),
        None | Some(JsonValue::Null) => String::new(),
        Some(_) => {
            return Err(JsError::type_error(
                "config.baseUrl?.trim is not a function",
            ));
        }
    };
    let digest = Sha256::digest(format!("{api_key}\n{base_url}").as_bytes());
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

/// `(old ?? []).join('\n')`
fn join_models(old: Option<&JsonValue>) -> Result<String, JsError> {
    match old {
        None | Some(JsonValue::Null) => Ok(String::new()),
        Some(JsonValue::Array(items)) => Ok(items
            .iter()
            .map(|item| match item {
                JsonValue::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join("\n")),
        Some(_) => Err(JsError::type_error("(old ?? []).join is not a function")),
    }
}

/// `withKeyProviderModels(settings, provider, models, efforts)`: `settings`
/// with one provider's live list replaced; an empty list removes the field.
/// `None` when the list is unchanged: the TypeScript hands the same object
/// back, so the caller can skip a write that would change nothing. `efforts`
/// is the levels by id; `None` leaves the stored table as it is, an empty
/// one removes it.
pub fn with_key_provider_models(
    settings: &JsonValue,
    provider: &str,
    models: &[String],
    efforts: Option<&JsonValue>,
) -> Result<Option<JsonValue>, JsError> {
    // `settings.providers[provider]`
    let config = match prop(settings, "providers") {
        Some(providers) => prop(providers, provider),
        None => {
            return Err(JsError::type_error(format!(
                "Cannot read properties of undefined (reading '{provider}')"
            )));
        }
    };
    let Some(config) = config.filter(|c| c.truthy()) else {
        return Ok(None);
    };
    let old = prop(config, "models");
    let old_efforts = prop(config, "modelEfforts");
    let mut rest = without(&spread(Some(config)), &["models", "modelEfforts"]);
    let as_values = JsonValue::Array(models.iter().map(|m| text(m.clone())).collect());
    let listed = listed_models_of(Some(&as_values));
    let table = match efforts {
        None => ai_model_efforts_of(old_efforts),
        Some(efforts) => ai_model_efforts_of(Some(efforts)),
    };
    let listed_joined = listed.as_ref().map(|l| l.join("\n")).unwrap_or_default();
    let efforts_text =
        |value: Option<&JsonValue>| json_stringify(value.unwrap_or(&JsonValue::Null));
    if join_models(old)? == listed_joined
        && efforts_text(old_efforts) == efforts_text(table.as_ref())
    {
        return Ok(None);
    }
    if let Some(listed) = listed {
        rest.set(
            "models",
            JsonValue::Array(listed.into_iter().map(JsonValue::String).collect()),
        );
    }
    if let Some(table) = table {
        rest.set("modelEfforts", table);
    }
    let mut providers = spread(prop(settings, "providers"));
    providers.set(provider, JsonValue::Object(rest));
    let mut out = spread(Some(settings));
    out.set("providers", JsonValue::Object(providers));
    Ok(Some(JsonValue::Object(out)))
}

/// What a listing answers: a bare id list (replaced listings in tests) carries
/// no levels.
#[derive(Debug, Clone, PartialEq)]
pub enum ListAnswer {
    Models(Vec<String>),
    Listing(KeyModelListing),
}

/// `Promise<KeyModelListing | string[] | null>`
pub type ListFuture = LocalBoxFuture<Result<Option<ListAnswer>, JsError>>;

/// The update `write` applies to the settings file as it is at that moment:
/// `None` is "return `latest` itself".
pub type SettingsUpdate<'a> = &'a dyn Fn(&JsonValue) -> Result<Option<JsonValue>, JsError>;

/// `KeyModelRefresherDeps`
#[derive(Clone)]
pub struct KeyModelRefresherDeps {
    /// the settings file as it is now, keys opened
    pub read: Rc<dyn Fn() -> Result<JsonValue, JsError>>,
    /// write the settings the update returns, applied to the file as it is at
    /// that moment; a failure is swallowed
    pub write: Rc<dyn Fn(SettingsUpdate<'_>) -> Result<(), JsError>>,
    /// the listing; replaced in tests. `None`: `listKeyProviderModelListing`
    /// over the global `fetch`
    pub list: Option<Rc<dyn Fn(&str, &KeyListConfig) -> ListFuture>>,
}

#[derive(Default)]
struct RefresherState {
    /// per provider, what its key and base URL were when it was last asked
    /// (in this run)
    asked_with: JsMap<String>,
    /// the listings on their way, by an id of ours
    in_flight: Vec<(u64, Wait<()>)>,
    next: u64,
}

/// `KeyModelRefresher`
pub struct KeyModelRefresher {
    rt: Rt,
    fx: AiFetch,
    deps: KeyModelRefresherDeps,
    state: Rc<RefCell<RefresherState>>,
}

/// `createKeyModelRefresher(deps)`
pub fn create_key_model_refresher(
    rt: &Rt,
    fx: &AiFetch,
    deps: KeyModelRefresherDeps,
) -> KeyModelRefresher {
    KeyModelRefresher {
        rt: rt.clone(),
        fx: fx.clone(),
        deps,
        state: Rc::new(RefCell::new(RefresherState::default())),
    }
}

impl KeyModelRefresher {
    /// `refresh(provider, config, fingerprint)`
    fn refresh(&self, provider: &str, api_key: &str, base_url: Option<&str>, fingerprint: String) {
        let list_config = KeyListConfig {
            api_key: api_key.to_owned(),
            base_url: base_url.map(str::to_owned),
        };
        let listing: ListFuture = match &self.deps.list {
            Some(list) => list(provider, &list_config),
            None => {
                let rt = self.rt.clone();
                let fx = self.fx.clone();
                let provider = provider.to_owned();
                Box::pin(async move {
                    let base = KeyedFetchBase::Plain(Fetcher::Node);
                    Ok(
                        list_key_provider_model_listing(&rt, &fx, &provider, &list_config, &base)
                            .await?
                            .map(ListAnswer::Listing),
                    )
                })
            }
        };
        let id = {
            let mut state = self.state.borrow_mut();
            state.next += 1;
            state.next
        };
        let state = self.state.clone();
        let write = self.deps.write.clone();
        let provider = provider.to_owned();
        let run = async move {
            // `.then(answer => ...)`, then `.catch(() => undefined)`
            if let Ok(Some(answer)) = listing.await {
                let (models, efforts) = match &answer {
                    ListAnswer::Models(models) => (models.clone(), None),
                    ListAnswer::Listing(listing) => (
                        listing.models.clone(),
                        Some(JsonValue::Object(listing.efforts.clone())),
                    ),
                };
                let _ = write(&|latest: &JsonValue| {
                    // `latest.providers[provider]`
                    let Some(now) = prop(latest, "providers")
                        .and_then(|providers| prop(providers, &provider))
                        .filter(|c| c.truthy())
                    else {
                        return Ok(None);
                    };
                    // the key changed while the list was on its way: that
                    // key's list is not this one
                    if fingerprint_of(now)? != fingerprint {
                        return Ok(None);
                    }
                    with_key_provider_models(latest, &provider, &models, efforts.as_ref())
                });
            }
            // `.finally(() => inFlight.delete(run))`
            state.borrow_mut().in_flight.retain(|(n, _)| *n != id);
        };
        let wait = self.rt.share(run);
        self.state.borrow_mut().in_flight.push((id, wait));
    }

    /// `refreshChanged()`: list every key provider whose key or base URL is
    /// not the one it was last listed with.
    pub fn refresh_changed(&self) -> Result<(), JsError> {
        let Ok(settings) = (self.deps.read)() else {
            return Ok(());
        };
        let providers = prop(&settings, "providers").cloned();
        // `Object.entries(settings.providers ?? {})`
        let entries = providers.as_ref().map_or_else(Vec::new, entries_of);
        for (id, config) in entries {
            let api_key = prop(&config, "apiKey");
            let blank = |key: Option<&JsonValue>| -> Result<bool, JsError> {
                match key {
                    None | Some(JsonValue::Null) => Ok(true),
                    Some(JsonValue::String(k)) => Ok(trim(k).is_empty()),
                    Some(_) => Err(JsError::type_error("config.apiKey?.trim is not a function")),
                }
            };
            if !config.truthy() || !lists_key_provider_models(&id)? || blank(api_key)? {
                self.state.borrow_mut().asked_with.delete(&id);
                continue;
            }
            let fingerprint = fingerprint_of(&config)?;
            if self.state.borrow().asked_with.get(&id) == Some(&fingerprint) {
                continue;
            }
            self.state
                .borrow_mut()
                .asked_with
                .set(id.clone(), fingerprint.clone());
            let api_key = match api_key {
                Some(JsonValue::String(key)) => key.clone(),
                _ => String::new(),
            };
            let base_url = match prop(&config, "baseUrl") {
                Some(JsonValue::String(url)) => Some(url.clone()),
                _ => None,
            };
            self.refresh(&id, &api_key, base_url.as_deref(), fingerprint);
        }
        Ok(())
    }

    /// `idle()`: settles when no listing is in flight
    pub async fn idle(&self) {
        loop {
            let waits: Vec<Wait<()>> = self
                .state
                .borrow()
                .in_flight
                .iter()
                .map(|(_, wait)| wait.clone())
                .collect();
            if waits.is_empty() {
                return;
            }
            let futures: Vec<LocalBoxFuture<()>> = waits
                .into_iter()
                .map(|wait| Box::pin(async move { wait.await }) as LocalBoxFuture<()>)
                .collect();
            self.rt.join_all(futures).await;
        }
    }
}
