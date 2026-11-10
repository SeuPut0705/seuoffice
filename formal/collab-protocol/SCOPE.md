# Scope: collab-protocol

## The promise and the harm

Every edit a person makes ends up in the shared document exactly once and in one order that every participant sees, even when an acknowledgement is lost, a connection drops at any moment, a dead connection's message arrives late, and two people submit at the same time.

When it fails, a person's edit silently disappears, appears twice, or appears in a different order on different screens; the document then saves something nobody saw. Tests rarely reach it because each failure needs a precise interleaving of a connection drop, a late frame from the dead connection and a concurrent submit from someone else.

## Modeled (in scope)

First the design contract (`local://collab-design.md`, workflow W3); since the drift step (W6, 2026-11-10) the code of `packages/collab` at the sync commit in `formal/manifest.json`. Rows of `CORRESPONDENCE.md` map every action to its `path:lines`.

- The server's log with compare-and-append (`base === head`) and the `(client, seq)` duplicate check, checked first: `store.append` answering appended, duplicate or stale.
- The server's hello with resume: the attempt fence (`resume.attempt` below the highest attempt welcomed: `superseded` on that socket), welcome, catch-up from `resume.v`, superseding the client's other live sockets, ignoring frames of closed sockets.
- Live fan-out: `ack` to the submitting socket, `change` to every other live socket, including the same client's other socket.
- The client engine: `confirmed`, one in-flight submit `{seq, base, ops, doomed}`, `pending`, `nextSeq`, the connection count sent as `attempt`; local ops, submits of a prefix of `pending` (chunks), `ack`, the `change` cases, `stale`, the protocol-error branches, link close, reconnect with resume, catch-up, the resend or drop of the in-flight.
- The environment: per-connection in-order channels in both directions; a link can be cut at any moment, which loses every frame not yet delivered to the client; frames the client sent on a cut connection may still reach the server later, before or after the reconnect, or never. Clients act concurrently.

## Abstracted

- Ops are opaque ids; `integrate` keeps the ids and their order (rebasing is not modeled). The model checks ordering and exactly-once, not editor semantics.
- A change frame carries only its version; the client reads the immutable `log[v]`.
- Welcome plus the whole catch-up is one server step; `decideSubmit` plus `store.append` is one server step.
- Backoff and time are fairness: a client that dropped reconnects eventually.
- Only the client's current connection keeps a server-to-client queue; frames toward a dead connection are dropped.

## Out of scope

A pass says nothing about these:

- The initial join (`need_base`, `base`, hello without resume, seeding an epoch), epoch reset (`error reset`), epoch end and drop.
- `save`, `saved`, `reportSaved`, held changes, `fingerprint`, `diverged`, `peers`, `canEdit = false`, `too_large`, `schema_mismatch`.
- A frame dropped or duplicated inside a connection that stays open (the conformance kit's `drop` and `duplicate`). Frames of a closed socket reaching the engine are excluded by the link's connectId fence (code, `CORRESPONDENCE.md` A3), which the model takes as given for every `CollabLink`.
- Two engines sharing a client id, page reloads, a durable store whose `append` is not atomic, the server's store failures (`abort`), the protocol-strike limit, several server processes sharing a store beyond what `MC_late.cfg` approximates.
- `waitFor` and `held` as variables: `StaleAfterCatchUp` shows `waitFor` never blocks; `held` needs save or a late attach, both out of scope.
- Adapter behaviour: real transforms in `integrate`, adapter exceptions, `emit` during `integrate`.

## Properties

Frozen set: `Properties.md`.

| Name | Kind | Source |
|---|---|---|
| `P1_NoOpTwice` | invariant | promise ("exactly once"); design invariant 2 |
| `P2_ConfirmedIsLogPrefix` | invariant | promise ("one order"); design section 2, invariant 4 |
| `P3_ConfirmedOpsInLog` | invariant | promise; design section 5 (`confirmed(ops)`) |
| `P4_NoOpLost`, `P4_QuietIsDone` | liveness, invariant over quiet states | promise; design sections 5 and 6 |
| `P5_InflightChangesOnlyAfterProof` | action property | design invariant 5 |

Derived checks (not frozen): `ServerInv1_BaseIsHead`, `ServerInv2_ClientSeqOnce` (design invariants 1 and 2), `FramesCovered`, `AcksCovered`, `HelloAnsweredFirst`, `StaleAfterCatchUp`, `InflightAtConfirmed`, `NoStaleForLiveInflight`.

## Bounds

`MaxCuts` counts cuts in the whole run, so one client can drop twice. Connection numbers run to `MaxCuts + 1`. All runs: TLC2 2026.10.28.014557, one worker unless stated. Numbers are from the drift-step runs (`evidence/matrix.log`, `evidence/matrix-deep.log`); the times are wall times on a loaded machine.

| Run | Bounds | States, depth, time |
|---|---|---|
| fast: `MC.cfg` | 2 clients, 2 ops each, 2 cuts; the code (attempt fence, doomed dropped); all properties incl. liveness | 470,001 distinct, depth 40, 479 s |
| fast: `MC_late.cfg` | the same, but old sockets never closed and no fence (late frames reach `store.append`) | 812,881 distinct, depth 42, 588 s |
| fast: `MC_three.cfg` | 3 clients, 1 op each, 2 cuts, symmetry; safety and the quiet-state form of P4 | 194,167 distinct, depth 38, 184 s |
| fast: `MC_three_live.cfg` | 3 clients, 1 op each, 2 cuts, no symmetry; all frozen properties incl. liveness | 1,161,825 distinct, depth 38, 822 s |
| fast: `MC_asis_safety.cfg` | 2 clients, 2 ops, 2 cuts; the design exactly as written; safety only | 538,917 distinct, depth 40, 278 s |
| fast: `MC_rogue.cfg` | 2 clients, 2 ops, 1 cut; an engine that replays an already appended seq with the current head as base | 795,026 distinct, depth 40, 362 s |
| fast: `MC_F1*`, `MC_F2*` (design as written) and five sanity configs | F1: 2 clients, 1 op, 2 cuts; F2: 2 clients, 1 op, 1 cut; sanity: 2 clients, 1 or 2 ops, 2 cuts; each must fail | 131 to 11,902 distinct, under 9 s each |
| deep: `matrix-deep.json` | 3 clients, 2 ops each, 1 cut, symmetry, 8 workers; safety and the quiet-state form of P4 | 90,240,507 distinct (281,013,597 generated), depth 69, 3,699 s |

The small bounds still show both design findings: F1 needs one client dropping twice (2 cuts), F2 needs one drop during a concurrent submit.

## Tools and files

- Tool: TLA+ with TLC, because the question is about interleavings, message loss, late delivery and liveness after faults (`choosing-tools.md`).
- Files: `tla/CollabProtocol.tla`, `tla/MC*.cfg`, `tla/matrix.json`, `tla/matrix-deep.json`, `tla/mutations.json`, `tla/mutations-observations.json`, `Properties.md`, `CORRESPONDENCE.md`, `evidence/` (`evidence/pre-drift/` keeps the design-stage logs).
- Manifest ids: `collab-protocol` and `collab-protocol-deep` in `formal/manifest.json`; covers: `packages/collab/src/server/{decide,server,store}.ts`, `packages/collab/src/client/engine.ts`, `packages/web-platform/src/collab-link.ts`, `packages/embed/src/collab.ts`.
