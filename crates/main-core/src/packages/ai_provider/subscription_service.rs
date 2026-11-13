//! `packages/ai-provider/src/subscription/service.ts`: the connection
//! statuses of the subscription providers as the app holds them: the last
//! answer of each CLI, combined with the user's stored acceptance of a
//! metered login. One instance lives in the main process; the IPC helper puts
//! it in front of the renderers.
//!
//! A status also carries two things for display that a CLI tells about a
//! login it is signed in with: the account, and the list of its models. The
//! list is read after the status and added when it arrives, so it never
//! delays or fails a check. It is read only for a login the app may use.
//!
//! ## Model
//!
//! The closure state of `createSubscriptionStatusService` is
//! [`SubscriptionStatusService`]'s own (a handle over one `Rc`); the service
//! is `Clone` and lives on the [`Rt`] it was made with. A status is a JSON
//! object (`AiSubscriptionStatus`), the map of them a JSON object keyed by
//! provider, in the order of `AI_SUBSCRIPTION_PROVIDERS`.
//!
//! What the TypeScript chains on promises runs as tasks of the runtime:
//!
//! - `acceptanceQueue` (`queued`) is a chain of completions: a call waits for
//!   the one queued before it, runs, and completes its own, whatever it
//!   returned;
//! - `inFlight` holds the awaitable of a check under way
//!   ([`Rt::deferred`], settled when the check ended);
//! - the model reading (`void Promise.resolve().then(...)`) is
//!   [`Rt::spawn_local`].
//!
//! The dependencies that read or write the app's settings are callbacks the
//! caller passes (`Rc<dyn Fn>` answering a future); an `Err` is a rejection.
//!
//! ## The order of the turns
//!
//! Calls the TypeScript makes on separate promises interleave their `await`s
//! one turn of the microtask queue at a time, and what the callbacks log
//! shows it. An `async` call here runs now up to its first `await`
//! ([`start_now`]) and each `await` that goes on a turn later is a
//! [`tick`]: `await` of a promise or a plain value is one; `.then`/`.catch`
//! chains and a promise that adopts another count their own (see each
//! site). A function whose result the TypeScript `await`s is not given the
//! turn here; its caller adds it.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsMap, JsonValue, json_stringify};

use super::jsval::{Obj, as_str, object, prop, prop2, spread, text, without};
use super::provider_selection::subscription_off_in;
use super::providers::AI_SUBSCRIPTION_PROVIDERS;
use super::subscription_contract::{
    checking_subscription_status, off_subscription_status, subscription_account_of,
    subscription_models_value_of, subscription_program_path_of, subscription_status_error_kind,
    subscription_status_error_text,
};
use super::subscription_launch::{
    LaunchState, SubscriptionOffChange, notify_subscription_off_change,
};
use super::subscription_metered::{
    MeteredAcceptanceStore, metered_login_fingerprint, reconcile_metered_acceptance,
};
use super::subscription_models::{SubscriptionModelListOptions, SubscriptionModelLister};
use super::subscription_status::{
    Fut, StatusState, SubscriptionDetectOptions, SubscriptionDetection, SubscriptionDetector,
    start_now, subscription_detector, tick,
};
use super::task::{JsError, Rt, Wait};

/// `deps.getSettings`: the AI settings as stored right now (Codex `cliPath`,
/// `meteredAccepted`, `subscriptionOff`)
pub type SettingsReader = Rc<dyn Fn() -> Fut<Result<JsonValue, JsError>>>;

/// `deps.setMeteredAccepted(provider, accepted)`, and `deps.setSubscriptionOff(provider, off)`
pub type SettingWriter = Rc<dyn Fn(String, bool) -> Fut<Result<(), JsError>>>;

/// `onChange`: called with a fresh copy whenever a status changes; an `Err`
/// is a listener that threw
pub type StatusListener = Rc<dyn Fn(&JsonValue) -> Result<(), JsError>>;

/// `SubscriptionStatusServiceDeps`
pub struct SubscriptionStatusServiceDeps {
    pub get_settings: SettingsReader,
    /// persist `AiSettings.meteredAccepted[provider]`
    pub set_metered_accepted: SettingWriter,
    /// persist `AiSettings.subscriptionOff[provider]`; absent where nothing
    /// may change it (the headless callers read the settings only)
    pub set_subscription_off: Option<SettingWriter>,
    /// where the kind of login an acceptance was given for is remembered
    pub acceptance_store: Rc<dyn MeteredAcceptanceStore>,
    /// `detectSubscriptionLogin` when absent
    pub detect: Option<SubscriptionDetector>,
    /// Reads the model list of a provider that can run. Absent: no list is
    /// read, and nothing beyond the status check is started.
    pub list_models: Option<SubscriptionModelLister>,
    pub on_change: Option<StatusListener>,
    pub timeout_ms: Option<f64>,
}

/// The answer of `setMeteredAccepted` and `setOff`: `{ ok, statuses }`
#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionServiceResult {
    pub ok: bool,
    pub statuses: JsonValue,
}

impl SubscriptionServiceResult {
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("ok", JsonValue::Bool(self.ok)),
            ("statuses", self.statuses.clone()),
        ])
    }
}

/// `status.state`
fn state_of(status: Option<&JsonValue>) -> String {
    status
        .and_then(|s| as_str(prop(s, "state")))
        .unwrap_or_default()
        .to_owned()
}

/// `status.meteredAccepted`
fn accepted_of(status: Option<&JsonValue>) -> bool {
    matches!(
        status.and_then(|s| prop(s, "meteredAccepted")),
        Some(JsonValue::Bool(true))
    )
}

/// `signedIn(detection)`: a login is known for these states: the account
/// belongs to them alone
fn signed_in(detection: &SubscriptionDetection) -> bool {
    detection.state == "ready" || detection.state == "metered"
}

/// `usable(status)`: a login the app may use: a subscription, or a metered
/// login the user said "use anyway" to. The model list is read and shown for
/// these alone. Reading it is no model call, but it starts the CLI on that
/// login, and a pay-per-use login nobody agreed to use is not started for it.
fn usable(state: &str, metered_accepted: bool) -> bool {
    state == "ready" || (state == "metered" && metered_accepted)
}

fn truthy_text(value: &Option<String>) -> Option<&String> {
    value.as_ref().filter(|v| !v.is_empty())
}

/// `toStatus(detection, meteredAccepted, models)`: a detection as the status
/// the contract defines: no field beyond those it lists
fn to_status(
    detection: &SubscriptionDetection,
    metered_accepted: bool,
    models: Option<&JsonValue>,
) -> JsonValue {
    // a detection can come from an injected detector: its account is checked again
    let account = if signed_in(detection) {
        subscription_account_of(detection.account.as_ref().map(|a| text(a.clone())).as_ref())
    } else {
        None
    };
    let program_path =
        if subscription_status_error_kind(&detection.state, detection.error.as_deref())
            == Some("needs-update")
        {
            subscription_program_path_of(
                detection
                    .program_path
                    .as_ref()
                    .map(|p| text(p.clone()))
                    .as_ref(),
            )
        } else {
            None
        };
    let accepted = detection.state == "metered" && metered_accepted;
    let mut out = Obj::new();
    out.set("provider", text(detection.provider.clone()));
    out.set("state", text(detection.state.clone()));
    if let Some(version) = truthy_text(&detection.version) {
        out.set("version", text(version.clone()));
    }
    if let Some(method) = truthy_text(&detection.login_method) {
        out.set("loginMethod", text(method.clone()));
    }
    if let Some(plan) = truthy_text(&detection.plan_name) {
        out.set("planName", text(plan.clone()));
    }
    if let Some(account) = account {
        out.set("account", text(account));
    }
    if usable(&detection.state, accepted)
        && let Some(models @ JsonValue::Array(list)) = models
        && !list.is_empty()
    {
        out.set("models", models.clone());
    }
    out.set("meteredAccepted", JsonValue::Bool(accepted));
    if detection.state == "error"
        && let Some(error) = truthy_text(&detection.error)
    {
        out.set("error", text(error.clone()));
    }
    if let Some(path) = program_path {
        out.set("programPath", text(path));
    }
    JsonValue::Object(out)
}

/// A `Set` holds a function once
fn same<T: ?Sized>(a: &Rc<T>, b: &Rc<T>) -> bool {
    std::ptr::addr_eq(Rc::as_ptr(a), Rc::as_ptr(b))
}

/// The closure variables of `createSubscriptionStatusService`
struct ServiceState {
    statuses: Obj,
    detections: JsMap<SubscriptionDetection>,
    /// the configured CLI path each of `detections` was made with
    detected_paths: JsMap<Option<String>>,
    in_flight: JsMap<Wait<()>>,
    /// the list each CLI gave last; kept for the process, replaced when a later reading differs
    models: JsMap<JsonValue>,
    /// counts the logins seen per provider: a list read for an earlier login is not used
    login_epoch: JsMap<u64>,
    /// the login a model reading under way belongs to
    model_reading: JsMap<u64>,
    listeners: Vec<StatusListener>,
    /// the end of the last queued change (`acceptanceQueue`)
    queue_tail: Option<Wait<()>>,
    /// logins the app started that are under way, laid over the detected statuses
    signing_in: JsMap<String>,
    /// logins the app started that ended without one, laid over the detected statuses
    login_unfinished: Vec<String>,
    /// why those logins ended, where the app knows
    login_failures: JsMap<JsonValue>,
}

/// `SubscriptionStatusService`
#[derive(Clone)]
pub struct SubscriptionStatusService {
    rt: Rt,
    deps: Rc<SubscriptionStatusServiceDeps>,
    detect: SubscriptionDetector,
    launch: LaunchState,
    st: Rc<RefCell<ServiceState>>,
}

/// `createSubscriptionStatusService(deps)`; `status` is the state the default
/// detector reads, `launch` the one `notifySubscriptionOffChange` tells.
pub fn create_subscription_status_service(
    rt: &Rt,
    launch: &LaunchState,
    status: &StatusState,
    deps: SubscriptionStatusServiceDeps,
) -> SubscriptionStatusService {
    let detect = deps
        .detect
        .clone()
        .unwrap_or_else(|| subscription_detector(status));
    let mut statuses = Obj::new();
    for provider in AI_SUBSCRIPTION_PROVIDERS {
        statuses.set(provider, checking_subscription_status(provider));
    }
    let mut listeners: Vec<StatusListener> = Vec::new();
    if let Some(on_change) = &deps.on_change {
        listeners.push(on_change.clone());
    }
    SubscriptionStatusService {
        rt: rt.clone(),
        deps: Rc::new(deps),
        detect,
        launch: launch.clone(),
        st: Rc::new(RefCell::new(ServiceState {
            statuses,
            detections: JsMap::new(),
            detected_paths: JsMap::new(),
            in_flight: JsMap::new(),
            models: JsMap::new(),
            login_epoch: JsMap::new(),
            model_reading: JsMap::new(),
            listeners,
            queue_tail: None,
            signing_in: JsMap::new(),
            login_unfinished: Vec::new(),
            login_failures: JsMap::new(),
        })),
    }
}

impl SubscriptionStatusService {
    /// `getStatuses()` / `snapshot()`: the last known statuses; `checking`
    /// for a provider no check has answered for yet
    pub fn get_statuses(&self) -> JsonValue {
        let st = self.st.borrow();
        let mut current = st.statuses.clone();
        for (provider, mode) in st.signing_in.iter() {
            let base = current.get(provider).cloned();
            // a program turned off has no login to show, even one still being ended
            if state_of(base.as_ref()) == "off" {
                continue;
            }
            let mut next = spread(base.as_ref());
            next.set("signingIn", text(mode.clone()));
            current.set(provider, JsonValue::Object(next));
        }
        for provider in &st.login_unfinished {
            // a login that is under way is not an unfinished one
            if st.signing_in.has(provider) {
                continue;
            }
            let base = current.get(provider).cloned();
            let mut next = spread(base.as_ref());
            next.set("loginUnfinished", JsonValue::Bool(true));
            if let Some(failure) = st.login_failures.get(provider) {
                next.set("loginFailure", JsonValue::Object(spread(Some(failure))));
            }
            current.set(provider.clone(), JsonValue::Object(next));
        }
        JsonValue::Object(current)
    }

    /// `announce()`: tell the listeners, each a fresh copy; one that throws
    /// must not stop the others
    fn announce(&self) {
        let current = self.get_statuses();
        let listeners: Vec<StatusListener> = self.st.borrow().listeners.clone();
        for listener in listeners {
            let _ = listener(&current);
        }
    }

    /// `queued(task)`: one change at a time (both providers share the settings
    /// and the acceptance file)
    async fn queued<T>(&self, task: impl Future<Output = T>) -> T {
        let (settle, done) = self.rt.deferred::<()>();
        let previous = self.st.borrow_mut().queue_tail.replace(done);
        if let Some(previous) = previous {
            previous.await;
        }
        // `acceptanceQueue.then(task, task)`: the task starts a turn after the queue is clear
        tick(&self.rt).await;
        let out = task.await;
        // the promise `then` answers adopts the task's in two turns; `run.catch(...)` clears
        // the queue, and the caller's `await run` goes on, a turn after that
        for _ in 0..3 {
            tick(&self.rt).await;
        }
        settle.settle(());
        out
    }

    /// `await Promise.resolve().then(() => deps.getSettings()).catch(() => null)`:
    /// the settings are read a turn after the call, and the `await` goes on two
    /// turns after that (the `catch` is a promise of its own)
    async fn settings_or_null(&self) -> Option<JsonValue> {
        tick(&self.rt).await;
        let read = (self.deps.get_settings)().await;
        tick(&self.rt).await;
        tick(&self.rt).await;
        read.ok()
    }

    /// `await promise`: the continuation runs a turn after the promise settled
    async fn after<T>(&self, promise: impl Future<Output = T>) -> T {
        let out = promise.await;
        tick(&self.rt).await;
        out
    }

    /// `await fn()` of a function that answers a plain value: a throw is no
    /// promise to wait for, so it costs no turn
    async fn after_sync<T>(
        &self,
        call: impl Future<Output = Result<T, JsError>>,
    ) -> Result<T, JsError> {
        let out = call.await;
        if out.is_ok() {
            tick(&self.rt).await;
        }
        out
    }

    fn epoch_of(&self, provider: &str) -> u64 {
        self.st
            .borrow()
            .login_epoch
            .get(provider)
            .copied()
            .unwrap_or(0)
    }

    fn bump_epoch(&self, provider: &str) {
        let next = self.epoch_of(provider) + 1;
        self.st.borrow_mut().login_epoch.set(provider, next);
    }

    /// `markOff(provider)`, in the queue: the CLI is off in this app, and
    /// what was known of its login is let go
    fn mark_off(&self, provider: &str) {
        {
            let mut st = self.st.borrow_mut();
            if state_of(st.statuses.get(provider)) == "off" {
                return;
            }
            st.statuses.set(provider, off_subscription_status(provider));
            st.detections.delete(provider);
            st.login_unfinished.retain(|p| p != provider);
            st.login_failures.delete(provider);
            // a list read under way, or kept, belongs to a login this app no longer looks at
            st.models.delete(provider);
        }
        self.bump_epoch(provider);
        self.announce();
    }

    async fn apply_detection(&self, detection: SubscriptionDetection) {
        self.queued(async {
            let provider = detection.provider.clone();
            let settings = self.settings_or_null().await;
            // turned off while the program was being asked: its answer is not used
            let off = match &settings {
                Some(settings) => subscription_off_in(settings, Some(&text(provider.clone()))),
                None => state_of(self.st.borrow().statuses.get(&provider)) == "off",
            };
            if off {
                self.mark_off(&provider);
                return;
            }
            let accepted = async {
                let Some(settings) = &settings else {
                    return Err(JsError::error("The settings could not be read"));
                };
                let record = self.after(self.deps.acceptance_store.read()).await?;
                let stored = matches!(
                    prop2(Some(settings), "meteredAccepted", &provider),
                    Some(JsonValue::Bool(true))
                );
                let fingerprint = as_str(record.get(&provider)).map(str::to_owned);
                let outcome =
                    reconcile_metered_acceptance(&detection, stored, fingerprint.as_deref());
                let accepted = outcome.metered_accepted;
                if outcome.clear {
                    if stored {
                        self.after_sync((self.deps.set_metered_accepted)(provider.clone(), false))
                            .await?;
                    }
                    if fingerprint.as_deref().is_some_and(|f| !f.is_empty()) {
                        let rest = without(&record, &[provider.as_str()]);
                        self.after(self.deps.acceptance_store.write(rest)).await?;
                    }
                }
                Ok::<bool, JsError>(accepted)
            }
            .await
            // an acceptance that cannot be read back is not an acceptance
            .unwrap_or(false);
            {
                let mut st = self.st.borrow_mut();
                st.detections.set(provider.as_str(), detection.clone());
                // a login was found: whatever the last one the app started did, it is over
                if signed_in(&detection) {
                    st.login_unfinished.retain(|p| p != &provider);
                    st.login_failures.delete(&provider);
                }
            }
            if detection.state == "signed-out" || detection.state == "not-installed" {
                // whoever signs in next gets a list of their own
                self.st.borrow_mut().models.delete(&provider);
                self.bump_epoch(&provider);
            }
            {
                let mut st = self.st.borrow_mut();
                let status = to_status(&detection, accepted, st.models.get(&provider));
                st.statuses.set(provider.as_str(), status);
            }
            self.announce();
        })
        .await
    }

    /// `refreshModels(provider)`: read the provider's model list, off to the
    /// side of the check or the acceptance that asked. The status is already
    /// out; the list is added to it, with a change event, only when it differs
    /// from the one at hand. One reading at a time, and none for a login the
    /// app may not use.
    fn refresh_models(&self, provider: &str) {
        let Some(list_models) = self.deps.list_models.clone() else {
            return;
        };
        let (state, accepted) = {
            let st = self.st.borrow();
            (
                state_of(st.statuses.get(provider)),
                accepted_of(st.statuses.get(provider)),
            )
        };
        if !usable(&state, accepted) {
            return;
        }
        let configured_path = self
            .st
            .borrow()
            .detected_paths
            .get(provider)
            .cloned()
            .flatten();
        let epoch = self.epoch_of(provider);
        if self.st.borrow().model_reading.get(provider).copied() == Some(epoch) {
            return;
        }
        self.st.borrow_mut().model_reading.set(provider, epoch);
        let this = self.clone();
        let provider = provider.to_owned();
        self.rt.spawn_local(async move {
            let read = list_models(
                this.rt.clone(),
                provider.clone(),
                SubscriptionModelListOptions {
                    configured_path,
                    timeout_ms: None,
                },
            )
            .await;
            // `.then(() => listModels(...))` answers a promise, which the next `.then`
            // adopts in two turns; the two `.then`s after it take one each
            for _ in 0..4 {
                tick(&this.rt).await;
            }
            let list = read.and_then(|value| subscription_models_value_of(&value));
            if this.st.borrow().model_reading.get(&provider).copied() == Some(epoch) {
                this.st.borrow_mut().model_reading.delete(&provider);
            }
            // read for a login that is gone, or nothing read: what is shown stays
            let Some(list) = list else {
                return;
            };
            if this.epoch_of(&provider) != epoch {
                return;
            }
            let kept = this.st.borrow().models.get(&provider).map(json_stringify);
            if kept.as_deref() == Some(json_stringify(&list).as_str()) {
                return;
            }
            this.st
                .borrow_mut()
                .models
                .set(provider.as_str(), list.clone());
            let (detection, state, accepted) = {
                let st = this.st.borrow();
                (
                    st.detections.get(&provider).cloned(),
                    state_of(st.statuses.get(&provider)),
                    accepted_of(st.statuses.get(&provider)),
                )
            };
            // the acceptance may have been taken back while the list was read
            let Some(detection) = detection else {
                return;
            };
            if !usable(&state, accepted) {
                return;
            }
            let status = to_status(&detection, accepted, Some(&list));
            this.st.borrow_mut().statuses.set(provider.as_str(), status);
            this.announce();
        });
    }

    /// `checkOne(provider)`: one check per provider at a time; a call while
    /// one runs gets that one's awaitable
    fn check_one(&self, provider: &str) -> Wait<()> {
        if let Some(running) = self.st.borrow().in_flight.get(provider) {
            return running.clone();
        }
        let this = self.clone();
        let name = provider.to_owned();
        // `(async () => ...)()` runs now, up to its first `await`
        let wait = start_now(&self.rt, async move {
            this.run_check(&name).await;
            // `.finally(() => inFlight.delete(provider))` runs a turn after the body ended
            tick(&this.rt).await;
            this.st.borrow_mut().in_flight.delete(&name);
            // and the promise `finally` answers takes two more to settle
            tick(&this.rt).await;
            tick(&this.rt).await;
        });
        self.st.borrow_mut().in_flight.set(provider, wait.clone());
        wait
    }

    /// The body of the task `checkOne` makes
    async fn run_check(&self, provider: &str) {
        let attempt: Result<Option<(Option<String>, SubscriptionDetection)>, JsError> = async {
            let mut settings = self.after_sync((self.deps.get_settings)()).await?;
            let name = text(provider);
            if subscription_off_in(&settings, Some(&name)) {
                // decided again in the queue: "use again" may have been saved since the read above
                let turned_on = self
                    .queued(async {
                        let now = self.settings_or_null().await;
                        if let Some(now) = now
                            && !subscription_off_in(&now, Some(&name))
                        {
                            return Some(now);
                        }
                        self.mark_off(provider);
                        None
                    })
                    .await;
                match turned_on {
                    None => return Ok(None),
                    Some(now) => settings = now,
                }
            }
            let configured_path = as_str(
                prop2(Some(&settings), "providers", provider).and_then(|p| prop(p, "cliPath")),
            )
            .map(str::to_owned);
            let detection = self
                .after((self.detect)(
                    self.rt.clone(),
                    provider.to_owned(),
                    SubscriptionDetectOptions {
                        configured_path: configured_path.clone(),
                        timeout_ms: self.deps.timeout_ms,
                        ..SubscriptionDetectOptions::default()
                    },
                ))
                .await?;
            Ok(Some((configured_path, detection)))
        }
        .await;
        let (configured_path, detection) = match attempt {
            Ok(Some(done)) => done,
            Ok(None) => return,
            // a fixed text: the message of the failure may carry what a CLI printed
            Err(_) => {
                let mut detection = SubscriptionDetection::new(provider, "error");
                detection.error = Some(subscription_status_error_text(
                    "failed",
                    "The status check failed",
                ));
                (None, detection)
            }
        };
        self.st
            .borrow_mut()
            .detected_paths
            .set(provider, configured_path);
        self.apply_detection(detection).await;
        self.refresh_models(provider);
    }

    /// `check(providers, options)`: ask the CLIs again (both, at the same
    /// time, unless `providers` narrows it) and answer the new statuses.
    /// Calls that overlap share one check, unless `fresh` asks for one of its
    /// own time: a check already under way may have asked the CLI before the
    /// change (a login or logout the app ran), so it is waited for, then the
    /// CLI is asked once more.
    pub async fn check(&self, providers: Option<&[String]>, fresh: bool) -> JsonValue {
        let wanted: Vec<String> = match providers {
            Some(list) if !list.is_empty() => list.to_vec(),
            _ => AI_SUBSCRIPTION_PROVIDERS
                .iter()
                .map(|p| (*p).to_owned())
                .collect(),
        };
        // `wanted.map(async (provider) => ...)`: each call runs now, up to its first `await`
        let waits: Vec<Wait<()>> = wanted
            .into_iter()
            .map(|provider| {
                let this = self.clone();
                start_now(&self.rt, async move {
                    // A check under way may have asked the CLI before this call: let it end. Whatever
                    // runs after that started after this call, so one wait and one check is all it takes.
                    if fresh {
                        let running = this.st.borrow().in_flight.get(&provider).cloned();
                        if let Some(running) = running {
                            running.await;
                        }
                        // `await inFlight.get(provider)`, a promise or `undefined`
                        tick(&this.rt).await;
                    }
                    this.check_one(&provider).await;
                    tick(&this.rt).await;
                })
            })
            .collect();
        // `await Promise.all(...)`: the combined promise settles a turn after the last
        // input, and the `await` goes on a turn after that
        for wait in waits {
            wait.await;
        }
        tick(&self.rt).await;
        tick(&self.rt).await;
        self.get_statuses()
    }

    fn refused(&self) -> SubscriptionServiceResult {
        SubscriptionServiceResult {
            ok: false,
            statuses: self.get_statuses(),
        }
    }

    /// `setMeteredAccepted(provider, accepted)`: record or withdraw "use
    /// anyway". Accepting is refused (`ok: false`) unless the provider's last
    /// detected state is `metered`.
    pub async fn set_metered_accepted(
        &self,
        provider: &str,
        accepted: bool,
    ) -> SubscriptionServiceResult {
        self.queued(async {
            let detection = self.st.borrow().detections.get(provider).cloned();
            let fingerprint = detection.as_ref().and_then(metered_login_fingerprint);
            if accepted && (detection.is_none() || fingerprint.is_none()) {
                return self.refused();
            }
            let written = async {
                let mut record = self.after(self.deps.acceptance_store.read()).await?;
                match (&fingerprint, accepted) {
                    (Some(fingerprint), true) => record.set(provider, text(fingerprint.clone())),
                    _ => record = without(&record, &[provider]),
                }
                self.after(self.deps.acceptance_store.write(record)).await?;
                self.after_sync((self.deps.set_metered_accepted)(
                    provider.to_owned(),
                    accepted,
                ))
                .await
            }
            .await;
            if written.is_err() {
                return self.refused();
            }
            if let Some(detection) = &detection {
                let mut st = self.st.borrow_mut();
                let status = to_status(detection, accepted, st.models.get(provider));
                st.statuses.set(provider, status);
            }
            self.announce();
            // a login the app may use from now on: its list was not read while it was not
            if accepted {
                self.refresh_models(provider);
            }
            SubscriptionServiceResult {
                ok: true,
                statuses: self.get_statuses(),
            }
        })
        .await
    }

    /// `clearMeteredAcceptance(provider)`: remove whatever acceptance is
    /// stored for the provider, the setting and the remembered kind of login,
    /// whatever login is detected. For a login or logout the app itself ran:
    /// "use anyway" was given for the login before it, and the kind of login
    /// cannot tell that one from another account of the same kind. Nothing is
    /// written, and nothing announced, when nothing was accepted.
    pub async fn clear_metered_acceptance(&self, provider: &str) {
        self.queued(async {
            // the status below still stops showing it as accepted
            let _ = async {
                // the remembered kind first: a flag left behind without it is no acceptance, and
                // the next check removes it
                let record = self.after(self.deps.acceptance_store.read()).await?;
                if as_str(record.get(provider)).is_some_and(|f| !f.is_empty()) {
                    self.after(
                        self.deps
                            .acceptance_store
                            .write(without(&record, &[provider])),
                    )
                    .await?;
                }
                let settings = self.after_sync((self.deps.get_settings)()).await?;
                if matches!(
                    prop2(Some(&settings), "meteredAccepted", provider),
                    Some(JsonValue::Bool(true))
                ) {
                    self.after_sync((self.deps.set_metered_accepted)(provider.to_owned(), false))
                        .await?;
                }
                Ok::<(), JsError>(())
            }
            .await;
            let detection = self.st.borrow().detections.get(provider).cloned();
            let accepted = accepted_of(self.st.borrow().statuses.get(provider));
            let Some(detection) = detection else {
                return;
            };
            if !accepted {
                return;
            }
            {
                let mut st = self.st.borrow_mut();
                let status = to_status(&detection, false, st.models.get(provider));
                st.statuses.set(provider, status);
            }
            self.announce();
        })
        .await
    }

    /// `setOff(provider, off)`: turn a CLI off in this app, or back on
    /// (decision 0114). Off is stored, then shown at once as `off`; the
    /// program is not asked anything. Back on, the provider reads `checking`
    /// and the program is asked again. `ok: false` when the setting could not
    /// be written (or no writer was given).
    pub async fn set_off(&self, provider: &str, off: bool) -> SubscriptionServiceResult {
        let Some(save) = self.deps.set_subscription_off.clone() else {
            return self.refused();
        };
        let result = self
            .queued(async {
                if self
                    .after_sync(save(provider.to_owned(), off))
                    .await
                    .is_err()
                {
                    return self.refused();
                }
                if off {
                    self.mark_off(provider);
                } else if state_of(self.st.borrow().statuses.get(provider)) == "off" {
                    self.st
                        .borrow_mut()
                        .statuses
                        .set(provider, checking_subscription_status(provider));
                    self.announce();
                }
                // before the program is asked again: what a bridge starts from now on follows the switch
                notify_subscription_off_change(
                    &self.launch,
                    &SubscriptionOffChange {
                        provider: provider.to_owned(),
                        off,
                    },
                );
                SubscriptionServiceResult {
                    ok: true,
                    statuses: self.get_statuses(),
                }
            })
            .await;
        // back on: the program is asked again, and its answer arrives as a change
        if result.ok && !off {
            drop(self.check_one(provider));
        }
        result
    }

    /// `isOff(provider)`: whether the provider is off in this app: its status
    /// says so, or the stored setting does (before the first check, the status
    /// still reads `checking`). The status alone when the settings cannot be
    /// read.
    pub async fn is_off(&self, provider: &str) -> bool {
        if state_of(self.st.borrow().statuses.get(provider)) == "off" {
            return true;
        }
        match self.settings_or_null().await {
            Some(settings) => subscription_off_in(&settings, Some(&text(provider))),
            None => false,
        }
    }

    /// `onChange(listener)`: answers the function that stops the listening
    pub fn on_change(&self, listener: StatusListener) -> Rc<dyn Fn()> {
        {
            let mut st = self.st.borrow_mut();
            if !st.listeners.iter().any(|known| same(known, &listener)) {
                st.listeners.push(listener.clone());
            }
        }
        let st = self.st.clone();
        Rc::new(move || {
            st.borrow_mut()
                .listeners
                .retain(|known| !same(known, &listener));
        })
    }

    /// `setSigningIn(provider, signingIn)`: mark a login the app started as
    /// under way (`browser`, `window`), or as over (`None`). The mark rides on
    /// the statuses handed out and is announced; it changes nothing that was
    /// detected.
    pub fn set_signing_in(&self, provider: &str, mode: Option<&str>) {
        if self
            .st
            .borrow()
            .signing_in
            .get(provider)
            .map(String::as_str)
            == mode
        {
            return;
        }
        {
            let mut st = self.st.borrow_mut();
            match mode.filter(|m| !m.is_empty()) {
                Some(mode) => st.signing_in.set(provider, mode.to_owned()),
                None => {
                    st.signing_in.delete(provider);
                }
            }
        }
        self.announce();
    }

    /// `setLoginUnfinished(provider, unfinished, failure)`: mark the last
    /// login the app started as one that ended without signing the CLI in (it
    /// exited, or ran past the limit for a browser sign-in nobody finished),
    /// or take the mark back. Like `signingIn` it rides on the statuses and
    /// changes nothing that was detected; a check that finds a sign-in clears
    /// it, and so does a new login. `failure` says why, when the app knows
    /// (its own ChatGPT sign-in); it rides along with the mark and goes with
    /// it.
    pub fn set_login_unfinished(
        &self,
        provider: &str,
        unfinished: bool,
        failure: Option<&JsonValue>,
    ) {
        let next = if unfinished { failure } else { None };
        {
            let st = self.st.borrow();
            let known = st.login_failures.get(provider);
            if st.login_unfinished.iter().any(|p| p == provider) == unfinished
                && known.map(json_stringify) == next.map(json_stringify)
            {
                return;
            }
        }
        {
            let mut st = self.st.borrow_mut();
            if unfinished {
                if !st.login_unfinished.iter().any(|p| p == provider) {
                    st.login_unfinished.push(provider.to_owned());
                }
            } else {
                st.login_unfinished.retain(|p| p != provider);
            }
            match next {
                Some(next) => st
                    .login_failures
                    .set(provider, JsonValue::Object(spread(Some(next)))),
                None => {
                    st.login_failures.delete(provider);
                }
            }
        }
        self.announce();
    }
}
