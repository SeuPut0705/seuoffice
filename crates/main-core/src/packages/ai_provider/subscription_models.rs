//! `packages/ai-provider/src/subscription/models.ts`: the models a
//! subscription CLI offers, asked of the CLI itself and without a model call:
//! Claude Code names them in its answer to the setup request, Codex through
//! its app-server's `model/list`. Each bridge registers how its list is read;
//! this file only bounds the asking, so the status service does not import
//! the bridges.
//!
//! A list is display data for the model picker. Reading it is never allowed
//! to hold up or fail a connection status: every failure here is "no list".
//!
//! The registry of sources (`sources`, a module `Map`) is
//! [`SubscriptionModelsState`], which the caller owns.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsMap, JsonValue};

use super::subscription_contract::subscription_models_value_of;
use super::task::{JsError, LocalBoxFuture, Rt, Signal};

/// `SUBSCRIPTION_MODELS_TIMEOUT_MS`: how long a CLI is given to list its models
pub const SUBSCRIPTION_MODELS_TIMEOUT_MS: f64 = 20_000.0;

/// `SubscriptionModelSource`: reads one CLI's model list. Supplied by that
/// CLI's bridge. It takes `configuredPath` (the configured path of the CLI,
/// as stored in the settings) and a signal that is aborted when the answer is
/// no longer waited for, and always once the reading is over: whatever the
/// source started must end with it.
pub type SubscriptionModelSource =
    Rc<dyn Fn(Option<String>, Signal) -> LocalBoxFuture<Result<Vec<JsonValue>, JsError>>>;

/// The module state of `models.ts`
#[derive(Default)]
pub struct SubscriptionModelsState {
    sources: JsMap<SubscriptionModelSource>,
}

/// `setSubscriptionModelSource(provider, source)`: let a bridge supply its
/// CLI's model list to the status check. `None` removes it.
pub fn set_subscription_model_source(
    state: &mut SubscriptionModelsState,
    provider: &str,
    source: Option<SubscriptionModelSource>,
) {
    match source {
        Some(source) => state.sources.set(provider, source),
        None => {
            state.sources.delete(provider);
        }
    }
}

/// `SubscriptionModelListOptions`
#[derive(Debug, Clone, Default)]
pub struct SubscriptionModelListOptions {
    /// the user's own path to the CLI (the `cliPath` setting)
    pub configured_path: Option<String>,
    pub timeout_ms: Option<f64>,
}

/// `SubscriptionModelLister`: the model list of one provider, or `None` when
/// there is none to show
pub type SubscriptionModelLister =
    Rc<dyn Fn(Rt, String, SubscriptionModelListOptions) -> LocalBoxFuture<Option<JsonValue>>>;

/// `listSubscriptionModels(provider, options)`: the models `provider`'s CLI
/// lists, through the source its bridge registered. Never fails: no bridge
/// loaded, a CLI too old to answer, a failure and an answer that outlasts
/// `timeoutMs` are all "no list". The list goes through
/// `subscriptionModelsOf`, so only its listed, bounded fields come back.
pub async fn list_subscription_models(
    rt: &Rt,
    state: &Rc<RefCell<SubscriptionModelsState>>,
    provider: &str,
    options: &SubscriptionModelListOptions,
) -> Option<JsonValue> {
    let source = state.borrow().sources.get(provider).cloned()?;
    let controller = rt.controller();
    let (settle, deadline_wait) = rt.deferred::<()>();
    let timer = rt.set_timeout(
        options.timeout_ms.unwrap_or(SUBSCRIPTION_MODELS_TIMEOUT_MS),
        move || settle.settle(()),
    );
    let deadline: LocalBoxFuture<Option<JsonValue>> = Box::pin(async move {
        deadline_wait.await;
        None
    });
    let configured_path = options.configured_path.clone();
    let signal = controller.clone();
    let listed: LocalBoxFuture<Option<JsonValue>> = Box::pin(async move {
        // the message of a failure is not kept: it may carry what the CLI printed
        match source(configured_path, signal).await {
            Ok(list) => subscription_models_value_of(&JsonValue::Array(list)),
            Err(_) => None,
        }
    });
    let (_, answer) = rt.race(vec![listed, deadline]).await;
    rt.clear_timeout(Some(timer));
    // ends whatever the source still has running, on a timeout and otherwise
    controller.abort(None);
    answer
}
