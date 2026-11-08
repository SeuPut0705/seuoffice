# HTML math extension

This built-in module adapts [Meditor](https://github.com/CauchyRiemannEquations/Meditor)'s formula-editing workflow: a MathLive visual
field, synchronized LaTeX source, formula templates, and editable error states.
It is registered by the HTML app's ribbon and preview inspector. It is not a
separately installable third-party plugin or a general plugin loader.

## Boundaries

- `model.ts` owns the small `{ latex, display }` value and bounded, untrusted
  KaTeX rendering. It has no editor, filesystem or IPC dependency.
- `MathDialog.tsx` owns the edit session and callbacks. MathLive and its fonts
  load locally, on first use. The dialog does not save documents itself.
- `html-adapter.ts` reads source objects and produces the host's existing
  `HtmlOp` edits. No whole-document parsing/serialization is used for edits.
- `useMathExtension.tsx` connects the dialog to the host's undo/save pipeline.
  The source, document identity and parse-map version must still match the
  session before applying. A conflict leaves the draft available to copy.

The value/editor boundary can be reused by a future host with its own storage
adapter. This change only registers an HTML adapter; other editors are unaffected.

## Persistence

New objects use a `span` with `data-gx-math="1"`, `data-latex`, `data-display`,
and `contenteditable="false"`. Children contain static MathML with a LaTeX
annotation, generated with `trust: false`, expansion and size limits. Saved
HTML needs no MathLive, KaTeX script, CDN or stylesheet to display its equations
in the app's Chromium browser. Unsupported syntax is saved as escaped code,
with the original LaTeX still available for correction.

Existing Meditor `span`/`div` objects carrying `data-latex` are editable too.
Their unrelated attributes are preserved, and applying an unchanged formula
does not replace their rendering. Unknown `data-gx-math` versions are left alone.
Raw `$...$` text, arbitrary MathJax output and images without LaTeX metadata
are not automatically converted.

Inline insertion appends to the selected paragraph; display insertion uses
the existing insertion position after the selection or at the end of the body.
Clicking an equation in edit mode opens the dialog. Presentation mode leaves
the page's interactions alone.

## Verification

Run `npm run test -w @genoffice/html` and
`npm run typecheck -w @genoffice/html` from the repository root. The math tests
cover static rendering, source preservation, file save/reopen/re-edit, undo
patches, Meditor markup, escaping, unsupported syntax and preview routing.
Also verify the built Electron app's visual input, virtual keyboard, native
save/reopen and responsive dialog with the local acceptance driver.
