# First comparisons

The first runner comparison of each batch, kept as the runner wrote it, before
anything was fixed: the measure of the port (decision 0029, crates/README.md).

- `b1-gate.txt`: batch 1, run 43241830975 of `seuoffice rust` at 5c00b256c,
  2026-11-12. 18,839 checks over 138 functions, 18,831 equal, 8 differences
  in four classes:
  - a lone surrogate from `path.posix.relative` slicing a pair, which a Rust
    string cannot hold (1, listed);
  - `path.*.format` given a field that is not a string, which Node hands back
    as it is and the typed Rust API cannot take (5, listed);
  - the dispatcher answering `null` for `path.win32.toNamespacedPath(undefined)`
    (1, fixed);
  - the dispatcher refusing `writeProjectsSettings(path, undefined)`, which the
    TypeScript normalizes to an empty registry (1, fixed).
  The porters compared nothing before this run.
