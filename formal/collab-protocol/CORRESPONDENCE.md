# Correspondence: collab-protocol

Sync commit: `2a5d2d8c7168a3ade355d289de5940ba37ab3aec` (stamped by `verify-all.ts formal --only collab-protocol --stamp`, the same value as `syncCommit` in `formal/manifest.json`). The two fixes landed in `97d1fea` ("fix(collab): fence reconnects by attempt number and pin the two model-check findings"); between it and `2a5d2d8` the covered files only gained a display name (`welcome.name`, `status.self`), which no action reads. The `@code` line numbers are those of `2a5d2d8`.

History: the model was written first, from the design contract (`local://collab-design.md`, sections 2, 4, 5, workflow W3), before `packages/collab` existed. It found F1 and F2 in the design. The code then took both fixes, and the drift step (W6, 2026-11-10) compared every action with that commit. Each `@code` tag in `tla/CollabProtocol.tla` now names the `path:lines` of the handler it stands for.

## What the drift step changed in the model

| Change | Why (code at the sync commit) |
|---|---|
| `FenceHello` (abstract: refuse a hello older than every open socket) replaced by `AttemptFence` and a new server variable `welcomed[c]` | `hello.resume.attempt` is the engine's connection count (`engine.ts:286,295`); `decideHello` answers `superseded` when `resume.attempt < welcomed` (`decide.ts:61-64`); `welcome` records the attempt (`server.ts:403`). The join hello records attempt 0 (`decide.ts:74-81`), so `welcomed` starts at 0 |
| A refused hello on the client's current connection sends `superseded` there | `reject` answers on that socket (`server.ts:300-304`). The `SanityNoFencedHello` run shows the fence fires; `P4` shows it never fires on the current connection |
| `change`, `ack` and `stale` are handled only after `welcome` (`Joined`); one of them before `welcome` is a protocol error (`RecvEarly`) | `engine.ts:414-422`. `HelloAnsweredFirst` shows nothing reaches a socket before its welcome |
| Own change for a doomed in-flight, and an ack past `confirmed + 1` or for a doomed in-flight, are protocol errors (`RecvChangeError`, new `RecvAckError`) | `engine.ts:493`, `engine.ts:505`. Before, the model confirmed or ignored them. `FramesCovered` and the new `AcksCovered` show neither frame arrives |
| A submit carries a prefix of `pending`, not all of it | `submit` cuts `pending` into chunks of at most `SUBMIT_CHUNK_BYTES` (`engine.ts:582-601`); the model lets the prefix have any length |
| The link's `connectId` fence is now code, not an assumption | `collab-link.ts:36-49` drops every open, frame and close tagged with an older connect; `embed/src/collab.ts:116-124` forwards only the current connection's frames; `engine.ts:303-308` ignores frames while no connection is open. `Cut` carries these tags |

None of these changes broke a frozen property (see `evidence/matrix.log`). The frozen block of the spec is byte for byte the one frozen before modelling.

One consequence for the mutations: dropping the `base === head` check used to fail P2 (the doomed client took the ack of a submit appended on a stale base as its own confirmation) and P1 (it then resent the same ops). The engine's error branches, which the model now includes (`engine.ts:493`, `505`), refuse that ack and that own change, so the same server bug now leaves the client reconnecting with its edit unsent: it fails P4 and `AcksCovered`, and the two mutations name those. P2 got a mutation of its own (`confirm-reports-pending`). That is a change of `breaks`, made after reading the new counterexample (P4 at depth 17, `RecvAckError(c1)` at step 11), not to make a run pass.

## Map

| Model element | Code | Kind | Abstraction | Notes |
|---|---|---|---|---|
| `log` | `StoredEpoch.log`, `store.ts:95-107` | variable | a change is `[c, s, b, ops]`; `author` and the epoch are left out; `b` is model-only bookkeeping for P5 | one epoch, never reset |
| `open[c]` | sockets of client `c` in stage `live` (`server.ts:237-239`) | variable | a socket is its connection number | the server never notices a close here: a close it notices only makes later frames of that socket "never delivered" |
| `welcomed[c]` | `EpochState.clients.get(client).attempt` (`server.ts:146,403`) | variable | per process; a second process (A8) does not share it | |
| `c2s[c][k]` | frames client `c` sent on connection `k` | variable | one in-order queue per connection | old connections keep their queue: late delivery |
| `s2c[c]` | frames toward the engine's current connection | variable | frames toward any other connection are dropped at once | the connectId fence (`Cut` tags) |
| `SrvHello(c, k)` | `decide.ts:58-73`, `server.ts:352-364`, `391-425`, `428-443`, `300-304` | action | welcome plus the whole catch-up is one step; no `need_base`/`base`/`peers` frames | assumption A2 |
| `SrvSubmit(c, k)` | `decide.ts:88-99`, `store.ts:95-107`, `server.ts:463-507` | action | `canEdit` everywhere, no frame too large, store never fails | duplicate checked before base, as `store.ts:100-101`; the catch-up before `ack`/`stale` never sends anything in one process (every live socket is at head) |
| `SrvIgnore(c, k)` | `server.ts:548-549` | action | | |
| `MakeOp(c)` | `engine.ts:325-331` | action | one op per step; ops are ids `<<c, i>>` | |
| `SendNext(c)` | `engine.ts:578-603` | action | any non-empty prefix of `pending`; a separate step after every handler | `settle` runs `submit` at the end of every event: the model only adds interleavings; `waitFor` and `held` not modeled (below) |
| `AckEffects` | `engine.ts:519-525` | operator | | |
| `DropEffects` | `engine.ts:650-676` | operator | the strike count that fails the session after 3 errors is not modeled | every error action is unreachable (coverage) |
| `RecvWelcome(c)` | `engine.ts:447-467` | action | `catchHead` is `target` | the resumed welcome's epoch, client and start checks (`engine.ts:451`) always pass in the model |
| `RecvEarly(c)` | `engine.ts:414-422` | action | | unreachable |
| `RecvChangeOld`, `RecvChangeMine`, `RecvChangeForeign`, `RecvChangeError` | `engine.ts:486-499`, `523-530`, `328-330` | actions | a change frame carries only `v`; the client reads the immutable `log[v]`; `integrate` and the `integrated` event are one step | the engine guarantees the `integrated` event comes back before any other (`engine.ts:11-13`) |
| `RecvAck`, `RecvAckOther`, `RecvAckError` | `engine.ts:501-508` | actions | | |
| `RecvStale`, `RecvStaleOther` | `engine.ts:510-517` | actions | `waitFor` is not a variable | `StaleAfterCatchUp` shows `confirmed >= stale.head` when the stale is handled, and `confirmed` never decreases, so `waitFor` never blocks |
| `RecvSuperseded(c)` | `engine.ts:431-432`, `626-638` | action | | |
| `CaughtUp(c)` | `engine.ts:469-484` | action | a step of its own; the code runs it inside the welcome and change handlers | only adds interleavings |
| `Reconnect(c)` | `engine.ts:309-312`, `278-295` | action | backoff is fairness, not time; a connect that fails before `open` is a `Cut` after the hello | a cut after the hello is the harder case: its hello may still arrive |
| `Cut(c)` | `collab-link.ts:36-49`, `embed/src/collab.ts:116-124`, `engine.ts:300-308` | action (environment) | at most `MaxCuts` in the whole run | |
| `RogueSubmit(c)` | none: a misbehaving engine | action (environment) | only in `MC_rogue.cfg` | |
| `view[c]`, `copies[c]` | none (history for P2, P3, P5) | variables | | |

## Readings of the design, as the code settled them

- R1: "after catch-up" means `confirmed >= welcome.head`. The code agrees (`caughtUp`, `engine.ts:471`).
- R2: a doomed in-flight is dropped after catch-up and its seq reused (`engine.ts:475`). The literal design (`DoomedOnReconnect = "keep"`) stays in the matrix as must-fail runs for F2.
- R3: a resend after `stale` reuses the seq because `nextSeq` advances only in `confirm`.
- R4: an own change the rules do not cover, or an ack that does not fit, is a protocol error. The code agrees (`drop`).
- R5: "closes the older socket" read by arrival is the design as written, F1. The code fences by attempt instead (`AttemptFence = TRUE`); `AttemptFence = FALSE` stays in the matrix as must-fail runs for F1.
- R6: on a `duplicate` result the server answers `ack {v: the earlier version, seq}` (`server.ts:497-499`).

## Assumptions

Each is a place a bug could hide.

- A1: `store.append` is one atomic operation per document, and the server handles one frame of a document at a time. `memoryStore` holds it (`store.ts:95-107` has no `await`), and `enqueue` chains every frame of a document (`server.ts:201-224`). A host's durable store must keep it too; the model does not check that store.
- A2: welcome and the whole catch-up go out before any live change of that document reaches the socket. `welcome` and `catchUp` run inside the same chained task (`server.ts:391-444`), so another frame of the document cannot interleave. Holds in one process.
- A3: after the engine's link closes, no frame of that socket reaches the engine, and no frame of the engine reaches that socket. This is now code: the connectId fence (`collab-link.ts:36-49`, `embed/src/collab.ts:116-124,152-155`). Not checked: another `CollabLink` implementation must give the same guarantee.
- A4: each connection is in order and never drops or duplicates single frames without closing (a WebSocket relayed over `postMessage`).
- A5: `integrate` keeps the op ids of `local` and their order; editor semantics are not checked.
- A6: one epoch, every principal has `canEdit`, no frame too large, no save, export, fingerprint, `diverged` or `peers`, the editor is attached (`held` stays empty), the store never fails. Every client starts welcomed at version 0 on connection 1.
- A7: one engine per client id. The server binds a client id to the user it was issued to (`decide.ts:44-45`); two tabs of one user are two client ids.
- A8: with `SupersedeOnHello = FALSE` an old socket is never closed, and the attempt fence is off (`MC_late.cfg`). This stands for a second server process sharing the store (it has neither the other's sockets nor its `welcomed`), or a close the server has not noticed.

## Granularity

One model step is one chained server task for one frame, or one engine reducer event (with its `integrated` follow-up). The model is finer than the code in two places, which only adds interleavings: `SendNext` and `CaughtUp` are steps of their own, where the code runs them at the end of the handler that enabled them. It is coarser in two places, both atomic in the code: `SrvHello` sends welcome and the catch-up in one step (A2), and `SrvSubmit` is `decideSubmit`, `store.append` and the answers in one step (A1).
