# Frozen properties: collab-protocol

Frozen at: 2026-11-10, branch `feat/collab` before any `packages/collab` code existed, from the assignment's promise and the design contract (`local://collab-design.md`, sections 2, 4, 5). The five properties were written down before the model; their formal text is the block between the `\* FROZEN PROPERTIES` and `\* END FROZEN PROPERTIES` banners of `tla/CollabProtocol.tla`.

Any change to a definition below, to a `CONSTRAINT`, or to the fairness of `Spec` is a **model change**: say so in the report, with the old and the new text and the evidence. Never make one to turn a failing check green.

Promise under test: every edit a person makes ends up in the document exactly once and in one order that every participant sees, even when an acknowledgement is lost, a connection drops at any moment, a dead connection's message arrives late, and two people submit at the same time.

## P1_NoOpTwice

- Kind: invariant
- Statement: `LET f == FlatOps(log) IN \A i, j \in DOMAIN f : i < j => f[i] # f[j]`
- Meaning: no op id appears twice in the log (inside one change or across changes).
- Source: the promise ("exactly once"); design section 2, invariant 2 (`(client, seq)` at most once) is the server-side mechanism.
- Level: protocol
- Config: every config (`INVARIANT P1_NoOpTwice`)
- Result: holds (MC, MC_late, MC_three, MC_asis_safety)

## P2_ConfirmedIsLogPrefix

- Kind: invariant
- Statement: `\A c : confirmed[c] <= Len(log) /\ Len(view[c]) = confirmed[c] /\ \A v \in 1..confirmed[c] : view[c][v] = log[v].ops`
- Meaning: what each client holds as its confirmed document is exactly the first `confirmed` changes of the log, in log order. `view` is the sequence of change bodies the client accepted (a foreign change's ops, or its own in-flight ops on ack).
- Source: the promise ("one order that every participant sees"); design section 2 ("State at version V = open(base) then apply changes 1..V in order") and invariant 4.
- Level: protocol
- Config: every config
- Result: holds

## P3_ConfirmedOpsInLog

- Kind: invariant
- Statement: `\A c : \A v \in DOMAIN view[c] : Range(view[c][v]) \subseteq LogOps`
- Meaning: a client never treats as confirmed an op that the server never ordered. (Implied by P2; kept separately because it is the user-visible harm: an edit shown as saved that no other participant will ever see.)
- Source: the promise; design section 5 (`ack` and the lost-ack rule call `confirmed(ops)`).
- Level: protocol
- Config: every config
- Result: holds

## P4_NoOpLost and P4_QuietIsDone

- Kind: liveness (`P4_NoOpLost == <>[]AllDone`) and invariant (`P4_QuietIsDone == Quiet => AllDone`)
- Statement: `AllDone == \A c : phase[c] = "live" /\ made[c] = OpsPer /\ inflight[c].s = 0 /\ pending[c] = <<>> /\ confirmed[c] = Len(log) /\ \A i \in 1..OpsPer : Count(<<c, i>>) = 1`; `Quiet == \A c : ~ENABLED Fair(c)`
- Meaning: no op is lost. Once the faults stop (cuts are bounded) every op each person made is in the log exactly once, and every client is live, at head, with nothing in flight or pending. The liveness form uses the fairness of `Spec` (below); the invariant form checks every state in which no guaranteed step is left.
- Fairness (part of the frozen text): `\A c : WF_vars(Fair(c))` with `Fair(c) == MakeOp(c) \/ SendNext(c) \/ CaughtUp(c) \/ Recv(c) \/ Reconnect(c) \/ SrvCur(c)`: a client keeps running its handlers, reconnects after a drop (backoff), and the server reads the frames of a connection the client still holds open. There is no fairness on faults (`Cut`) or on the late frames of a dead connection (they may arrive at any time or never).
- Source: the promise ("ends up in the document"); design section 5 (reconnect with backoff, resend after catch-up) and section 6 (the conformance kit's quiesce-then-assert "every locally emitted op is in the log exactly once").
- Level: protocol
- Config: `MC.cfg`, `MC_late.cfg`, `MC_three_live.cfg` (both forms); `MC_three.cfg` and the deep run (invariant form only: symmetry is unsound with liveness)
- Result: violated by the design as written (findings F1, F2: `MC_F1*`, `MC_F2*`, kept in the matrix as must-fail runs); holds for the code at the sync commit, which has both fixes
- Drift note (2026-11-10): the text of `Fair` is unchanged. The actions it names now follow the code: `Recv` gained two error handlers (`RecvEarly`, `RecvAckError`, never enabled), and `SendNext` may send a prefix of `pending`. See `CORRESPONDENCE.md`, "What the drift step changed in the model".

## P5_InflightChangesOnlyAfterProof

- Kind: action property
- Statement: `[][\A c : \A y \in copies'[c] \ copies[c] : \A x \in copies[c] : x.s = y.s => Dead(c, x)]_vars` with `Dead(c, x) == Len(log) > x.b /\ ~\E v : log[v] is x`
- Meaning: design invariant 5. When a client sends a submit whose base or ops differ from an earlier submit with the same seq, that earlier submit can never be appended any more: the log already holds version `base + 1`, and it is not that submit. `copies` records every distinct submit the client sent, so a resend that is truly unchanged is not a change.
- Source: design section 2, invariant 5 ("A client changes the ops of its in-flight submit only after proof that the submit can never be appended").
- Level: protocol
- Config: every config (`PROPERTY P5_InflightChangesOnlyAfterProof`)
- Result: holds

## Derived checks (not frozen)

These state rules the design relies on, so that a hole in them is reported by name instead of surfacing later as a P1 to P5 failure. They are checked in the same configs and may be refined without a model-change note.

- `ServerInv1_BaseIsHead`, `ServerInv2_ClientSeqOnce`: design invariants 1 and 2 on the log.
- `FramesCovered`: the next frame a client reads is never a change that no rule covers (`v > confirmed + 1`, or an own change at `confirmed + 1` that is not the live in-flight's seq). Design invariant 4 seen from the client.
- `AcksCovered` (added in the drift step): an ack for the in-flight seq past `confirmed` is always for `confirmed + 1` and a live in-flight, so the engine's ack error branch never fires.
- `HelloAnsweredFirst` (added in the drift step): on a new connection the first frame is `welcome` or `superseded`.
- `StaleAfterCatchUp`: when a `stale` for the in-flight arrives, `confirmed >= stale.head` already holds, so the engine's `waitFor` never blocks a submit.
- `InflightAtConfirmed`: an in-flight that is not doomed is always based on the client's confirmed version.
- `NoStaleForLiveInflight`: a `stale` for the in-flight never arrives while it is not doomed (an observation: the "if not doomed" branch of the stale rule is unreachable within the bounds).
