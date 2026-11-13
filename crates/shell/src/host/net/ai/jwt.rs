//! `signatureValid(alg, data, signature, jwk)` of the ChatGPT sign-in
//! (`packages/ai-provider/src/chatgpt/oauth.ts`): `createPublicKey` of a JWK
//! and `verify('sha256', ...)` of `node:crypto`, for RS256 and ES256 over
//! ring. Like Node, the key is read first and a malformed one is an `Err`;
//! an `alg` that is neither is `Ok(false)` once the key was read, and so is
//! a signature that does not match.

use jscompat::{JsonValue, buffer_from_base64};
use ring::signature::{
    ECDSA_P256_SHA256_FIXED, RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents, UnparsedPublicKey,
};

/// A string member of the JWK
fn member<'a>(jwk: &'a JsonValue, name: &str) -> Option<&'a str> {
    match jwk {
        JsonValue::Object(object) => match object.get(name) {
            Some(JsonValue::String(value)) => Some(value),
            _ => None,
        },
        _ => None,
    }
}

/// A base64url member of the JWK as bytes; `None` when it is missing or empty
fn bytes_of(jwk: &JsonValue, name: &str) -> Option<Vec<u8>> {
    let bytes = buffer_from_base64(member(jwk, name)?);
    (!bytes.is_empty()).then_some(bytes)
}

pub fn signature_valid(
    alg: &str,
    data: &[u8],
    signature: &[u8],
    jwk: &JsonValue,
) -> Result<bool, String> {
    match member(jwk, "kty") {
        Some("RSA") => {
            let (Some(n), Some(e)) = (bytes_of(jwk, "n"), bytes_of(jwk, "e")) else {
                return Err("Invalid JWK RSA key".to_owned());
            };
            if alg != "RS256" {
                return Ok(false);
            }
            // ring refuses a modulus under 2048 bits as a failed verification
            Ok(RsaPublicKeyComponents { n, e }
                .verify(&RSA_PKCS1_2048_8192_SHA256, data, signature)
                .is_ok())
        }
        Some("EC") => {
            let (Some(x), Some(y)) = (bytes_of(jwk, "x"), bytes_of(jwk, "y")) else {
                return Err("Invalid JWK EC key".to_owned());
            };
            if member(jwk, "crv") != Some("P-256") {
                // a key of another curve is a key; ES256 is P-256 only
                return Ok(false);
            }
            if x.len() != 32 || y.len() != 32 {
                return Err("Invalid JWK EC key".to_owned());
            }
            if alg != "ES256" {
                return Ok(false);
            }
            // the uncompressed point, and the signature as `r || s` (ieee-p1363)
            let mut point = Vec::with_capacity(65);
            point.push(0x04);
            point.extend_from_slice(&x);
            point.extend_from_slice(&y);
            Ok(UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, point)
                .verify(data, signature)
                .is_ok())
        }
        _ => Err("Unsupported JWK Key Type.".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jscompat::json_parse;

    /// Made once offline with `openssl`: a 2048-bit RSA key and a P-256 key,
    /// each signing `DATA`
    const DATA: &str = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ.eyJpc3MiOiJ0ZXN0In0";
    const RSA_N: &str = "5H210OMo_Q-n6iqxrXj8JMVMAT7-rc41dvTtyDAfscyRqYVUMAFJbuy8Bjr6236dTeOfqnCe-YyCrDJHi0ZCvznxiLjI9HooZwtNIwZ7QNmNQdnx98fWJfvybXLEzuP1HPP-KcK4WRU6qfAOzdWqezCpUOdhVowMqDTP4qFa9RngZhhk3NGrcSIltUF0DJPceQsIYtrPn3CQ4OddjbsRJ4EIxKrrskD6qBbIxAxodIdHJs_KCcLEX-0FEaNV3AnIv__aYwaMXnev47wrDeQYrPBkpDNIqn36X5C0DYFygVI4hiNC9VRtMxeJVo5zKYTsFDjLMa6Fl4jtyb84hmVt1w";
    const RSA_SIG: &str = "D_sfNWE7lIbbjo2CFlVBTjgmYuN0NlLKpCANOlXjtnwdllH3N1EXXxGANNt3H1POmk0mIS2tu66cbB4mZiPIMVAf-qoOUdbOIEhCGEMywBRJF8mDHue0GJLuQ3PhV7PJCK8AJMuCGuiIcMPP8Nj5X1MDvbzqbpAn0-jmy489gswc7kZCujrvs6nNS6gOWZOCHkQAbABb4x1fnaPjeKO4sTt_ZW6Gsd1ivbQvosRy_FShY3lRvbAXmZYLm-CfBKE_R_PcXyb1E91IbctENbNhFqth9rJ4-IaB0MR4S1hZQ-ATF0K7oFbCzbo7D3FE_toKY_fWDRLX4hNOTcZgZpIcnw";
    const EC_X: &str = "PbFXTZ5oLGoFEnJ9wnvWa7vmm3Zs1vJRH_dKcqZlGI4";
    const EC_Y: &str = "_0FqK9SZ6rIwQ4NhfjLnKw3WGaJv_ZcEE6SZopC-Hmk";
    const EC_SIG: &str =
        "nb-HKc_PqlPc1fd2vDep0Ezb3hUg08CUmOX09T8QWRjjZVtJqOt26_WqgxzD3sMY8mMnL8KdKcs2cXFjWkVFsw";

    fn jwk(text: String) -> JsonValue {
        json_parse(&text).expect("a JWK")
    }

    fn rsa_key() -> JsonValue {
        jwk(format!(r#"{{"kty":"RSA","n":"{RSA_N}","e":"AQAB"}}"#))
    }

    fn ec_key() -> JsonValue {
        jwk(format!(
            r#"{{"kty":"EC","crv":"P-256","x":"{EC_X}","y":"{EC_Y}"}}"#
        ))
    }

    fn sig(text: &str) -> Vec<u8> {
        buffer_from_base64(text)
    }

    #[test]
    fn a_good_rs256_signature_is_valid_and_a_flipped_byte_is_not() {
        let good = sig(RSA_SIG);
        assert_eq!(
            signature_valid("RS256", DATA.as_bytes(), &good, &rsa_key()),
            Ok(true)
        );
        let mut flipped = good.clone();
        flipped[10] ^= 1;
        assert_eq!(
            signature_valid("RS256", DATA.as_bytes(), &flipped, &rsa_key()),
            Ok(false)
        );
        // the signature of other data
        assert_eq!(
            signature_valid("RS256", b"other", &good, &rsa_key()),
            Ok(false)
        );
    }

    #[test]
    fn a_good_es256_signature_is_valid_and_a_flipped_byte_is_not() {
        let good = sig(EC_SIG);
        assert_eq!(good.len(), 64);
        assert_eq!(
            signature_valid("ES256", DATA.as_bytes(), &good, &ec_key()),
            Ok(true)
        );
        let mut flipped = good.clone();
        flipped[40] ^= 1;
        assert_eq!(
            signature_valid("ES256", DATA.as_bytes(), &flipped, &ec_key()),
            Ok(false)
        );
        // not `r || s`: a short signature
        assert_eq!(
            signature_valid("ES256", DATA.as_bytes(), &good[..63], &ec_key()),
            Ok(false)
        );
    }

    #[test]
    fn an_algorithm_the_key_does_not_serve_is_false_once_the_key_was_read() {
        let rsa = sig(RSA_SIG);
        let ec = sig(EC_SIG);
        for alg in ["HS256", "none", "PS256", ""] {
            assert_eq!(
                signature_valid(alg, DATA.as_bytes(), &rsa, &rsa_key()),
                Ok(false)
            );
            assert_eq!(
                signature_valid(alg, DATA.as_bytes(), &ec, &ec_key()),
                Ok(false)
            );
        }
        // the other family's algorithm over a key that is valid
        assert_eq!(
            signature_valid("ES256", DATA.as_bytes(), &rsa, &rsa_key()),
            Ok(false)
        );
        assert_eq!(
            signature_valid("RS256", DATA.as_bytes(), &ec, &ec_key()),
            Ok(false)
        );
    }

    #[test]
    fn a_malformed_key_is_an_error() {
        let good = sig(RSA_SIG);
        for key in [
            r#"{"kty":"RSA","e":"AQAB"}"#,
            r#"{"kty":"RSA"}"#,
            r#"{"kty":"EC","crv":"P-256","x":"AAAA","y":"AAAA"}"#,
            r#"{"kty":"oct","k":"AAAA"}"#,
            r#"{}"#,
        ] {
            assert!(
                signature_valid("RS256", DATA.as_bytes(), &good, &jwk(key.to_owned())).is_err(),
                "{key}"
            );
        }
    }
}
