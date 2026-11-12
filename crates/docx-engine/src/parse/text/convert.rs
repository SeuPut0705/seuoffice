//! The bridge between the engine's reader types and the model types: both
//! write the same JSON, so a value crosses as JSON, key order included (the
//! model types that are path-ordered read their keys in the order given).

use jscompat::JsNum;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::model;
use crate::package::Thrown;
use crate::resolve;

/// `value` as the JSON the TypeScript object would be.
pub fn json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// A number as `JSON.stringify` writes it (NaN and the infinities are null).
pub fn num(value: f64) -> Value {
    json(&JsNum(value))
}

/// `value` read as a model type.
pub fn bridge<T: Serialize, U: DeserializeOwned>(value: &T) -> Result<U, Thrown> {
    serde_json::from_value(json(value)).map_err(|error| error.to_string())
}

/// A JSON value read as a model type.
pub fn model_of<U: DeserializeOwned>(value: Value) -> Result<U, Thrown> {
    serde_json::from_value(value).map_err(|error| error.to_string())
}

/// The object of a JSON value (an empty one where it is none).
pub fn into_map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `Object.assign(target, source)` for JSON objects: a key set again keeps its place.
pub fn assign(target: &mut Map<String, Value>, source: Map<String, Value>) {
    for (key, value) in source {
        target.insert(key, value);
    }
}

/// The resolved paragraph as the model type.
pub fn eff_to_model(eff: &resolve::EffectivePPr) -> Result<model::EffectivePPr, Thrown> {
    bridge(eff)
}

/// The resolved run as the model type.
pub fn run_eff_to_model(eff: &resolve::EffectiveRPr) -> Result<model::EffectiveRPr, Thrown> {
    bridge(eff)
}
