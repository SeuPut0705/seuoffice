# First comparisons

The first runner comparison of each batch, kept as the runner wrote it, before
anything was fixed: the measure of the port (decision 0030, crates/README.md).

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
- `b2-b3-gate.txt`: batches 2 and 3 with the libuv error table (group
  `node-fs`), run 43263867963 of `seuoffice rust` at 8599708b5, 2026-11-13.
  25,418 checks over 518 functions, 25,294 equal, 118 differences in six
  modules (safe-remote-url 49, remote-table 47, remote-image 15,
  update-resume 4, legacy-import-prefs 2, window-close-guard 1), and 95
  functions with a single answer, most of them constants without the
  `single` waiver. `node-fs-windows-gate.txt`: the same run's group `node-fs`
  on windows-latest, 61 checks, 47 differences. The porters compared nothing
  before this run.
