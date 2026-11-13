<p align="center"><a href="README.md">한국어</a> · <b>English</b></p>

<p align="center">
  <img src="apps/shell/build/brand/app-icon.svg" width="96" height="96" alt="SeuOffice">
</p>

<h1 align="center">SeuOffice</h1>

<p align="center">
  An office suite for the web and the PC that views and edits PDF, Word, Excel, PowerPoint and Hangul documents, and edits them with AI
</p>

<p align="center">
  <a href="https://github.com/SeuPut0705/seuoffice/releases/latest/download/SeuOffice-mac-arm64.dmg"><img src="docs/seuoffice/readme/download-mac.svg" width="300" alt="Download for macOS (Apple Silicon)"></a>
  &nbsp;
  <a href="https://github.com/SeuPut0705/seuoffice/releases/latest/download/SeuOffice-windows-x64.exe"><img src="docs/seuoffice/readme/download-windows.svg" width="300" alt="Download for Windows (x64)"></a>
</p>

<p align="center">
  <sub>Apple Silicon Mac · Windows x64 · Free · Source-available (FSL-1.1-ALv2) · <a href="https://github.com/SeuPut0705/seuoffice/releases">All versions and preview versions</a></sub>
</p>

<p align="center">
  <img src="docs/seuoffice/readme/hero.jpg" width="820" alt="SeuOffice opening PDF, DOCX, XLSX, PPTX and HWP documents on a laptop and in a browser">
</p>

## What it does

<table>
  <tr>
    <td align="center" width="33%"><img src="docs/seuoffice/readme/web-and-pc.jpg" width="220" alt=""></td>
    <td align="center" width="33%"><img src="docs/seuoffice/readme/ai-review.jpg" width="220" alt=""></td>
    <td align="center" width="33%"><img src="docs/seuoffice/readme/edit-lock.jpg" width="220" alt=""></td>
  </tr>
  <tr>
    <td valign="top"><b>The same editors on the web and the PC</b><br>The editors of the PC app run in the browser as they are. They need only static files, no conversion server, and can be embedded in another web app.</td>
    <td valign="top"><b>AI edits, a person accepts</b><br>In Word, an AI edit is recorded as a tracked change. In Hangul, Excel and PowerPoint, what the AI changed stays a suggestion and enters the document only when a person accepts it.</td>
    <td valign="top"><b>Editing together (trial stage)</b><br>Word, Excel, PowerPoint and PDF documents can be edited by several people at the same moment. It is on only when the host runs a co-editing server, and it has not been used in a real service yet. Hangul documents, and every other case, are edited by the one person who holds the edit lock while the others read.</td>
  </tr>
</table>

| Format           | View | Edit and save in the same format |     AI editing     |
| ---------------- | :--: | :------------------------------: | :----------------: |
| PDF              |  ✅  |                ✅                |         ✅         |
| Word docx        |  ✅  |                ✅                | ✅ tracked changes |
| Excel xlsx       |  ✅  |                ✅                |   ✅ suggestions   |
| PowerPoint pptx  |  ✅  |                ✅                |   ✅ suggestions   |
| Hangul hwp, hwpx |  ✅  |                ✅                |   ✅ suggestions   |

The current stage and the plan are in `docs/seuoffice/로드맵.md` (Korean).

## Install

Download with the buttons above. On both platforms the app fetches and installs new versions itself.

For now the app is released without code signing (decision 0013). The operating system blocks it once, the first time you open it.

- **Mac**: open the dmg and move SeuOffice to the Applications folder. If it is blocked the first time you open it, choose "Open Anyway" under System Settings → Privacy & Security.
- **Windows**: if a "Windows protected your PC" window appears when you run the installer, choose "More info" → "Run anyway".

## Open in the browser

The five formats open in the browser in the suite's own editors. It needs only static files, no conversion server.

- Build: `npm run build -w @seuoffice/web`. The result is `apps/web/dist/`; the first build downloads the rhwp studio from GitHub and builds the Excel engine for `wasm32-wasip1`.
- Preview: `npm run preview -w @seuoffice/web` → http://localhost:5300. Pick a file or drop one to open it.
- Test: `npm run test -w @seuoffice/web` (Playwright, after a build).

## Embedding in another web app

To embed it in another web app, use `@seuoffice/embed`.

```ts
import { openDocument } from '@seuoffice/embed'

const doc = openDocument(document.getElementById('viewer')!, {
  baseUrl: 'https://office.example/', // where apps/web/dist is served
  bytes, // ArrayBuffer or Uint8Array
  fileName: 'minutes.hwpx',
})
await doc.opened // rejects with SeuofficeEmbedError (code: unsupported_format | too_large | open_failed | timeout)
```

To let the user edit and save, the host first takes the edit lock of that document and opens it with `mode: 'edit'`. Without the lock, open it in read mode (the default). One document is edited by one person.

```ts
const doc = openDocument(viewer, {
  baseUrl,
  bytes,
  fileName: 'minutes.hwpx',
  mode: 'edit',
  // when the user saves, the bytes arrive in the same format under the same name; rejecting shows a failed save on screen
  onSave: async ({ fileName, bytes }) => uploadNewVersion(fileName, bytes),
  onDirtyChange: (dirty) => setUnsaved(dirty),
})
await doc.save() // when the host makes it save before closing; rejects with SeuofficeEmbedError (code: save_failed)
```

The host owns the lock (decision 0008). Give the lock an expiry and extend it while the editing screen is open. In `onSave`, check that the lock is still yours and that the save lands on the version you opened, and reject otherwise. When someone asks to take over, call `doc.save()` and then release the lock.

To let several people edit at the same moment, pass `collab` and run the co-editing server (`@seuoffice/collab/server`, decision 0023). It is at a trial stage. What works per format, what the host has to do, and what was and was not checked are in [`docs/seuoffice/공동-편집.md`](docs/seuoffice/공동-편집.md) (Korean).

To turn on the AI assistant inside the document, pass `ai` (in both view and edit modes). The page holds no token. For each AI turn it hands the host an OpenAI Chat Completions request body (`gateway-complete`, decision 0009), and the host calls the gateway with its own login token and returns the response as it is (decision 0017).

```ts
const doc = openDocument(viewer, {
  baseUrl,
  bytes,
  fileName: 'minutes.docx',
  mode: 'edit',
  onSave,
  ai: {
    request: (body, signal) =>
      fetch(`${gatewayUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal, // aborted when the user stops or doc.destroy() is called
      }),
  },
})
```

Without `ai`, the AI shows as "not connected" and no request arrives. Pass `ai` only for people who may use AI, and limit the number of requests and the amount of tokens per person and per document on the host side. Return a refusal as a non-2xx response such as 429 and the page shows the same wording as the desktop app. Of the response headers only `Content-Type` and `Retry-After` reach the page. Do not put a token in an error body. AI runs on the web for all five formats. The AI editing tool for pptx on the web is `apply_ops` alone.

What to keep to in operation:

- The SeuOffice page needs `script-src 'self' 'wasm-unsafe-eval'` and `worker-src 'self' blob:` in its CSP (pdf.js, rhwp and the Excel engine use WASM and workers).
- The host page lists the SeuOffice origin in `frame-src`.
- To send documents from another origin, give `VITE_SEUOFFICE_EMBED_ORIGINS` (a comma-separated list of origins) when you build SeuOffice. Documents sent by an origin that is not on the list are not accepted.
- The file size limit is 50 MiB (`MAX_EMBED_BYTES`).
- Serve the static files compressed (brotli or gzip). `application/wasm` and fonts (`font/ttf`, `font/otf`) are often missing from a server's default compression list, so add them yourself. Uncompressed, the first open of a Hangul document downloads 30.8 MB; with brotli it is 9.6 MB (per-format figures are in `apps/web/README.md`).

## Ownership and boundaries

- SeuOffice is the personal asset of SeuPut (GitHub SeuPut0705). It is made on SeuPut's own time and at SeuPut's own cost, and is not a deliverable of a contract with Yuyu Healthcare. Yuyu Healthcare is a user that takes SeuOffice and uses it.
- The code, settings and data of the Yuyu Healthcare repository (`yuyuhealthcare/yuyu-mos`) are not brought into this repository. Neither are Yuyu's real data or customers' original documents. Tests use mock documents and documents whose rights have been checked.
- The code that connects SeuOffice to Yuyu's messenger and work apps (handing an attachment to the viewer, checking permissions) lives in yuyu-mos. SeuOffice provides a "bytes + file name → screen" part (`@seuoffice/embed`) and a static web bundle.
- The whole repository is public (`docs/seuoffice/decisions/0007-전부-공개.md`). From <FSL_FIRST_VERSION> it is source-available under FSL-1.1-ALv2, not open source (`docs/seuoffice/decisions/0031-라이선스-FSL.md`, draft). Yuyu Healthcare takes the versioned `@seuoffice/*` bundles and the stable PC app for Yuyu; whether that use is a permitted purpose under the FSL, or needs a separate grant, is settled in decision 0031.

## Development

- Node 22 or newer, npm 10 or newer. Rust stable (the Excel engine), and the `wasm32-wasip1` target for the web build.
- `npm ci`, then `npm run shell` to run the desktop app. The other commands and the working rules are in `AGENTS.md` (Korean).

## License and origin

- From <FSL_FIRST_VERSION>, FSL-1.1-ALv2 (`LICENSE`): you may use, modify and redistribute it for any purpose other than a competing use, and each version is also available under Apache-2.0 two years after its release. Earlier versions, and the parts that come from GenOffice and IeumOffice, are under Apache-2.0 (`LICENSE-APACHE`). The notices are in `NOTICE`.
- Based on: IeumOffice https://github.com/pblsketch/ieumoffice (imported at commit aea1414), and its original, GenOffice https://github.com/genspark-ai/genoffice. GenOffice's `ee/` (Enterprise License) is not included.
- The Hangul engine rhwp (MIT, Edward Kim) and its IeumOffice-patched build (`vendor/rhwp-core`).

The Hangul (HWP/HWPX) editor is built on
[rhwp](https://github.com/edwardkim/rhwp) (MIT License). As Hancom requires of
software made with its published HWP format document, we state:

> 본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여
> 개발하였습니다.
>
> (This product was developed with reference to Hancom's published document
> on the Hangul document file format (.hwp).)

The diagram editor is built on the web editor of
[draw.io](https://github.com/jgraph/drawio) (Apache License 2.0). Parts under
licenses outside the project's allowlist (the PlantUML converter, libavoid and
ELK) are left out; what was left out and how is listed in the installed
`THIRD-PARTY-NOTICES.txt`. SeuOffice is not affiliated with or endorsed by
the company that makes draw.io.

The slide design templates are re-authored from the designs in
[frontend-slides](https://github.com/zarazhangrui/frontend-slides) (MIT
License), and their fonts are all licensed under the SIL Open Font License
1.1; [NOTICE](NOTICE) carries the notice and the font list. The templates'
Korean font pairings referred to [k-slide](https://k-slide.web.app).

SeuOffice is not affiliated with, sponsored by or endorsed by Genspark /
Mainfunc, Inc., the IeumOffice contributors, Anthropic, OpenAI, Microsoft,
Hancom, Adobe, XMind Ltd. or Google. The names GenOffice and IeumOffice
(이음오피스) identify the original works only. "GenOffice" and "Genspark", and
their logos, are trademarks of their owners; so are "Claude", "Codex" and
"ChatGPT". "Microsoft", "Windows", "Word", "Excel" and "PowerPoint" are
trademarks of Microsoft Corporation; "한글" (Hangul), "한컴" (Hancom), "HWP"
and "HWPX" are registered trademarks of Hancom Inc.; "XMind" is a trademark of
XMind Ltd.; and "Google Drive" is a trademark of Google LLC. Other product
names in this document belong to their owners. They are named here only to say
what this software is based on, what it works with and which files it opens.

### No warranty

SeuOffice is provided as is, without warranties of any kind, under the
disclaimer of the Functional Source License 1.1 (and, for the parts under it,
sections 7 and 8 of the Apache License 2.0). AI-generated content can be wrong:
check it before you use it. Making sure you have the right to use it is up to
you.
