//! The Node-API side of the experiment. `call` is what a ported module would
//! answer: JSON in, JSON out, synchronously on the main thread. `pings` is the
//! other direction: a Rust thread asks JavaScript and waits for its answer.

use std::sync::mpsc;
use std::time::Instant;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

/// Parse the arguments and print them again: the work of a settings read
/// without the disk.
#[napi]
pub fn call(name: String, args: String) -> Result<String> {
    let value: serde_json::Value =
        serde_json::from_str(&args).map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(serde_json::json!({ "name": name, "value": value }).to_string())
}

/// Bytes in, the same bytes out.
#[napi]
pub fn call_bytes(data: Buffer) -> Buffer {
    data.to_vec().into()
}

/// A Rust thread calls `ask` `count` times, each time waiting until JavaScript
/// has answered; resolves with the round trip of each call in microseconds.
#[napi]
pub fn pings(ask: ThreadsafeFunction<u32, u32, u32, Status, false>, count: u32) -> AsyncTask<Pings> {
    AsyncTask::new(Pings { ask, count })
}

pub struct Pings {
    ask: ThreadsafeFunction<u32, u32, u32, Status, false>,
    count: u32,
}

impl Task for Pings {
    type Output = Vec<f64>;
    type JsValue = Vec<f64>;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut out = Vec::with_capacity(self.count as usize);
        for i in 0..self.count {
            let (tx, rx) = mpsc::channel();
            let start = Instant::now();
            self.ask.call_with_return_value(
                i,
                ThreadsafeFunctionCallMode::Blocking,
                move |answer: Result<u32>, _env| {
                    let _ = tx.send(answer.is_ok());
                    Ok(())
                },
            );
            rx.recv().map_err(|e| Error::from_reason(e.to_string()))?;
            out.push(start.elapsed().as_secs_f64() * 1e6);
        }
        Ok(out)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
