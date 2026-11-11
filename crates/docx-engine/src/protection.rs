//! The w:documentProtection password hash (`protection.ts`), Word 2013+
//! scheme, the ECMA-376 iterated hash:
//!
//! ```text
//! h0 = H(salt || UTF-16LE(password))
//! hi = H(h(i-1) || LE32(i))   i = 0..spinCount-1
//! ```
//!
//! sid 14 is SHA-512, the only algorithm implemented. The TypeScript draws
//! the salt at random; here it is a parameter.

use std::fmt;

use jscompat::{JsNum, base64, number_to_string, to_number, trim, truthy};
use serde::Serialize;
use sha2::{Digest, Sha512};

/// Word's default iteration count for newly generated hashes.
pub const DEFAULT_SPIN_COUNT: f64 = 100_000.0;
/// Upper bound for untrusted spin counts read from a document: each one is a
/// digest, so a hostile file could stall the opener.
pub const MAX_SPIN_COUNT: f64 = 1_000_000.0;

/// A spin count as the TypeScript receives it: typed `unknown`, and a
/// string in practice where it comes from XML.
#[derive(Debug, Clone, PartialEq)]
pub enum SpinCount {
    /// `undefined` or `null`
    Missing,
    Number(f64),
    Text(String),
    /// Anything else (a boolean, an object), as `String(raw)` writes it.
    Other(String),
}

impl fmt::Display for SpinCount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => f.write_str("undefined"),
            Self::Number(number) => f.write_str(&number_to_string(*number)),
            Self::Text(text) | Self::Other(text) => f.write_str(text),
        }
    }
}

/// What `resolveSpinCount` throws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidSpinCount(pub String);

impl fmt::Display for InvalidSpinCount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid spinCount: {}", self.0)
    }
}

impl std::error::Error for InvalidSpinCount {}

/// `resolveSpinCount`: the default where the value is absent, the value where
/// it is a non-negative integer, clamped to [`MAX_SPIN_COUNT`].
pub fn resolve_spin_count(raw: &SpinCount) -> Result<f64, InvalidSpinCount> {
    let value = match raw {
        SpinCount::Missing => return Ok(DEFAULT_SPIN_COUNT),
        SpinCount::Text(text) if text.is_empty() => return Ok(DEFAULT_SPIN_COUNT),
        SpinCount::Text(text) => to_number(trim(text)),
        SpinCount::Number(number) => *number,
        SpinCount::Other(_) => return Err(InvalidSpinCount(raw.to_string())),
    };
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 {
        return Err(InvalidSpinCount(raw.to_string()));
    }
    Ok(value.min(MAX_SPIN_COUNT))
}

/// `atob` of Node: forgiving base64, white space skipped, `=` only at the
/// end and only where it pads. `None` where it throws.
fn from_base64(text: &str) -> Option<Vec<u8>> {
    const WHITE_SPACE: [char; 5] = ['\t', '\n', '\u{0C}', '\r', ' '];
    let mut sextets: Vec<u8> = Vec::with_capacity(text.len());
    let mut significant = 0usize;
    let mut equals = 0usize;
    for c in text.chars() {
        if WHITE_SPACE.contains(&c) {
            continue;
        }
        significant += 1;
        let sextet = match c {
            'A'..='Z' => c as u8 - b'A',
            'a'..='z' => c as u8 - b'a' + 26,
            '0'..='9' => c as u8 - b'0' + 52,
            '+' => 62,
            '/' => 63,
            '=' => {
                equals += 1;
                if equals > 2 {
                    return None;
                }
                continue;
            }
            _ => return None,
        };
        if equals > 0 {
            return None;
        }
        sextets.push(sextet);
    }
    let mut remainder = significant % 4;
    if remainder == 0 {
        remainder = (significant - equals) % 4;
    } else if equals > 0 {
        return None;
    }
    if remainder == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(sextets.len() * 3 / 4);
    let mut bits = 0u32;
    let mut held = 0u32;
    for sextet in sextets {
        bits = (bits << 6 | u32::from(sextet)) & 0xFFFF;
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
        }
    }
    Some(out)
}

fn iterated_sha512(password: &str, salt: &[u8], spin_count: f64) -> [u8; 64] {
    let mut first = Sha512::new();
    first.update(salt);
    for unit in password.encode_utf16() {
        first.update(unit.to_le_bytes());
    }
    let mut hash: [u8; 64] = first.finalize().into();
    // a resolved count: an integer from 0 to MAX_SPIN_COUNT
    for index in 0..spin_count as u32 {
        let mut next = Sha512::new();
        next.update(hash);
        next.update(index.to_le_bytes());
        hash = next.finalize().into();
    }
    hash
}

/// What `hashProtectionPassword` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionHash {
    pub hash: String,
    pub salt: String,
    pub spin_count: JsNum,
    pub algorithm_sid: JsNum,
}

/// `hashProtectionPassword`, with the salt the TypeScript draws at random
/// (16 bytes) given.
pub fn hash_protection_password(
    password: &str,
    spin_count: &SpinCount,
    salt: &[u8],
) -> Result<ProtectionHash, InvalidSpinCount> {
    let resolved = resolve_spin_count(spin_count)?;
    let hash = iterated_sha512(password, salt, resolved);
    Ok(ProtectionHash {
        hash: base64(&hash),
        salt: base64(salt),
        spin_count: JsNum(resolved),
        algorithm_sid: JsNum(14.0),
    })
}

/// The fields of a w:documentProtection or w:writeProtection record that
/// verification reads.
#[derive(Debug, Clone, PartialEq)]
pub struct ProtectionRecord {
    pub hash: Option<String>,
    pub salt: Option<String>,
    pub spin_count: SpinCount,
    pub algorithm_sid: Option<f64>,
}

/// `verifyProtectionPassword`: whether the password matches the record; no
/// hash is no password. Throws where the stored spin count is not a
/// non-negative integer.
pub fn verify_protection_password(
    password: &str,
    protection: &ProtectionRecord,
) -> Result<bool, InvalidSpinCount> {
    let Some(stored) = truthy(protection.hash.as_deref()) else {
        return Ok(true);
    };
    if protection.algorithm_sid.unwrap_or(14.0) != 14.0 {
        return Ok(false);
    }
    let Some(salt) = truthy(protection.salt.as_deref()) else {
        return Ok(false);
    };
    let numeric = match &protection.spin_count {
        SpinCount::Missing => Some(DEFAULT_SPIN_COUNT),
        SpinCount::Text(text) => Some(to_number(trim(text))),
        SpinCount::Number(number) => Some(*number),
        SpinCount::Other(_) => None,
    };
    if numeric.is_some_and(|spin| spin.is_finite() && spin > MAX_SPIN_COUNT) {
        return Ok(false);
    }
    let spin_count = resolve_spin_count(&protection.spin_count)?;
    let Some(salt) = from_base64(salt) else {
        return Ok(false);
    };
    Ok(base64(&iterated_sha512(password, &salt, spin_count)) == stored)
}
