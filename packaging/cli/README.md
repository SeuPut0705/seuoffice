# Command-line archive (Linux x64)

`ieumoffice` without the desktop app, for machines that only need the document
engines: agent sandboxes, servers and batch jobs. The archive carries the same
bundle the installed app ships (`cli/genoffice.cjs`), its jsdom tree, the wasm
engines and the xlsx sidecar, so a document is read and written by the same code
either way. Only the Electron runtime is gone: no GTK, no display, no app
install.

## Build

Run after the Linux packages are built (`npm run dist:linux -w @genoffice/shell`),
so `linux-unpacked/resources` exists:

```sh
node packages/cli/pack-tarball.mjs \
  --from apps/shell/release/linux-unpacked/resources \
  --out apps/shell/release --platform linux --arch x64
```

That writes `ieumoffice-cli_<version>_linux-x64.tar.gz` and its `.sha256`.
`GENOFFICE_APP_VERSION` overrides the version; without it the packer reads the
banner inside the shipped CLI bundle, so the archive cannot drift from the app.
`.github/workflows/linux-build.yml` builds, tests and uploads it with the other
Linux files.

Layout (the app's `resources/`):

```
ieumoffice-cli/
  cli/{ieumoffice, genoffice.cjs, package.json, node_modules/, skills/ieumoffice/SKILL.md}
  wasm/{pdfium.wasm, rhwp_bg.wasm, hb-subset.wasm}
  native/xlsx-sidecar
  LICENSE  NOTICE  THIRD-PARTY-NOTICES.txt
```

`cli/ieumoffice` runs `node` on the bundle when no app binary sits beside it
(`bin/ieumoffice` in `packages/cli`), so any Node 22 runs the archive.

## Install

`install.sh` in this folder is the one-line installer. It is served from the
site (`https://ieumoffice.com/cli/install.sh`); bump `DEFAULT_VERSION` in it and
publish it with the same release that carries the archive.

```sh
curl -fsSL https://ieumoffice.com/cli/install.sh | sh
```

- writes only `~/.local/share/ieumoffice-cli` (or `$XDG_DATA_HOME`) and
  `~/.local/bin/ieumoffice` (or `$XDG_BIN_HOME`); no root, no shell profile edits
- installs Node 22 from nodejs.org (checked against its `SHASUMS256.txt`) only
  when the machine has none; `--node <path>` reuses one
- verifies the archive against the release's `.sha256` before unpacking
- leaves an `ieumoffice` that belongs to another program alone
- `--uninstall` removes the launcher and the folder

## What it cannot do

The archive has no renderer, so `convert --to pdf|html|png` and `slides render`
answer `app_unavailable` (exit 4) — install the desktop app or run it under Xvfb
for those. `open` and `selection` need the app for the same reason, and API keys
the app sealed (`sealed:v1:`) cannot be opened without it.

WebAssembly is the other boundary. A sandbox that caps virtual memory
(`ulimit -v`, commonly 2 GB) cannot instantiate the PDF or Hangul engines or the
HTTP parser Node uses: those commands answer exit 3, `error: "resource_limit"`
instead of aborting, and `ieumoffice capabilities --json` reports
`detail.wasm.available: false` before an agent plans the work. DOCX, XLSX, PPTX,
Markdown, HTML, CSV and ODT work there.

## License

The archive ships `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.txt`. Node is
downloaded by the installer from nodejs.org, not redistributed with it.
