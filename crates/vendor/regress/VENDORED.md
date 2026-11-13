# regress 0.12.0, vendored

The ECMAScript regular expression engine `jscompat` builds on. This directory
is the crate as crates.io publishes it, with the patches listed below, and is
used through `[patch.crates-io]` in `crates/Cargo.toml`. It is not a member of
the workspace: `cargo fmt`, `cargo clippy` and the workspace tests leave it as
it is. Its own tests run with
`cargo test --manifest-path crates/vendor/regress/Cargo.toml --features utf16`.

- **Source**: <https://crates.io/crates/regress/0.12.0>, repository
  <https://github.com/ridiculousfish/regress> at
  `aae35dee1596cc9a9caaad2425b088081c09e5d5` (`.cargo_vcs_info.json`).
- **Archive checksum** (SHA-256 of `regress-0.12.0.crate`, as `Cargo.lock`
  recorded it before vendoring):
  `32eef8b209c3c1c15dbad02c1f30f9539f00dc7253e0cbcdaae442a50a09d7c1`.
- **License**: MIT OR Apache-2.0, `LICENSE-MIT` and `LICENSE-APACHE` here.
- **Unmodified**: every file of the archive, including its `Cargo.lock`, which
  its own `.gitignore` names and was added on purpose. The first commit that
  adds this directory holds the archive as published; `git diff` against it
  shows the patches.

## Why

0.12.0 is the newest release, and two of its behaviours cannot be accepted in
an engine that reads documents someone sent:

1. **The backtrack stack has no bound.** A loop whose body is more than one
   character matcher (`(?:a|b)*`, `(?:[^<>"']|"[^"]*")*`) keeps stack entries
   for every turn until the match attempt ends. One unclosed tag of a few
   million characters takes gigabytes: measured 251.7 bytes of peak memory per
   character on `<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>`, and the wasm32 module
   aborts at 22.4M characters. V8 refuses the same input with a `RangeError`.
2. **A lazy loop over one character matcher walks to its farthest end first.**
   `[\s\S]*?` and `.*?` compute the last position the loop could reach before
   the first try, so every match costs the rest of the text: one pass of
   `<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>` over 2 MB with 40,000 matches took
   47.9 s, where V8 takes 4.3 ms.

## Patches

Each is its own commit, carries no code of this project, and is written so it
could be offered upstream.

1. **A bound on the backtrack stack** (`classicalbacktrack.rs`, `exec.rs`,
   `api.rs`, `insn.rs`, `emit.rs`, `tests/backtrack_limit.rs`).
   `Regex::set_backtrack_limit(Some(entries))` bounds the stack of each
   search; the default, `None`, changes nothing. The bound is checked before
   each instruction; the entries of a stack a lookaround sets aside count
   against it. A search that would pass it stops: the iterator ends and
   `Matches::limit_exceeded()` is true, and no search runs after it. The stack
   grows by doubling while that stays below a quarter of the bound and then
   to the bound in one step, so its capacity stops at the bound and a
   reallocation holds 1.25 times it at most. A lookaround first gives back
   the capacity the stack it sets aside does not use, keeping room for it to
   double so that a loop around the lookaround does not reallocate it every
   turn, and gives back its own stack before the search goes on; with one
   lookaround the two stacks hold twice the bound at most. After each match attempt a stack above 4,096
   entries is shrunk back to that, so one large search does not keep its
   memory.
   What the bound costs, with the 2^22 entries `jscompat` sets
   (`crates/jscompat/tests/limit.rs`, `crates/jscompat/examples/limit_wasm.rs`):

   | Target | Entry | Peak of one search at the bound |
   | ------ | ----- | ------------------------------- |
   | 64-bit native | 40 bytes | 209 MB measured (2^22 × 40 = 168 MB, × 1.25 while the last growth copies) |
   | wasm32 | 20 bytes | linear memory grew by 84–125 MB, to 128–135 MB in all; a wasm memory never shrinks, so a tab keeps it |

   The wasm32 rows are from searches over 1M, 1.5M and 25M characters on
   Node 22. Over 25M the text had already grown the memory, and the search
   grew it by 83,886,080 bytes, 2^22 × 20. With a lookahead entered while a
   large stack is set aside the native peak was 209 to 263 MB on the three
   cases of `tests/limit.rs` (377 MB when the stack set aside kept all its
   capacity). `tests/backtrack_limit.rs` checks that a lookaround inside a
   loop that grows the stack costs twice for twice the text: shrinking the
   stack set aside to its length made each turn reallocate it, and 800,000
   characters did not finish in 15 minutes.
2. **A lazy loop over one character matcher takes one character per
   backtrack** (`classicalbacktrack.rs`, `tests/lazy_loop.rs`). It used to
   compute the farthest position the loop could reach before trying the
   rest of the pattern, which reads the rest of the input for every match.
   Now it takes its minimum and goes on; each backtrack into it checks one
   more character against the loop body and fails when that does not match
   or the loop has taken its maximum. The answers are those of before (the
   suite, and 576 answers of V8 that `jscompat` holds); the scaling test
   fails on the old code by a factor of 4.5 between two sizes, where the
   bound it allows is 3 and the new code gives about 2.

## Dropping it

When a release of regress has both changes (or equivalents), remove this
directory and the `[patch.crates-io]` entry, move `crates/Cargo.toml` to that
release, and run `crates/jscompat/tests` and both gates. Until then a new
upstream release is taken by vendoring it the same way and applying the
patches again.
