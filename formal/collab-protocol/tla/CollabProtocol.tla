--------------------------- MODULE CollabProtocol ---------------------------
(* Model of SeuOffice co-editing: the ordered log with compare-and-append on  *)
(* the server, and the client engine's submit / ack / stale / reconnect rules *)
(* (collab design, sections 2, 4 and 5), aligned with packages/collab at the  *)
(* sync commit in formal/manifest.json.                                       *)
(*                                                                            *)
(* Ops are opaque ids <<client, i>>. integrate keeps the ids (rebasing is      *)
(* abstracted): the model checks ordering and exactly-once, not editor        *)
(* semantics. Clients start joined at version 0 on connection 1.              *)
(*                                                                            *)
(* Environment: a client's link can be cut at any moment (MaxCuts in total).  *)
(* A cut loses every frame not yet delivered to the client, and the link's    *)
(* connectId fence keeps every later frame of that socket from the engine.    *)
(* Frames the client sent on a cut connection may still reach the server      *)
(* later, before or after the reconnect, or never (no fairness on them). Each *)
(* connection is in order in both directions.                                 *)
(*                                                                            *)
(* Switches (the code is AttemptFence = TRUE, SupersedeOnHello = TRUE,        *)
(* DoomedOnReconnect = "drop"):                                               *)
(*   AttemptFence      TRUE: hello.resume.attempt is the engine's connection  *)
(*                     count; the server refuses with superseded a hello      *)
(*                     whose attempt is below the highest it welcomed for     *)
(*                     that client (fix of F1). FALSE: the design as written, *)
(*                     where the hello read last always wins.                 *)
(*   SupersedeOnHello  TRUE: a welcomed hello closes the client's other live  *)
(*                     sockets and their frames are ignored. FALSE: old       *)
(*                     sockets stay open, so their late frames reach          *)
(*                     store.append (a second server process sharing the      *)
(*                     store, or a server that has not noticed the close).    *)
(*   DoomedOnReconnect "drop": after catch-up a doomed in-flight is discarded *)
(*                     and its seq is reused for pending (fix of F2). "keep": *)
(*                     the literal text of section 5.                         *)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Clients, OpsPer, MaxCuts, SupersedeOnHello, AttemptFence, DoomedOnReconnect

ASSUME /\ OpsPer \in 1..3
       /\ MaxCuts \in 0..4
       /\ SupersedeOnHello \in BOOLEAN
       /\ AttemptFence \in BOOLEAN
       /\ DoomedOnReconnect \in {"drop", "keep"}

MaxConn == MaxCuts + 1
Conns == 1..MaxConn
Ops == Clients \X (1..OpsPer)

\* inflight with s = 0 means "no in-flight submit" (seq numbers start at 1).
NoIF == [s |-> 0, b |-> 0, ops |-> <<>>, doomed |-> FALSE]

\* Every frame has the same fields so frames compare and fingerprint uniformly.
Frame(t, v, s, b, h, o) == [t |-> t, v |-> v, s |-> s, b |-> b, h |-> h, ops |-> o]
\* hello {resume: {v, attempt}}: h carries the attempt.
Hello(v, a)       == Frame("hello", v, 0, 0, a, <<>>)
Submit(s, b, o)   == Frame("submit", 0, s, b, 0, o)
Welcome(h)        == Frame("welcome", 0, 0, 0, h, <<>>)
\* A change frame names its version; the client reads log[v], which never changes once written.
Change(v)         == Frame("change", v, 0, 0, 0, <<>>)
Ack(v, s)         == Frame("ack", v, s, 0, 0, <<>>)
Stale(s, b, h)    == Frame("stale", 0, s, b, h, <<>>)
Superseded        == Frame("superseded", 0, 0, 0, 0, <<>>)

VARIABLES
    log,        \* server: Seq of [c, s, b, ops]; version v is log[v]; b is model-only bookkeeping
    open,       \* server: the client's live sockets (connection numbers) whose frames are processed
    welcomed,   \* server: the highest connection attempt welcomed per client id (EpochState.clients)
    c2s,        \* c2s[c][k]: frames client c sent on connection k, not yet read by the server
    s2c,        \* frames toward client c on its current connection, not yet read by the client
    phase,      \* client: "hello" (hello sent) | "catchup" | "live" | "offline" | "failed"
    conn,       \* client: number of its current connection (the engine's `opened`)
    catchHead,  \* client: head announced by welcome (`target`); catch-up is done when confirmed >= catchHead
    confirmed,  \* client: confirmed version
    inflight,   \* client: [s, b, ops, doomed], or NoIF
    pending,    \* client: local ops not yet submitted, in order
    nextSeq,    \* client: seq of the next submit; advances only on confirm
    made,       \* client: local ops made so far
    view,       \* history: the confirmed document as the client built it, one ops list per version
    copies,     \* history: every distinct submit [s, b, ops] the client has sent
    cuts        \* environment: cuts used so far

serverVars == <<log, open, welcomed, c2s>>
clientVars == <<phase, conn, catchHead, confirmed, inflight, pending, nextSeq, made, view, copies>>
vars == <<log, open, welcomed, c2s, s2c, phase, conn, catchHead, confirmed, inflight, pending,
          nextSeq, made, view, copies, cuts>>

Range(q) == {q[i] : i \in DOMAIN q}
RECURSIVE FlatOps(_)
FlatOps(l) == IF l = <<>> THEN <<>> ELSE Head(l).ops \o FlatOps(Tail(l))
LogOps == Range(FlatOps(log))
Count(op) == Cardinality({i \in DOMAIN FlatOps(log) : FlatOps(log)[i] = op})

\* The engine holds a connection open (hello, catching_up, live): frames of its current socket reach it.
Linked(c) == phase[c] \in {"hello", "catchup", "live"}
\* Welcomed on the current connection: change, ack and stale are handled only here.
Joined(c) == phase[c] \in {"catchup", "live"}

Frames == [t : {"hello", "submit", "welcome", "change", "ack", "stale", "superseded"},
           v : Nat, s : Nat, b : Nat, h : Nat, ops : Seq(Ops)]

TypeOK ==
    /\ log \in Seq([c : Clients, s : Nat, b : Nat, ops : Seq(Ops)])
    /\ open \in [Clients -> SUBSET Conns]
    /\ welcomed \in [Clients -> 0..MaxConn]
    /\ c2s \in [Clients -> [Conns -> Seq(Frames)]]
    /\ s2c \in [Clients -> Seq(Frames)]
    /\ phase \in [Clients -> {"hello", "catchup", "live", "offline", "failed"}]
    /\ conn \in [Clients -> Conns]
    /\ catchHead \in [Clients -> Nat]
    /\ confirmed \in [Clients -> Nat]
    /\ inflight \in [Clients -> [s : Nat, b : Nat, ops : Seq(Ops), doomed : BOOLEAN]]
    /\ pending \in [Clients -> Seq(Ops)]
    /\ nextSeq \in [Clients -> Nat \ {0}]
    /\ made \in [Clients -> 0..OpsPer]
    /\ view \in [Clients -> Seq(Seq(Ops))]
    /\ copies \in [Clients -> SUBSET [s : Nat, b : Nat, ops : Seq(Ops)]]
    /\ cuts \in 0..MaxCuts

\* The join hello carries no resume, so the server records attempt 0 (decide.ts:78).
Init ==
    /\ log = <<>>
    /\ open = [c \in Clients |-> {1}]
    /\ welcomed = [c \in Clients |-> 0]
    /\ c2s = [c \in Clients |-> [k \in Conns |-> <<>>]]
    /\ s2c = [c \in Clients |-> <<>>]
    /\ phase = [c \in Clients |-> "live"]
    /\ conn = [c \in Clients |-> 1]
    /\ catchHead = [c \in Clients |-> 0]
    /\ confirmed = [c \in Clients |-> 0]
    /\ inflight = [c \in Clients |-> NoIF]
    /\ pending = [c \in Clients |-> <<>>]
    /\ nextSeq = [c \in Clients |-> 1]
    /\ made = [c \in Clients |-> 0]
    /\ view = [c \in Clients |-> <<>>]
    /\ copies = [c \in Clients |-> {}]
    /\ cuts = 0

-----------------------------------------------------------------------------
(* Server. One frame per step: the server handles a document's frames one at *)
(* a time (server.ts enqueue), and store.append is one atomic operation.      *)

\* @code packages/collab/src/server/decide.ts:58-73 resume for the current epoch: welcome {start: resume.v}; superseded when resume.attempt < welcomed
\* @code packages/collab/src/server/server.ts:352-364 answerHello passes the highest attempt welcomed for the client
\* @code packages/collab/src/server/server.ts:391-426 welcome: the client's other live sockets get superseded, the attempt is recorded, welcome then catch-up
\* @code packages/collab/src/server/server.ts:429-444 catchUp: changes start+1..head in order
\* @code packages/collab/src/server/server.ts:300-304 reject: error on that socket only, then close
SrvHello(c, k) ==
    /\ c2s[c][k] # <<>>
    /\ Head(c2s[c][k]).t = "hello"
    /\ LET f == Head(c2s[c][k])
           accept == ~AttemptFence \/ f.h >= welcomed[c]
           welcome == <<Welcome(Len(log))>> \o [i \in 1..(Len(log) - f.v) |-> Change(f.v + i)]
           closed == IF accept /\ SupersedeOnHello THEN open[c] \ {k} ELSE {}
       IN /\ open' = [open EXCEPT ![c] = IF ~accept THEN @
                                         ELSE IF SupersedeOnHello THEN {k}
                                         ELSE @ \cup {k}]
          /\ welcomed' = [welcomed EXCEPT ![c] = IF accept THEN f.h ELSE @]
          /\ s2c' = [s2c EXCEPT ![c] =
                       IF ~Linked(c) THEN @
                       ELSE IF k = conn[c] THEN (IF accept THEN @ \o welcome ELSE Append(@, Superseded))
                       ELSE IF conn[c] \in closed THEN Append(@, Superseded)
                       ELSE @]
    /\ c2s' = [c2s EXCEPT ![c][k] = Tail(@)]
    /\ UNCHANGED <<log, clientVars, cuts>>

\* @code packages/collab/src/server/decide.ts:88-99 decideSubmit: a welcomed socket's submit becomes an append request
\* @code packages/collab/src/server/store.ts:95-107 memoryStore append: duplicate (checked first) | stale | appended, in one step
\* @code packages/collab/src/server/server.ts:463-507 onSubmit: ack to the sender, change to every other live socket; duplicate: ack only; stale: catch-up then stale
SrvSubmit(c, k) ==
    /\ c2s[c][k] # <<>>
    /\ Head(c2s[c][k]).t = "submit"
    /\ k \in open[c]
    /\ c2s' = [c2s EXCEPT ![c][k] = Tail(@)]
    /\ LET f == Head(c2s[c][k])
           head == Len(log)
           dupAt == {v \in 1..head : log[v].c = c /\ log[v].s = f.s}
           toSender(fr) == [s2c EXCEPT ![c] = IF k = conn[c] /\ Linked(c) THEN Append(@, fr) ELSE @]
       IN IF dupAt # {}
          THEN /\ s2c' = toSender(Ack(CHOOSE v \in dupAt : TRUE, f.s))
               /\ UNCHANGED log
          ELSE IF f.b # head
          THEN /\ s2c' = toSender(Stale(f.s, f.b, head))
               /\ UNCHANGED log
          ELSE /\ log' = Append(log, [c |-> c, s |-> f.s, b |-> f.b, ops |-> f.ops])
               /\ s2c' = [d \in Clients |->
                            IF d = c /\ k = conn[c]
                            THEN (IF Linked(c) THEN Append(s2c[c], Ack(head + 1, f.s)) ELSE s2c[c])
                            ELSE IF conn[d] \in open[d] /\ Linked(d)
                            THEN Append(s2c[d], Change(head + 1))
                            ELSE s2c[d]]
    /\ UNCHANGED <<open, welcomed, clientVars, cuts>>

\* @code packages/collab/src/server/server.ts:548-549 frames of a closed socket are ignored
SrvIgnore(c, k) ==
    /\ c2s[c][k] # <<>>
    /\ Head(c2s[c][k]).t = "submit"
    /\ k \notin open[c]
    /\ c2s' = [c2s EXCEPT ![c][k] = Tail(@)]
    /\ UNCHANGED <<log, open, welcomed, s2c, clientVars, cuts>>

SrvRecv(c, k) == SrvHello(c, k) \/ SrvSubmit(c, k) \/ SrvIgnore(c, k)

\* The frames of a connection the client still holds open reach the server.
SrvCur(c) == Linked(c) /\ SrvRecv(c, conn[c])

-----------------------------------------------------------------------------
(* Client engine. One reducer event per step.                                 *)

\* @code packages/collab/src/client/engine.ts:325-331 local: pending += ops, also while offline
MakeOp(c) ==
    /\ phase[c] # "failed"
    /\ made[c] < OpsPer
    /\ made' = [made EXCEPT ![c] = @ + 1]
    /\ pending' = [pending EXCEPT ![c] = Append(@, <<c, made[c] + 1>>)]
    /\ UNCHANGED <<serverVars, s2c, phase, conn, catchHead, confirmed, inflight, nextSeq, view, copies, cuts>>

\* The code sends the longest prefix of pending that fits one chunk; any prefix length
\* is possible depending on the ops' sizes.
\* @code packages/collab/src/client/engine.ts:578-603 submit: live, no in-flight: submit {seq: nextSeq, base: confirmed, ops: a prefix of pending}
SendNext(c) ==
    /\ phase[c] = "live"
    /\ inflight[c].s = 0
    /\ pending[c] # <<>>
    /\ \E n \in 1..Len(pending[c]) :
          LET sub == [s |-> nextSeq[c], b |-> confirmed[c], ops |-> SubSeq(pending[c], 1, n)]
          IN /\ inflight' = [inflight EXCEPT ![c] = [s |-> sub.s, b |-> sub.b, ops |-> sub.ops, doomed |-> FALSE]]
             /\ c2s' = [c2s EXCEPT ![c][conn[c]] = Append(@, Submit(sub.s, sub.b, sub.ops))]
             /\ copies' = [copies EXCEPT ![c] = @ \cup {sub}]
             /\ pending' = [pending EXCEPT ![c] = SubSeq(@, n + 1, Len(@))]
    /\ UNCHANGED <<log, open, welcomed, s2c, phase, conn, catchHead, confirmed, nextSeq, made, view, cuts>>

Hd(c) == Head(s2c[c])
Pop(c) == s2c' = [s2c EXCEPT ![c] = Tail(@)]

\* @code packages/collab/src/client/engine.ts:519-525 confirm: the in-flight ops are confirmed at v, nextSeq++
AckEffects(c, v) ==
    /\ confirmed' = [confirmed EXCEPT ![c] = v]
    /\ view' = [view EXCEPT ![c] = Append(@, inflight[c].ops)]
    /\ inflight' = [inflight EXCEPT ![c] = NoIF]
    /\ nextSeq' = [nextSeq EXCEPT ![c] = @ + 1]

\* A protocol error: the engine closes the connection and reconnects (drop, lose).
\* @code packages/collab/src/client/engine.ts:650-676 drop and lose: close, offline, reconnect timer
DropEffects(c) ==
    /\ phase' = [phase EXCEPT ![c] = "offline"]
    /\ s2c' = [s2c EXCEPT ![c] = <<>>]

\* @code packages/collab/src/client/engine.ts:447-467 welcome after a resume hello: target = head, catching_up
RecvWelcome(c) ==
    /\ phase[c] = "hello"
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "welcome"
    /\ Pop(c)
    /\ phase' = [phase EXCEPT ![c] = "catchup"]
    /\ catchHead' = [catchHead EXCEPT ![c] = Hd(c).h]
    /\ UNCHANGED <<serverVars, conn, confirmed, inflight, pending, nextSeq, made, view, copies, cuts>>

\* @code packages/collab/src/client/engine.ts:414-422 change, ack or stale before welcome: protocol error
RecvEarly(c) ==
    /\ phase[c] = "hello"
    /\ s2c[c] # <<>>
    /\ Hd(c).t \in {"change", "ack", "stale"}
    /\ DropEffects(c)
    /\ UNCHANGED <<serverVars, conn, catchHead, confirmed, inflight, pending, nextSeq, made, view, copies, cuts>>

\* @code packages/collab/src/client/engine.ts:486-488 change: v <= confirmed is ignored
RecvChangeOld(c) ==
    /\ Joined(c)
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "change"
    /\ Hd(c).v <= confirmed[c]
    /\ Pop(c)
    /\ UNCHANGED <<serverVars, clientVars, cuts>>

\* @code packages/collab/src/client/engine.ts:491-494 change: mine, in-flight not doomed, seq === inflight.seq: the lost ack
RecvChangeMine(c) ==
    /\ Joined(c)
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "change"
    /\ Hd(c).v = confirmed[c] + 1
    /\ log[Hd(c).v].c = c
    /\ inflight[c].s # 0
    /\ ~inflight[c].doomed
    /\ log[Hd(c).v].s = inflight[c].s
    /\ Pop(c)
    /\ AckEffects(c, Hd(c).v)
    /\ UNCHANGED <<serverVars, phase, conn, catchHead, pending, made, copies, cuts>>

\* @code packages/collab/src/client/engine.ts:495-496 change: foreign at confirmed + 1
\* @code packages/collab/src/client/engine.ts:528-535 integrateForeign: pending = integrate(change.ops, live in-flight ops ++ pending); the in-flight becomes doomed
\* @code packages/collab/src/client/engine.ts:332-334 integrated: the rewritten pending comes back before any other event
RecvChangeForeign(c) ==
    /\ Joined(c)
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "change"
    /\ Hd(c).v = confirmed[c] + 1
    /\ log[Hd(c).v].c # c
    /\ Pop(c)
    /\ LET i == inflight[c]
           local == (IF i.s # 0 /\ ~i.doomed THEN i.ops ELSE <<>>) \o pending[c]
       IN /\ pending' = [pending EXCEPT ![c] = local]
          /\ inflight' = [inflight EXCEPT ![c] = IF i.s # 0 THEN [i EXCEPT !.doomed = TRUE, !.ops = <<>>] ELSE i]
    /\ confirmed' = [confirmed EXCEPT ![c] = Hd(c).v]
    /\ view' = [view EXCEPT ![c] = Append(@, log[Hd(c).v].ops)]
    /\ UNCHANGED <<serverVars, phase, conn, catchHead, nextSeq, made, copies, cuts>>

\* @code packages/collab/src/client/engine.ts:489-493 change: v > confirmed + 1, or an own change no rule covers: protocol error
RecvChangeError(c) ==
    /\ Joined(c)
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "change"
    /\ \/ Hd(c).v > confirmed[c] + 1
       \/ /\ Hd(c).v = confirmed[c] + 1
          /\ log[Hd(c).v].c = c
          /\ (inflight[c].s = 0 \/ inflight[c].doomed \/ log[Hd(c).v].s # inflight[c].s)
    /\ DropEffects(c)
    /\ UNCHANGED <<serverVars, conn, catchHead, confirmed, inflight, pending, nextSeq, made, view, copies, cuts>>

\* @code packages/collab/src/client/engine.ts:501-508 ack: for the in-flight, not doomed, v === confirmed + 1
RecvAck(c) ==
    /\ Joined(c)
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "ack"
    /\ inflight[c].s # 0
    /\ Hd(c).s = inflight[c].s
    /\ Hd(c).v = confirmed[c] + 1
    /\ ~inflight[c].doomed
    /\ Pop(c)
    /\ AckEffects(c, Hd(c).v)
    /\ UNCHANGED <<serverVars, phase, conn, catchHead, pending, made, copies, cuts>>

\* @code packages/collab/src/client/engine.ts:504 ack: no in-flight, another seq, or v <= confirmed: ignored
RecvAckOther(c) ==
    /\ Joined(c)
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "ack"
    /\ (inflight[c].s = 0 \/ Hd(c).s # inflight[c].s \/ Hd(c).v <= confirmed[c])
    /\ Pop(c)
    /\ UNCHANGED <<serverVars, clientVars, cuts>>

\* @code packages/collab/src/client/engine.ts:505 ack for the in-flight seq past confirmed + 1, or for a doomed in-flight: protocol error
RecvAckError(c) ==
    /\ Joined(c)
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "ack"
    /\ inflight[c].s # 0
    /\ Hd(c).s = inflight[c].s
    /\ Hd(c).v > confirmed[c]
    /\ (Hd(c).v # confirmed[c] + 1 \/ inflight[c].doomed)
    /\ DropEffects(c)
    /\ UNCHANGED <<serverVars, conn, catchHead, confirmed, inflight, pending, nextSeq, made, view, copies, cuts>>

\* waitFor (engine.ts:516, 581) is not modeled: StaleAfterCatchUp shows confirmed >= stale.head
\* already holds when the stale is handled, and confirmed never decreases, so it never blocks a submit.
\* @code packages/collab/src/client/engine.ts:510-517 stale for the in-flight (same seq and base); not doomed: ops back to the front of pending; the next submit reuses the seq
RecvStale(c) ==
    /\ Joined(c)
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "stale"
    /\ inflight[c].s # 0
    /\ Hd(c).s = inflight[c].s
    /\ Hd(c).b = inflight[c].b
    /\ Pop(c)
    /\ pending' = [pending EXCEPT ![c] = IF inflight[c].doomed THEN @ ELSE inflight[c].ops \o @]
    /\ inflight' = [inflight EXCEPT ![c] = NoIF]
    /\ UNCHANGED <<serverVars, phase, conn, catchHead, confirmed, nextSeq, made, view, copies, cuts>>

\* @code packages/collab/src/client/engine.ts:513 a stale that is not for the in-flight is ignored
RecvStaleOther(c) ==
    /\ Joined(c)
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "stale"
    /\ ~(inflight[c].s # 0 /\ Hd(c).s = inflight[c].s /\ Hd(c).b = inflight[c].b)
    /\ Pop(c)
    /\ UNCHANGED <<serverVars, clientVars, cuts>>

\* @code packages/collab/src/client/engine.ts:431-432 error superseded on the current connection fails the session
\* @code packages/collab/src/client/engine.ts:631-643 fail: close, setEditable(false)
RecvSuperseded(c) ==
    /\ Linked(c)
    /\ s2c[c] # <<>>
    /\ Hd(c).t = "superseded"
    /\ phase' = [phase EXCEPT ![c] = "failed"]
    /\ s2c' = [s2c EXCEPT ![c] = <<>>]
    /\ UNCHANGED <<serverVars, conn, catchHead, confirmed, inflight, pending, nextSeq, made, view, copies, cuts>>

Recv(c) ==
    \/ RecvWelcome(c) \/ RecvEarly(c) \/ RecvChangeOld(c) \/ RecvChangeMine(c) \/ RecvChangeForeign(c)
    \/ RecvChangeError(c) \/ RecvAck(c) \/ RecvAckOther(c) \/ RecvAckError(c) \/ RecvStale(c)
    \/ RecvStaleOther(c) \/ RecvSuperseded(c)

\* What a not-doomed in-flight is resent as after a reconnect: unchanged (inflight.json), pending stays pending.
ResendOnReconnect(c) == [ops |-> inflight[c].ops, rest |-> pending[c]]

\* The code runs caughtUp inside the welcome and change handlers; the model makes it a step
\* of its own, which only adds interleavings.
\* @code packages/collab/src/client/engine.ts:469-484 caughtUp: live; a not-doomed in-flight is resent unchanged; a doomed one is dropped
CaughtUp(c) ==
    /\ phase[c] = "catchup"
    /\ confirmed[c] >= catchHead[c]
    /\ phase' = [phase EXCEPT ![c] = "live"]
    /\ catchHead' = [catchHead EXCEPT ![c] = 0]
    /\ UNCHANGED <<log, open, welcomed, s2c, conn, confirmed, nextSeq, made, view, cuts>>
    /\ LET i == inflight[c]
           r == ResendOnReconnect(c)
       IN IF i.s # 0 /\ ~i.doomed
          THEN /\ inflight' = [inflight EXCEPT ![c].ops = r.ops]
               /\ pending' = [pending EXCEPT ![c] = r.rest]
               /\ c2s' = [c2s EXCEPT ![c][conn[c]] = Append(@, Submit(i.s, i.b, r.ops))]
               /\ copies' = [copies EXCEPT ![c] = @ \cup {[s |-> i.s, b |-> i.b, ops |-> r.ops]}]
          ELSE IF i.s # 0 /\ DoomedOnReconnect = "drop"
          THEN /\ inflight' = [inflight EXCEPT ![c] = NoIF]
               /\ UNCHANGED <<pending, c2s, copies>>
          ELSE UNCHANGED <<inflight, pending, c2s, copies>>

\* Environment: the link drops. Undelivered frames toward the client are lost, and the
\* connectId fence of the page link and the host relay keeps any later frame of that
\* socket from the engine; frames the client sent stay in c2s and may still reach the server.
\* @code packages/web-platform/src/collab-link.ts:36-49 frames tagged with an older connectId are dropped; collab_close ends the connection
\* @code packages/embed/src/collab.ts:116-124 the host relays only the current connection's frames and reports its close
\* @code packages/collab/src/client/engine.ts:300-308 close: offline; frames while no connection is open are ignored
Cut(c) ==
    /\ cuts < MaxCuts
    /\ Linked(c)
    /\ cuts' = cuts + 1
    /\ phase' = [phase EXCEPT ![c] = "offline"]
    /\ s2c' = [s2c EXCEPT ![c] = <<>>]
    /\ UNCHANGED <<serverVars, conn, catchHead, confirmed, inflight, pending, nextSeq, made, view, copies>>

\* @code packages/collab/src/client/engine.ts:309-312 reconnect timer: connecting, open the link
\* @code packages/collab/src/client/engine.ts:282-299 open: opened++, hello {resume: {epoch, client, v: confirmed, attempt: opened}}
Reconnect(c) ==
    /\ phase[c] = "offline"
    /\ conn[c] < MaxConn
    /\ conn' = [conn EXCEPT ![c] = @ + 1]
    /\ phase' = [phase EXCEPT ![c] = "hello"]
    /\ c2s' = [c2s EXCEPT ![c][conn[c] + 1] = Append(@, Hello(confirmed[c], conn[c] + 1))]
    /\ UNCHANGED <<log, open, welcomed, s2c, catchHead, confirmed, inflight, pending, nextSeq, made, view, copies, cuts>>

\* Off in every config except MC_rogue.cfg, which overrides it with RogueOn.
RogueClients == FALSE
RogueOn == TRUE

\* Environment, only with RogueClients: a buggy or hostile engine replays a submit
\* whose seq the log already holds, on its current connection, with the server's
\* current head as base (so the base check cannot stop it). The server must keep
\* design invariants 1 to 3 whatever a client sends. A replay waits until both
\* queues of the connection are empty, which keeps the queues finite.
RogueSubmit(c) ==
    /\ RogueClients
    /\ Linked(c)
    /\ c2s[c][conn[c]] = <<>>
    /\ s2c[c] = <<>>
    /\ \E x \in copies[c] :
           /\ \E v \in 1..Len(log) : log[v].c = c /\ log[v].s = x.s
           /\ c2s' = [c2s EXCEPT ![c][conn[c]] = Append(@, Submit(x.s, Len(log), x.ops))]
    /\ UNCHANGED <<log, open, welcomed, s2c, clientVars, cuts>>

\* Steps the runtime guarantees to take while they stay possible.
Fair(c) == MakeOp(c) \/ SendNext(c) \/ CaughtUp(c) \/ Recv(c) \/ Reconnect(c) \/ SrvCur(c)

\* No guaranteed step is left; only faults and late frames of dead connections may still happen.
Quiet == \A c \in Clients : ~ENABLED Fair(c)

Step ==
    \E c \in Clients :
        \/ MakeOp(c) \/ SendNext(c) \/ CaughtUp(c) \/ Recv(c) \/ Reconnect(c) \/ Cut(c)
        \/ \E k \in Conns : SrvRecv(c, k)
        \/ RogueSubmit(c)

Next == Step \/ (Quiet /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars /\ \A c \in Clients : WF_vars(Fair(c))

Perms == Permutations(Clients)

-----------------------------------------------------------------------------
\* FROZEN PROPERTIES (Properties.md). Changing any line between the banners is a model change.

\* P1: the log never holds an op id twice.
P1_NoOpTwice ==
    LET f == FlatOps(log) IN \A i, j \in DOMAIN f : i < j => f[i] # f[j]

\* P2: every client's confirmed sequence equals the log prefix of length confirmed.
P2_ConfirmedIsLogPrefix ==
    \A c \in Clients :
        /\ confirmed[c] <= Len(log)
        /\ Len(view[c]) = confirmed[c]
        /\ \A v \in 1..confirmed[c] : view[c][v] = log[v].ops

\* P3: a client never treats as confirmed an op that is not in the log.
P3_ConfirmedOpsInLog ==
    \A c \in Clients : \A v \in DOMAIN view[c] : Range(view[c][v]) \subseteq LogOps

\* P4: no op is lost. Every made op is in the log exactly once, every client is live
\* at head with nothing in flight or pending. As liveness under the fairness of Spec,
\* and as an invariant over quiet states (no guaranteed step left).
AllDone ==
    \A c \in Clients :
        /\ phase[c] = "live"
        /\ made[c] = OpsPer
        /\ inflight[c].s = 0
        /\ pending[c] = <<>>
        /\ confirmed[c] = Len(log)
        /\ \A i \in 1..OpsPer : Count(<<c, i>>) = 1
P4_NoOpLost == <>[]AllDone
P4_QuietIsDone == Quiet => AllDone

\* P5 (design invariant 5): a client sends a submit whose (base, ops) differ from an
\* earlier submit with the same seq only when that earlier one can never be appended:
\* the log already holds version base + 1 and that version is not the earlier submit.
Dead(c, x) ==
    /\ Len(log) > x.b
    /\ ~\E v \in 1..Len(log) : log[v].c = c /\ log[v].s = x.s /\ log[v].b = x.b /\ log[v].ops = x.ops
P5_InflightChangesOnlyAfterProof ==
    [][\A c \in Clients : \A y \in copies'[c] \ copies[c] : \A x \in copies[c] : x.s = y.s => Dead(c, x)]_vars

\* END FROZEN PROPERTIES

-----------------------------------------------------------------------------
\* Derived checks (not frozen): rules of the design that the frozen ones rely on.

\* Design invariant 1: a change is appended only when base === head, so version v has base v - 1.
ServerInv1_BaseIsHead == \A v \in 1..Len(log) : log[v].b = v - 1

\* Design invariant 2: (client, seq) appears at most once in the log.
ServerInv2_ClientSeqOnce ==
    \A v, w \in 1..Len(log) : v < w => ~(log[v].c = log[w].c /\ log[v].s = log[w].s)

\* Invariant 4 seen from the client: the next change frame is never one no rule covers.
FramesCovered ==
    \A c \in Clients :
        (Joined(c) /\ s2c[c] # <<>> /\ Hd(c).t = "change") =>
            /\ Hd(c).v <= confirmed[c] + 1
            /\ (Hd(c).v = confirmed[c] + 1 /\ log[Hd(c).v].c = c) =>
                   (inflight[c].s # 0 /\ ~inflight[c].doomed /\ log[Hd(c).v].s = inflight[c].s)

\* An ack for the in-flight seq past confirmed is always for confirmed + 1 and a live in-flight.
AcksCovered ==
    \A c \in Clients :
        (Joined(c) /\ s2c[c] # <<>> /\ Hd(c).t = "ack" /\ inflight[c].s # 0
         /\ Hd(c).s = inflight[c].s /\ Hd(c).v > confirmed[c]) =>
            (Hd(c).v = confirmed[c] + 1 /\ ~inflight[c].doomed)

\* A new connection's first frame is its welcome (or superseded): nothing is sent to a socket before.
HelloAnsweredFirst ==
    \A c \in Clients : (phase[c] = "hello" /\ s2c[c] # <<>>) => Hd(c).t \in {"welcome", "superseded"}

\* "no submit until confirmed reaches stale.head" (waitFor): the wait is always already over.
StaleAfterCatchUp ==
    \A c \in Clients :
        (Joined(c) /\ s2c[c] # <<>> /\ Hd(c).t = "stale" /\ inflight[c].s # 0
         /\ Hd(c).s = inflight[c].s /\ Hd(c).b = inflight[c].b) => Hd(c).h <= confirmed[c]

\* A live (not doomed) in-flight is always based on the client's confirmed version.
InflightAtConfirmed ==
    \A c \in Clients : (inflight[c].s # 0 /\ ~inflight[c].doomed) => inflight[c].b = confirmed[c]

\* Observation: a stale never answers an in-flight that is not doomed.
NoStaleForLiveInflight ==
    \A c \in Clients :
        (Joined(c) /\ s2c[c] # <<>> /\ Hd(c).t = "stale" /\ inflight[c].s # 0
         /\ Hd(c).s = inflight[c].s /\ Hd(c).b = inflight[c].b) => inflight[c].doomed

-----------------------------------------------------------------------------
\* Sanity (each must FAIL): the situations the properties are about are reachable.

\* Two clients submitted at the same time and one in-flight became doomed.
SanityNeverDoomed == \A c \in Clients : ~inflight[c].doomed

\* A client sent two different submits with one seq (the resend after stale or doom).
SanityNoSeqReuse == \A c \in Clients : \A x, y \in copies[c] : x.s = y.s => x = y

\* A copy of a submit still waits on a dead connection while the client already
\* holds that seq confirmed: a late frame can reach the server after the resend.
SanityNoLateCopy ==
    \A c \in Clients : \A k \in Conns : \A i \in DOMAIN c2s[c][k] :
        (k # conn[c] /\ c2s[c][k][i].t = "submit") =>
            ~\E v \in 1..confirmed[c] : log[v].c = c /\ log[v].s = c2s[c][k][i].s

\* The attempt fence fires: a hello of a given-up connection arrives after a newer one was welcomed.
SanityNoFencedHello ==
    \A c \in Clients : \A k \in Conns :
        (c2s[c][k] # <<>> /\ Head(c2s[c][k]).t = "hello") => Head(c2s[c][k]).h >= welcomed[c]

\* The run can finish: every op confirmed everywhere.
SanityNeverDone == ~AllDone
=============================================================================
