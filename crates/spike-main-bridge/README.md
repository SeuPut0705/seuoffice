# spike-main-bridge

An experiment for decision 0030, not part of the product: how the Electron
main process should call the Rust central process while Electron stays. Two
bridges answer the same three things:

- `call`: JSON of about 1 KB in (an `app-settings.json` of a used install),
  parsed and printed again, out. The shape of most of the main process's
  bookkeeping.
- `callBytes`: 1 MiB in and out. The shape of a document or an index passed
  through.
- `pings`: a Rust thread asks JavaScript and waits for the answer. The shape of
  an event from Rust (a watcher, a download) that needs the main process.

The Node-API bridge is `src/lib.rs` (napi-rs 3, a `.node` addon, synchronous
calls; `pings` through a thread-safe function). The sidecar is
`src/bin/sidecar.rs`, a child process with length-prefixed frames on stdin
and stdout.

## Run it

```sh
cargo build --release --manifest-path crates/spike-main-bridge/Cargo.toml
node crates/spike-main-bridge/bench.mjs 5
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron crates/spike-main-bridge/bench.mjs 5
for i in 1 2 3 4 5 6 7; do node crates/spike-main-bridge/start.mjs napi; node crates/spike-main-bridge/start.mjs sidecar; done
```

`bench.mjs` alternates the two bridges within each round and reports the
median of the rounds' medians. `start.mjs` measures one start in a fresh
process.

## Measured

Mac mini (darwin-arm64), 2026-11-12, release build, 5 rounds, the machine
shared with one other heavy job. Microseconds.

| What                              | Node 22.22.0 napi |     sidecar | Electron 43.8.3 napi |     sidecar |
| --------------------------------- | ----------------: | ----------: | -------------------: | ----------: |
| JS to Rust, 1 KB JSON, median     |              10.9 |        21.2 |                  9.6 |        23.4 |
| JS to Rust, 1 MiB bytes, median   |              88.3 |       1,146 |                  159 |       1,521 |
| Rust to JS and back, median       |               7.0 |        13.8 |                  4.5 |         7.3 |
| Rust to JS and back, p99          |              21.3 |        29.6 |                 90.3 |        44.5 |
| Start, steady (6 fresh processes) |       1,414-2,454 | 2,910-4,252 |            792-1,212 | 2,515-2,871 |
| Start, first after a build        |            20,164 |      21,586 |               23,740 |      18,361 |

The first `bench.mjs` run reported 297 ms (Node) and 318 ms (Electron) to
load the addon, and 267 ms to the sidecar's first answer. It copies the
library to a `.node` file just before loading it; a binary the system has not
seen is scanned on its first open. `start.mjs` loads the same file again and
shows the steady figure; the first open after a build still costs about
20 ms on both bridges. An installed app opens a signed file it has opened
before.

Sizes: the addon 612 KB, the sidecar 474 KB (release, LTO, not stripped).

What it shows: Node-API is two times faster for a small call, seven to ten
times for a megabyte, and starts in a third of the time. Both are far below
what a person notices for one call. What decides is the shape of the callers
(decision 0030): most of the main process reads its files synchronously, and
only Node-API can answer a synchronous call.

Not measured: Windows and Linux, a Mac x64 build, memory. The Electron p99 of
`pings` (90 us) is one round of 5; the medians agree.
