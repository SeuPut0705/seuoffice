//! The Node-API addon the Electron main process loads (decision 0029). One
//! export for now: `call`, the comparison's entry point, which runs a ported
//! function by its TypeScript name. The product's own exports come with the
//! first caller that switches.

use napi_derive::napi;

/// Runs `name` (`<module>.<function>`) with the arguments of `request`, a JSON
/// object `{ "args": [...], "now": <ms> }`, and answers the wire form of
/// `main_core::calls`: `{ "value" }`, `{}` for undefined, or `{ "error" }`,
/// with the lines the function logged under `"logs"`. A panic in the Rust
/// becomes a JavaScript `Error` here (`catch_unwind`, with the `node` profile
/// that unwinds), never the end of the Electron main process.
#[napi(catch_unwind)]
pub fn call(name: String, request: String) -> String {
    main_core::calls::call_json(&name, &request)
}
