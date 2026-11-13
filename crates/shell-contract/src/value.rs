//! What crosses the IPC boundary: the subset of the structured clone that
//! Electron's IPC carries and the renderers use. JSON alone would lose
//! `undefined`, bytes, dates and non-finite numbers, and the compare harness
//! would see the difference.
//!
//! On the wire a message is one JSON header followed by its byte buffers;
//! the header's tags are listed in the contract document. A value a batch
//! meets that this enum cannot hold (a `Map`, a typed array other than bytes)
//! is a contract change, not a local workaround.

/// One value, in the order and shape the renderer sent or will receive it
#[derive(Clone, Debug, PartialEq)]
pub enum IpcValue {
    Undefined,
    Null,
    Bool(bool),
    /// any JavaScript number, `NaN`, the infinities and `-0` included
    Number(f64),
    String(String),
    Bytes(BytesKind, Vec<u8>),
    /// milliseconds since the epoch, as `Date.prototype.getTime`
    Date(f64),
    Array(Vec<IpcValue>),
    /// own enumerable keys in insertion order, as a JavaScript object keeps them
    Object(Vec<(String, IpcValue)>),
}

/// Which JavaScript type bytes come back as
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BytesKind {
    ArrayBuffer,
    /// also what a Node `Buffer` sent by the main process arrives as
    Uint8Array,
}
