# ipc-diff

The parity gate of stage 3 (the stage 3 shell contract under `docs/seuoffice`, section 8): each IPC
channel's Rust handler (`crates/shell-ipc/<batch>`, run by `crates/ipc-probe` through the shell's
own dispatch in `crates/shell-core`) against the TypeScript `ipcMain` handler it replaces, run on
`tools/main-diff`'s fake Electron.

```sh
npm --prefix tools/ipc-diff run gate                       # every group, each in a process of its own
npm --prefix tools/ipc-diff run gate -- --group w/quick-look --show 20
npm --prefix tools/ipc-diff run gate -- --channel quick-look:set-settings
npm --prefix tools/ipc-diff run gate -- --require W        # and the coverage of batch W
node tools/ipc-diff/faults.mjs tools/ipc-diff/faults/w.json
```

## A group

`groups/<batch>/<name>.ts` (the batch folder in lower case) exports `group: Group` (`types.ts`):

- `batch`: `'W'`, `'D1'`, ...
- `load(cx)`: registers the TypeScript handlers for one case. Install what the module needs on
  `cx.electron` (it already has `ipcMain`, `webContents`, `BrowserWindow`, `app`, `dialog`, `shell`,
  `clipboard`, `nativeImage`; add names with `Object.assign`), then load the module that calls
  `ipcMain.handle/on`. `cx.fresh(path)` loads a module afresh for the case, so module state
  (`let deps`, `ipcRegistered`) starts over; `path` is relative to the repository. Configure the
  module as the app's entry (`*-main`, `shell/index`) configures it, with the same file paths under
  `cx.dir`.
- `cases`: each case runs on a fresh world on both sides.
- `single`: `{channel: why}` for a channel whose one answer is all there is.

### A case

```ts
{
  note: 'why the case is there',
  views: [{ view: 1, window: 1, surface: 'Shell' }],   // the default
  files: { 'userData/app-settings.json': '{"lang":"ko"}' },  // main-diff's FileSpec
  hosts: { shared: {...}, w: {...}, d2: {...} },          // what the fake hosts answer
  calls: [{ channel: 'quick-look:set-settings', kind: 'invoke', view: 1, args: [{ keepInTray: true }] }],
}
```

- `surface` is a `Surface` of `crates/shell-contract` (`Shell`, `Docs`, `ShellDocPicker`, ...). A
  call from a surface the channel's spec does not list is refused by the shell; the TypeScript side
  answers the same refusal.
- `args` are written in the wire form (`crates/shell/bridge/wire.ts`): plain JSON, plus `{"$":"u"}`
  for `undefined`, `{"$":"b","k":"u8","i":0}` for bytes (with `buffers: ['00ff']` as hex),
  `{"$":"d","v":ms}` for a date.
- `$DIR` in any string is the case's folder. `app.getPath(name)` is `$DIR/<name>` on both sides
  (`userData`, `temp`, `documents`, ...).

### A trigger

Some events no handler emits: a native menu item's click, a right-click. A `trigger` call runs such
a thing on both sides and compares what it emitted:

```ts
{ channel: 'm/menu:docs:File > Save', kind: 'trigger', name: 'm/menu:docs:File > Save', view: 1, args: [] }
```

- `name` is `<batch>/<what>` (batch in lower case); `args` is plain JSON. `channel` repeats the
  name; a trigger is left out of the coverage of channels, and the events it emits count for the
  coverage of events.
- TypeScript: `Group.triggers[name](cx, view, args)` runs after `load` (`cx` is the load context
  plus `contents(view)`). What it resolves to is the answer, `{value, buffers}`; a throw is
  `{error: String(err)}`, without Electron's remote-method sentence. A name the group lacks answers
  `{thrown: "unknown trigger <name>"}`.
- Rust: a batch crate exports, behind its `probe` feature next to `probe_hosts`,

  ```rust
  pub fn probe_trigger(name: &str, view: ViewId, args: &serde_json::Value,
      services: &Services, provided: &Rc<Provided>, then: Then<IpcValue>) -> bool
  ```

  (false: not its name), and calls `then` with the outcome. ipc-probe runs it on the core thread
  through one `match` arm on the name's prefix in `run_case`; the batch that adds its export adds
  its arm. Today only `m`. The answer is `{value, buffers}` or `{error: String(err)}`, as above.

- The fakes a trigger needs: `Menu` (`buildFromTemplate`, `popup` recorded as the last popped menu,
  `setApplicationMenu`, `getApplicationMenu`), `app.on('web-contents-created')` replayed for each
  view's contents after `load`, and `webContents.on/once/emit`.

### Deferred invokes and triggers

A handler or a trigger that waits for another call of the renderer (a close check answered by
`close-check-result`, a save request answered by its ack) is compared on its full path: give the
invoke (or the trigger) `defer: true`, then the renderer's answering call, then
`{ channel: '', args: [], await: <index of the deferred call> }`. The deferred call's own answer is
`{deferred: true}`; the await step's answer is the invoke's reply (`{timeout: true}` after 20 s);
every step records its events as a call does.

### What is compared

For every call: the answer (`{value, buffers}`, `{error}` with Electron's
`Error invoking remote method '<ch>': ...` sentence, `{}` or `{thrown}` for a send), and the events
it emitted (`{view, channel, args, buffers}`, one per view reached, in order). Then the host log of
the case and the folder after the last call (kind, mode, contents). Each side's folder is written
`$DIR` (in lower case too, as a case-folding path key writes it); the temporary file of an atomic
write is written `.$PID.$UUID.tmp`.

### Coverage (`--require <batch>`)

Every invoke, send and sendSync channel of the batch is called by some case; every one called with
arguments gave two distinct answers (or is in `single`); every event channel of the batch was
emitted by some call.

## Hosts in the probe

`crates/ipc-probe` builds a fresh `Services` per case: a real core thread, a UI thread, workers it
waits for, the case's views, `CasePaths` under the folder, an `EventSink` that records, and `Hosts`:

- **Shared hosts** (W, `crates/ipc-probe/src/fakes.rs`, mirrored by `fakes.ts`): `DialogsHost`,
  `OsShellHost`, `ClipboardHost`, `ContentsHost`, `MainWindowHost`, and the process's one
  `Arc<Mutex<SharedRecoveryState>>`. They answer from `hosts.shared`:

  | key               | shape                                                                                                               |
  | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
  | `dialogs.open`    | list of answers, one per `showOpenDialog`: a list of paths, or `null` (cancelled); cancelled when the list runs out |
  | `dialogs.save`    | the same for `showSaveDialog`: a path or `null`                                                                     |
  | `dialogs.message` | `[{response, checkboxChecked}]` per `showMessageBox`; `{response: 0}` when it runs out                              |
  | `osShell`         | `{openPath: "<error text>", openExternalError, trashError}`; all succeed by default                                 |
  | `clipboard`       | `{text, html, imagePng: hex, formats: [...]}` before the case                                                       |
  | `contents`        | `{capturePng: hex, pdf: hex, print: bool, zoom: {"<view>": factor}}`                                                |
  | `mainWindow`      | `{view, window}`; the first `Shell` view by default                                                                 |
  | `recoveryRunId`   | the run id of the recovery state, `0000000000000000` by default                                                     |

  Each call is one log line named after the Electron call it fakes:
  `["dialog.showOpenDialog", parentWindowId|null, options]`, `["shell.openPath", path]`,
  `["clipboard.writeText", text]`, `["webContents.printToPDF", view, options]`, ... Options are
  written with Electron's keys, absent and empty fields left out.

- **Batch hosts.** Each batch crate exports, behind its `probe` cargo feature,

  ```rust
  #[cfg(feature = "probe")]
  pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value)
  ```

  which inserts the fakes of its own hosts, answering from `case`: the case's `hosts.<batch>` value
  (`hosts.d1` for D1; `Null` when absent). A fake that logs takes the case's log with
  `hosts.get::<Arc<Mutex<Vec<serde_json::Value>>>>()` (a type alias of the same type in your crate
  names the same entry), inserted before any `probe_hosts` runs; push one JSON array per call, named
  after the Electron or app call it fakes, and make the TypeScript side of the group log the same
  line (`cx.electron.log.push(...)`).

ipc-probe registers all six batches as they stand (a missing handler answers
`No handler registered`, as Electron would), then runs the calls one after another through the
dispatch, waiting after each until the workers are idle and the core and UI queues are drained.

## Ledger and faults

- `divergences.json`: `{id, group, case, typescript, rust, reason}`, the two records as the gate
  printed them. A listed difference that no longer reproduces fails the gate.
- `faults/<batch>.json`: `{name, file, find, replace, groups}`; `file` is under `crates/`, `find`
  occurs once. The first entry is the positive control. Every fault must be CAUGHT.
