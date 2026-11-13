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
- `b4-b5-gate.txt`: batches 4 (Electron-free modules of the apps) and 5 (the
  AI settings layer of packages/ai-provider and the modules over it), run
  43282252889 of `seuoffice rust` at 4c18ad882, 2026-11-13. 33,202 checks
  over 969 functions, 33,104 equal, 91 differences in 15 modules, 2 functions
  with a single answer. One change preceded it: the cases of
  `registerHtmlHandoffIpc` became a getter, because the spec read them before
  its builders were defined and no group could load (no case and no Rust
  changed). The porters compared nothing before this run.
- `b6-tabs-gate.txt` and `b6-apps-gate.txt`: batch 6 (the modules that call
  Electron), groups `b6-tabs` and `b6-apps`, first run on the MacBook (not a
  runner: the GitHub API limit of the account was spent), at d6f4f919e,
  2026-11-13. `b6-tabs` 151 checks, 38 differences; `b6-apps` 263 checks, 60
  differences and six functions with a single answer. All 98 were the spec:
  `require('electron')` and `import 'electron'` loaded the fake as two modules
  and only one followed `useElectron`, and a group's module fakes reached the
  modules of another group through Node's resolve cache (now each group runs
  in a process of its own). Group `b6-shell` crashed the process at its first
  run for the second reason, so it has no first output; `b6-utils` (279
  checks) differed in two cases, both listed (a language named `constructor`). No
  Rust port changed; the dispatchers of two groups did.
