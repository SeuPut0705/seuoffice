//! `packages/ai-provider/src/protocols/shared.ts`: the error class of a
//! credits-exhausted notice. The rest of the file reads network streams and
//! is not ported.

use super::jsval::{ErrorClass, error_class};
use jscompat::JsonValue;

/// `err instanceof AiCreditsError`: a non-SSE reply whose text is the
/// gateway's credits-exhausted notice surfaces as this typed error.
pub fn is_ai_credits_error(err: &JsonValue) -> bool {
    error_class(err) == ErrorClass::AiCreditsError
}
