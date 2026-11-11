use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A JavaScript number in a model value. It serializes the way
/// `JSON.stringify` writes it: NaN and the infinities as `null`, -0 as `0`.
#[derive(Debug, Clone, Copy, Default, PartialEq, PartialOrd)]
pub struct JsNum(pub f64);

impl Serialize for JsNum {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let x = self.0;
        if !x.is_finite() {
            serializer.serialize_unit()
        } else if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
            serializer.serialize_i64(x as i64)
        } else {
            serializer.serialize_f64(x)
        }
    }
}

impl<'de> Deserialize<'de> for JsNum {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        f64::deserialize(deserializer).map(JsNum)
    }
}
