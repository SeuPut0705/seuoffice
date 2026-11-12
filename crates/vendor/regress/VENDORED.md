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

## Dropping it

When a release of regress has both changes (or equivalents), remove this
directory and the `[patch.crates-io]` entry, move `crates/Cargo.toml` to that
release, and run `crates/jscompat/tests` and both gates. Until then a new
upstream release is taken by vendoring it the same way and applying the
patches again.
