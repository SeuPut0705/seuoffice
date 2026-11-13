//! `apps/shell/src/shared/home-api.ts`: the decision-model part of the home
//! search contract that `file-index/decider.ts` and `rerank.ts` read:
//! `DecisionEndpoint`, `isCloudflareEndpoint`, `FileSearchSettings` and
//! `FileSearchRerank`. The rest of the file (the IPC channel names and the
//! renderer-facing interfaces) is plumbing that stays in TypeScript.

use jscompat::{JsObject, JsonValue};
use serde_json::{Map, Value, json};

/// The decision-model routes, each as its wire id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionEndpoint {
    Openrouter,
    Direct,
    Perplexity,
    PerplexityV12,
    PerplexityFlash,
    Liquid,
    LiquidUltra,
    Openai,
    Cloudflare,
    CloudflareFlash,
    Kev,
    Rizzo,
    Custom,
}

impl DecisionEndpoint {
    /// Every route, in the order `ENDPOINT_IDS` of `rerank.ts` lists them.
    pub const ALL: [DecisionEndpoint; 13] = [
        DecisionEndpoint::Openrouter,
        DecisionEndpoint::Direct,
        DecisionEndpoint::Perplexity,
        DecisionEndpoint::PerplexityV12,
        DecisionEndpoint::PerplexityFlash,
        DecisionEndpoint::Liquid,
        DecisionEndpoint::LiquidUltra,
        DecisionEndpoint::Openai,
        DecisionEndpoint::Cloudflare,
        DecisionEndpoint::CloudflareFlash,
        DecisionEndpoint::Kev,
        DecisionEndpoint::Rizzo,
        DecisionEndpoint::Custom,
    ];

    /// The string the TypeScript union holds.
    pub fn id(self) -> &'static str {
        match self {
            DecisionEndpoint::Openrouter => "openrouter",
            DecisionEndpoint::Direct => "direct",
            DecisionEndpoint::Perplexity => "perplexity",
            DecisionEndpoint::PerplexityV12 => "perplexity-v12",
            DecisionEndpoint::PerplexityFlash => "perplexity-flash",
            DecisionEndpoint::Liquid => "liquid",
            DecisionEndpoint::LiquidUltra => "liquid-ultra",
            DecisionEndpoint::Openai => "openai",
            DecisionEndpoint::Cloudflare => "cloudflare",
            DecisionEndpoint::CloudflareFlash => "cloudflare-flash",
            DecisionEndpoint::Kev => "kev",
            DecisionEndpoint::Rizzo => "rizzo",
            DecisionEndpoint::Custom => "custom",
        }
    }

    /// The route named `id`, `None` for any other string.
    pub fn from_id(id: &str) -> Option<DecisionEndpoint> {
        DecisionEndpoint::ALL
            .into_iter()
            .find(|endpoint| endpoint.id() == id)
    }

    fn index(self) -> usize {
        DecisionEndpoint::ALL
            .iter()
            .position(|endpoint| *endpoint == self)
            .expect("every route is in ALL")
    }
}

pub fn is_cloudflare_endpoint(endpoint: DecisionEndpoint) -> bool {
    endpoint == DecisionEndpoint::Cloudflare || endpoint == DecisionEndpoint::CloudflareFlash
}

/// `Record<DecisionEndpoint, string>`: one key per route, written in the order
/// of [`DecisionEndpoint::ALL`].
#[derive(Debug, Clone, PartialEq)]
pub struct EndpointKeys {
    keys: Vec<String>,
}

impl EndpointKeys {
    /// Every key empty.
    pub fn empty() -> EndpointKeys {
        EndpointKeys {
            keys: vec![String::new(); DecisionEndpoint::ALL.len()],
        }
    }

    pub fn get(&self, endpoint: DecisionEndpoint) -> &str {
        &self.keys[endpoint.index()]
    }

    pub fn set(&mut self, endpoint: DecisionEndpoint, key: String) {
        self.keys[endpoint.index()] = key;
    }

    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        for endpoint in DecisionEndpoint::ALL {
            out.insert(endpoint.id().to_owned(), Value::from(self.get(endpoint)));
        }
        Value::Object(out)
    }
}

/// `FileSearchSettings`.
#[derive(Debug, Clone, PartialEq)]
pub struct FileSearchSettings {
    pub rerank: bool,
    pub endpoint: DecisionEndpoint,
    pub keys: EndpointKeys,
    pub custom_base_url: String,
    pub custom_model: String,
    pub cloudflare_account_id: String,
    pub cloudflare_model: String,
}

impl FileSearchSettings {
    /// The object the TypeScript literal builds, its keys in that order.
    pub fn to_json(&self) -> Value {
        json!({
            "rerank": self.rerank,
            "endpoint": self.endpoint.id(),
            "keys": self.keys.to_json(),
            "customBaseUrl": self.custom_base_url,
            "customModel": self.custom_model,
            "cloudflareAccountId": self.cloudflare_account_id,
            "cloudflareModel": self.cloudflare_model,
        })
    }
}

/// `FileSearchRerank`: the judged paths best first, and each one's score.
#[derive(Debug, Clone, PartialEq)]
pub struct FileSearchRerank {
    pub order: Vec<String>,
    /// a JavaScript object keyed by path, so integer-like paths come first
    pub scores: JsObject<f64>,
}

impl FileSearchRerank {
    pub fn to_json(&self) -> Value {
        let mut scores = JsObject::<JsonValue>::new();
        for (path, score) in self.scores.entries() {
            scores.set(path, JsonValue::Number(*score));
        }
        let order = self.order.iter().map(|path| Value::from(path.as_str()));
        let mut out = Map::new();
        out.insert("order".into(), Value::Array(order.collect()));
        out.insert(
            "scores".into(),
            jscompat::json_value_to_serde(&JsonValue::Object(scores)),
        );
        Value::Object(out)
    }
}
