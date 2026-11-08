/**
 * The dialog design system for the HWP editor (rhwp-studio).
 *
 * Every settings dialog in the editor is a `.modal-overlay` holding a
 * `.dialog-wrap` built by the studio's ModalDialog base: a title bar, a body,
 * and a footer with the confirm/cancel buttons. The cell-properties dialog,
 * the click-here (누름틀) dialog with its memo field, page setup, character
 * shape and the rest of the editor's modal dialogs all share that skeleton.
 * This module gives that one skeleton a Hangul-like look, so a new dialog gets
 * the same design without writing CSS of its own.
 *
 * The skin is a runtime style sheet, not a build patch. The studio is rebuilt
 * from an upstream tag (scripts/build-studio.mjs), and its own dialog CSS must
 * keep working as-is; injecting our layer after it lets us refine the look
 * without touching vendored source. Colours, shape, depth and motion live in
 * the `--ieum-dialog-*` tokens below. Dialog bodies should use those tokens (or
 * the existing studio tokens) rather than a raw hex value.
 *
 * Design notes (docs/plans/hwp-dialog-design.md):
 * - paper-like surfaces, ink text, and one blue accent line: the editor's
 *   chrome is a document tool, so the dialog should feel like paper on a desk,
 *   not like a web card.
 * - compact office density: 12px text, 26-30px controls, 4-8px radii.
 * - one accent per dialog, the primary button; everything else is neutral,
 *   so form fields stay easy to scan. No accent stripes or bars on the edge of
 *   a dialog or in front of a heading.
 * - the user's "oldschool" studio skin is respected: while that skin is on,
 *   this layer turns itself off.
 * - the look wins, the layout does not: rhwp sizes some dialogs on their own
 *   (`.pp-dialog .dialog-label`, `.cs-dialog .dialog-body`, hiding the footer
 *   while a PDF is prepared). Rules that set a size, a margin, a scroll or
 *   whether something shows go under `:where(:root[...])`, which weighs the
 *   same as rhwp's own base rule. Ours comes later in <head>, so it replaces
 *   the base rule and a dialog's own rule still beats it.
 */

/** Bumped when the tokens or the skeleton changes in a way previews rely on. */
export const DIALOG_THEME_VERSION = 1

/** The style element's id, also used to keep installation idempotent. */
export const DIALOG_THEME_STYLE_ID = 'ieum-dialog-theme'

/** Root attribute that scopes every selector in this file. */
export const DIALOG_THEME_ATTRIBUTE = 'data-ieum-dialog-theme'

/**
 * The complete skin. Kept as a string because the studio plugin is bundled by
 * Vite from plain `.mjs`; a CSS import would need a separate build rule. The
 * tokens are the public part: consumers style dialog bodies with
 * `var(--ieum-dialog-*)`, and changing a token updates every dialog.
 */
export const DIALOG_THEME_CSS = `
/* ─────────────────────────────────────────────────────────────
   1. Tokens — light
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] {
  --ieum-dialog-font: 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo',
    'Noto Sans KR', 'Segoe UI', sans-serif;

  /* surfaces: warm paper in light mode, slate in dark mode */
  --ieum-dialog-surface: #fdfdfb;
  --ieum-dialog-surface-sunken: #f5f6f8;
  --ieum-dialog-title-surface: #f1f4f8;
  --ieum-dialog-field-surface: #ffffff;

  /* ink */
  --ieum-dialog-ink: #24292f;
  --ieum-dialog-ink-muted: #667085;
  --ieum-dialog-ink-hint: #6f7889;
  --ieum-dialog-ink-disabled: #98a1af;
  --ieum-dialog-title-ink: #1f2937;

  /* lines */
  --ieum-dialog-line: #d8dee7;
  --ieum-dialog-line-soft: #e7ebf0;
  --ieum-dialog-field-line: #c7cfda;

  /* one accent: Hancom-blue, softened */
  --ieum-dialog-accent: #2f6fd0;
  --ieum-dialog-accent-strong: #245bb0;
  --ieum-dialog-accent-soft: #eaf1fc;
  --ieum-dialog-accent-line: #b9cdf0;
  --ieum-dialog-accent-ink: #ffffff;
  --ieum-dialog-focus: #2f6fd0;
  --ieum-dialog-danger: #b42318;

  /* shape and depth */
  --ieum-dialog-radius: 8px;
  --ieum-dialog-radius-control: 4px;
  --ieum-dialog-shadow-color: rgba(20, 30, 48, 0.24);
  --ieum-dialog-shadow-soft: rgba(20, 30, 48, 0.12);
  --ieum-dialog-shadow: 0 24px 64px var(--ieum-dialog-shadow-color),
    0 3px 10px var(--ieum-dialog-shadow-soft);
  --ieum-dialog-overlay: rgba(16, 24, 40, 0.34);
  --ieum-dialog-control-shadow: 0 1px 1px rgba(20, 30, 48, 0.04);
  --ieum-dialog-primary-shadow-color: rgba(20, 30, 48, 0.18);
  --ieum-dialog-primary-highlight: rgba(255, 255, 255, 0.18);
  --ieum-dialog-primary-shadow: 0 1px 2px var(--ieum-dialog-primary-shadow-color),
    inset 0 1px 0 var(--ieum-dialog-primary-highlight);
  --ieum-dialog-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ieum-dialog-field-shadow: inset 0 1px 2px rgba(20, 30, 48, 0.06);
}

/* ─────────────────────────────────────────────────────────────
   2. Tokens — dark (the host sets data-theme-effective)
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}][data-theme-effective='dark'] {
  --ieum-dialog-surface: #2a2f36;
  --ieum-dialog-surface-sunken: #242930;
  --ieum-dialog-title-surface: #323841;
  --ieum-dialog-field-surface: #22272e;

  --ieum-dialog-ink: #e7ebf1;
  --ieum-dialog-ink-muted: #aeb8c6;
  --ieum-dialog-ink-hint: #a6b0be;
  --ieum-dialog-ink-disabled: #7f8997;
  --ieum-dialog-title-ink: #eef2f7;

  --ieum-dialog-line: #454d58;
  --ieum-dialog-line-soft: #39414b;
  --ieum-dialog-field-line: #525c6a;

  --ieum-dialog-accent: #7aa7f0;
  --ieum-dialog-accent-strong: #b7d0ff;
  --ieum-dialog-accent-soft: #2a3b55;
  --ieum-dialog-accent-line: #3f5a80;
  --ieum-dialog-accent-ink: #111a2b;
  --ieum-dialog-focus: #8bb8ff;
  --ieum-dialog-danger: #ff9a8f;

  --ieum-dialog-shadow-color: rgba(0, 0, 0, 0.55);
  --ieum-dialog-shadow-soft: rgba(0, 0, 0, 0.4);
  --ieum-dialog-shadow: 0 28px 80px var(--ieum-dialog-shadow-color),
    0 2px 8px var(--ieum-dialog-shadow-soft);
  --ieum-dialog-overlay: rgba(0, 0, 0, 0.52);
  --ieum-dialog-control-shadow: 0 1px 1px rgba(0, 0, 0, 0.22);
  --ieum-dialog-primary-shadow-color: rgba(0, 0, 0, 0.35);
  --ieum-dialog-primary-highlight: rgba(255, 255, 255, 0.3);
  --ieum-dialog-primary-shadow: 0 1px 3px var(--ieum-dialog-primary-shadow-color),
    inset 0 1px 0 var(--ieum-dialog-primary-highlight);
  --ieum-dialog-field-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28);
}

/* ─────────────────────────────────────────────────────────────
   3. Motion
   ───────────────────────────────────────────────────────────── */
@keyframes ieum-dialog-veil-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes ieum-dialog-in {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* ─────────────────────────────────────────────────────────────
   4. The modal shell
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] .modal-overlay {
  background: var(--ieum-dialog-overlay);
  padding: 20px;
  animation: ieum-dialog-veil-in 140ms ease-out both;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-wrap {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 40px);
  overflow: hidden;
  background: var(--ieum-dialog-surface);
  border: 1px solid var(--ieum-dialog-line);
  border-radius: var(--ieum-dialog-radius);
  box-shadow: var(--ieum-dialog-shadow);
  color: var(--ieum-dialog-ink);
  font-family: var(--ieum-dialog-font);
  font-size: 12px;
  line-height: 1.45;
  color-scheme: inherit;
  animation: ieum-dialog-in 180ms var(--ieum-dialog-ease) both;
}

/* ─────────────────────────────────────────────────────────────
   5. Title bar and close button
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-title {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 46px;
  padding: 0 10px 0 20px;
  background: var(--ieum-dialog-title-surface);
  border-bottom: 1px solid var(--ieum-dialog-line);
  color: var(--ieum-dialog-title-ink);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  cursor: move;
  user-select: none;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-close {
  flex: 0 0 auto;
  margin-left: auto;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--ieum-dialog-radius-control);
  background: transparent;
  color: var(--ieum-dialog-ink-muted);
  font-family: var(--ieum-dialog-font);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-close:hover {
  background: color-mix(in srgb, var(--ieum-dialog-ink) 8%, transparent);
  color: var(--ieum-dialog-ink);
}

/* ─────────────────────────────────────────────────────────────
   6. Body and footer
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-wrap .dialog-body {
  flex: 1 1 auto;
  padding: 18px 20px 16px;
  overscroll-behavior: contain;
}

/* The body scrolls inside the capped shell. Some dialogs keep a fixed body
   height (character shape) or scroll their own panels (object properties). */
:where(:root[${DIALOG_THEME_ATTRIBUTE}]) .dialog-body {
  min-height: 0;
  overflow: auto;
}

/* rhwp lays the footer out as a flex row and hides it while a PDF is being
   prepared, so this rule leaves display alone. */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-wrap .dialog-footer {
  flex: 0 0 auto;
  padding: 13px 20px 15px;
  background: var(--ieum-dialog-surface-sunken);
  border-top: 1px solid var(--ieum-dialog-line-soft);
}

/* Dialogs that open with tabs put them on the top edge of the body. */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-body > .dialog-tabs:first-child {
  margin: -18px -20px 14px;
}

/* The click-here (누름틀) dialog wraps its tab and form in .field-edit-body;
   let the form own the padding so the tab strip and fields line up with the
   title instead of being inset twice. */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-body.field-edit-body,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-body:has(> .field-edit-body) {
  padding: 0;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-body > .dialog-tabs:first-child {
  margin: 0;
}

/* ─────────────────────────────────────────────────────────────
   7. Buttons
   ───────────────────────────────────────────────────────────── */
:where(:root[${DIALOG_THEME_ATTRIBUTE}]) .dialog-btn {
  min-width: 74px;
  cursor: pointer;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn {
  height: 30px;
  padding: 0 16px;
  border: 1px solid var(--ieum-dialog-field-line);
  border-radius: var(--ieum-dialog-radius-control);
  background: var(--ieum-dialog-field-surface);
  color: var(--ieum-dialog-ink);
  font-family: var(--ieum-dialog-font);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  box-shadow: var(--ieum-dialog-control-shadow);
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    box-shadow 120ms ease,
    transform 80ms ease;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn:hover {
  background: color-mix(in srgb, var(--ieum-dialog-ink) 5%, var(--ieum-dialog-field-surface));
  border-color: var(--ieum-dialog-field-line);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn:active {
  transform: translateY(1px);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn-primary {
  background: var(--ieum-dialog-accent);
  border-color: var(--ieum-dialog-accent);
  color: var(--ieum-dialog-accent-ink);
  box-shadow: var(--ieum-dialog-primary-shadow);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn-primary:hover {
  background: var(--ieum-dialog-accent-strong);
  border-color: var(--ieum-dialog-accent-strong);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn:focus-visible,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-close:focus-visible,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-tab:focus-visible {
  outline: 2px solid var(--ieum-dialog-focus);
  outline-offset: 2px;
}

/* A filled button already has the accent; a second hard blue keyline reads as
   a rendering fault. Use the same soft halo language as the fields instead. */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn-primary:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--ieum-dialog-focus) 40%, transparent);
  outline-offset: 1px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn:disabled,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn:disabled:hover {
  background: var(--ieum-dialog-surface-sunken);
  border-color: var(--ieum-dialog-line-soft);
  color: var(--ieum-dialog-ink-disabled);
  box-shadow: none;
  transform: none;
}

/* With the pointer cursor above, this stays below the compare dialog's own
   wait cursor on its busy buttons. */
:where(:root[${DIALOG_THEME_ATTRIBUTE}]) .dialog-btn:disabled {
  cursor: not-allowed;
}

/* The small segmented controls some dialogs use for alignment/direction. */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn-group button {
  min-width: 38px;
  height: 28px;
  border-color: var(--ieum-dialog-field-line);
  background: var(--ieum-dialog-field-surface);
  color: var(--ieum-dialog-ink);
  font-family: var(--ieum-dialog-font);
  font-size: 11px;
  cursor: pointer;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn-group button:hover {
  background: var(--ieum-dialog-accent-soft);
}

/* A tonal selected state keeps the solid accent for the one committing
   action (the footer's primary button) and the dialog's blue edge. */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn-group button.active {
  background: var(--ieum-dialog-accent-soft);
  border-color: var(--ieum-dialog-accent-line);
  color: var(--ieum-dialog-accent-strong);
  box-shadow: inset 0 0 0 1px var(--ieum-dialog-accent-line);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn-group button:disabled,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn-group button:disabled:hover,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn-group button.active:disabled {
  background: var(--ieum-dialog-surface-sunken);
  border-color: var(--ieum-dialog-line-soft);
  color: var(--ieum-dialog-ink-disabled);
  box-shadow: none;
  cursor: not-allowed;
}

/* The tiny "apply to all" spinners inside the cell-properties dialog. */
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-all-spinner-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--ieum-dialog-field-line);
  border-radius: var(--ieum-dialog-radius-control);
  background: var(--ieum-dialog-field-surface);
  color: var(--ieum-dialog-ink-muted);
  font-size: 9px;
  line-height: 22px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-all-spinner-btn:hover {
  background: var(--ieum-dialog-accent-soft);
  border-color: var(--ieum-dialog-accent-line);
  color: var(--ieum-dialog-ink);
}

/* Border/shading pickers in the same dialog: same hairline and accent as the
   rest of the system, so the tabs do not fall back to the old beveled look. */
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-line-type-grid {
  border-color: var(--ieum-dialog-line);
  border-radius: 5px;
  background: var(--ieum-dialog-field-surface);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-line-type-item {
  border-radius: 3px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-line-type-item:hover {
  border-color: var(--ieum-dialog-accent-line);
  background: var(--ieum-dialog-accent-soft);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-line-type-item.active {
  border-color: var(--ieum-dialog-accent);
  background: var(--ieum-dialog-accent-soft);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-dir-btn,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-diag-btn {
  border-color: var(--ieum-dialog-field-line);
  border-radius: var(--ieum-dialog-radius-control);
  background: var(--ieum-dialog-field-surface);
  color: var(--ieum-dialog-ink-muted);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-dir-btn:hover,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-diag-btn:hover {
  border-color: var(--ieum-dialog-accent-line);
  background: var(--ieum-dialog-accent-soft);
  color: var(--ieum-dialog-ink);
}

/* The chosen diagonal line. Restyling the button above would otherwise hide
   rhwp's own selected state. */
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-diag-btn.active {
  border-color: var(--ieum-dialog-accent);
  background: var(--ieum-dialog-accent-soft);
  color: var(--ieum-dialog-accent-strong);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-diag-btn:disabled,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-diag-btn:disabled:hover {
  border-color: var(--ieum-dialog-line-soft);
  background: var(--ieum-dialog-surface-sunken);
  color: var(--ieum-dialog-ink-disabled);
  cursor: not-allowed;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-border-preview-svg,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-bg-preview {
  border-color: var(--ieum-dialog-line);
  border-radius: 4px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-page-border-group {
  border-color: var(--ieum-dialog-line-soft);
  border-radius: 5px;
  background: var(--ieum-dialog-surface-sunken);
}

/* The cell dialog disables a whole row with .tcp-disabled (not the disabled
   attribute). Recolor its parts explicitly instead of fading the row: a
   half-transparent active chip still reads as "selected". */
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-disabled {
  opacity: 1;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-disabled .dialog-label,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-disabled .dialog-unit {
  color: var(--ieum-dialog-ink-disabled);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-disabled .dialog-input,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-disabled .dialog-select,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-disabled .tcp-all-spinner-btn {
  background: var(--ieum-dialog-surface-sunken);
  border-color: var(--ieum-dialog-line-soft);
  color: var(--ieum-dialog-ink-disabled);
  box-shadow: none;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-disabled .dialog-btn-group button,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-disabled .dialog-btn-group button.active {
  background: var(--ieum-dialog-surface-sunken);
  border-color: var(--ieum-dialog-line-soft);
  color: var(--ieum-dialog-ink-disabled);
  box-shadow: none;
}

/* ─────────────────────────────────────────────────────────────
   8. Tabs — paper folder tabs with one blue rule
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-tabs {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  padding: 6px 12px 0;
  background: var(--ieum-dialog-surface-sunken);
  border-bottom: 1px solid var(--ieum-dialog-line);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-tab {
  position: relative;
  margin-bottom: -1px;
  padding: 7px 15px 8px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 5px 5px 0 0;
  background: transparent;
  color: var(--ieum-dialog-ink-muted);
  font-family: var(--ieum-dialog-font);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease,
    border-color 120ms ease;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-tab:hover {
  background: color-mix(in srgb, var(--ieum-dialog-accent) 8%, transparent);
  color: var(--ieum-dialog-ink);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-tab.active {
  background: var(--ieum-dialog-surface);
  border-color: var(--ieum-dialog-line);
  border-bottom-color: var(--ieum-dialog-surface);
  color: var(--ieum-dialog-ink);
  font-weight: 600;
  box-shadow: inset 0 2px 0 var(--ieum-dialog-accent);
}

/* A one-tab strip is a label with no choice to make: the dialog title already
   says what it is. (The click-here dialog is the one that ships this way.) */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-tabs:has(> .dialog-tab:only-child) {
  display: none;
}

/* The editor's older goto dialog uses a private copy of the same tab shape. */
:root[${DIALOG_THEME_ATTRIBUTE}] .goto-tab-bar {
  display: flex;
  gap: 2px;
  padding: 0 0 0 2px;
  border-bottom: 1px solid var(--ieum-dialog-line);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .goto-tab-btn {
  margin-bottom: -1px;
  padding: 7px 15px 8px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 5px 5px 0 0;
  background: transparent;
  color: var(--ieum-dialog-ink-muted);
  font-family: var(--ieum-dialog-font);
  font-size: 12px;
  cursor: pointer;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .goto-tab-btn:hover {
  background: color-mix(in srgb, var(--ieum-dialog-accent) 8%, transparent);
  color: var(--ieum-dialog-ink);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .goto-tab-btn.active {
  background: var(--ieum-dialog-surface);
  border-color: var(--ieum-dialog-line);
  border-bottom-color: var(--ieum-dialog-surface);
  color: var(--ieum-dialog-ink);
  font-weight: 600;
  box-shadow: inset 0 2px 0 var(--ieum-dialog-accent);
}

/* ─────────────────────────────────────────────────────────────
   9. Sections, rows and labels
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-section {
  padding: 12px 14px;
  border: 1px solid var(--ieum-dialog-line-soft);
  border-radius: 5px;
  background: var(--ieum-dialog-surface-sunken);
}

/* Page setup puts sections side by side with no bottom margin. */
:where(:root[${DIALOG_THEME_ATTRIBUTE}]) .dialog-section {
  margin-bottom: 12px;
}

:where(:root[${DIALOG_THEME_ATTRIBUTE}]) .dialog-section:last-child {
  margin-bottom: 0;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-section-title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
  color: var(--ieum-dialog-ink-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* Spacing and label widths are layout: several dialogs line their labels up
   with a wider min-width of their own (object, equation, paragraph spacing). */
:where(:root[${DIALOG_THEME_ATTRIBUTE}]) .dialog-row {
  gap: 10px;
  margin-bottom: 8px;
}

:where(:root[${DIALOG_THEME_ATTRIBUTE}]) .dialog-row:last-child {
  margin-bottom: 0;
}

:where(:root[${DIALOG_THEME_ATTRIBUTE}]) .dialog-label {
  min-width: 44px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-label {
  color: var(--ieum-dialog-ink-muted);
  font-size: 11px;
  font-weight: 500;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-unit {
  color: var(--ieum-dialog-ink-hint);
  font-size: 11px;
}

/* ─────────────────────────────────────────────────────────────
   10. Fields
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] :where(
    .dialog-input,
    .dialog-select,
    .dialog-text-input,
    .field-edit-input,
    .field-edit-textarea,
    .formula-input,
    .formula-select
  ) {
  border: 1px solid var(--ieum-dialog-field-line);
  border-radius: var(--ieum-dialog-radius-control);
  background: var(--ieum-dialog-field-surface);
  color: var(--ieum-dialog-ink);
  font-family: var(--ieum-dialog-font);
  font-size: 12px;
  box-shadow: var(--ieum-dialog-field-shadow);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-input,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-select,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-text-input,
:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-input {
  height: 26px;
  padding: 0 8px;
}

:where(:root[${DIALOG_THEME_ATTRIBUTE}]) .dialog-input {
  width: 76px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-select {
  padding: 0 6px;
}

/* Number fields: rhwp sizes many of them inline to 40-60px, and a wider inset
   pushes "100" under the spinner. */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-input {
  padding: 0 4px;
}

:where(:root[${DIALOG_THEME_ATTRIBUTE}]) .dialog-text-input {
  width: 140px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-input {
  width: 100%;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-textarea {
  width: 100%;
  min-height: 92px;
  padding: 8px 10px;
  line-height: 1.55;
  resize: vertical;
}

:root[${DIALOG_THEME_ATTRIBUTE}] :where(
    .dialog-input,
    .dialog-select,
    .dialog-text-input,
    .field-edit-input,
    .field-edit-textarea,
    .formula-input,
    .formula-select
  ):focus {
  border-color: var(--ieum-dialog-focus);
  outline: none;
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--ieum-dialog-focus) 18%, transparent),
    var(--ieum-dialog-field-shadow);
}

/* Not .dialog-select: a <select> always matches :read-only, which would grey
   out every drop-down. */
:root[${DIALOG_THEME_ATTRIBUTE}] :where(
    .dialog-input,
    .dialog-text-input,
    .field-edit-input,
    .field-edit-textarea,
    .formula-input
  ):read-only {
  background: var(--ieum-dialog-surface-sunken);
  color: var(--ieum-dialog-ink-muted);
}

:root[${DIALOG_THEME_ATTRIBUTE}] :where(
    .dialog-input,
    .dialog-select,
    .dialog-text-input,
    .field-edit-input,
    .field-edit-textarea,
    .formula-input,
    .formula-select
  ):disabled {
  background: var(--ieum-dialog-surface-sunken);
  border-color: var(--ieum-dialog-line-soft);
  color: var(--ieum-dialog-ink-disabled);
  cursor: not-allowed;
}

/* ─────────────────────────────────────────────────────────────
   11. Choice controls
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-radio-group {
  gap: 6px 14px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-radio-group label,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-checkbox,
:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-checkbox-row {
  gap: 6px;
  color: var(--ieum-dialog-ink);
  font-size: 12px;
  cursor: pointer;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-radio-group input[type='radio'],
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-checkbox input[type='checkbox'],
:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-checkbox-row input[type='checkbox'] {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--ieum-dialog-accent);
}

/* Some in-house dialogs (for example the format-copy dialog) build their
   choice rows from bare labels; keep every box on the same accent. */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-body input[type='radio'],
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-body input[type='checkbox'] {
  accent-color: var(--ieum-dialog-accent);
}

/* ─────────────────────────────────────────────────────────────
   12. Field (누름틀) and memo form
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-body {
  display: flex;
  flex-direction: column;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-panel {
  gap: 8px;
  padding: 18px 20px 16px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-label {
  margin-top: 2px;
  color: var(--ieum-dialog-ink-muted);
  font-size: 11px;
  font-weight: 500;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-checkbox-row {
  margin-top: 6px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .field-edit-error {
  color: var(--ieum-dialog-danger) !important;
  font-size: 11px !important;
}

/* ─────────────────────────────────────────────────────────────
   13. Scrollbars
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-body::-webkit-scrollbar,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-tab-panel::-webkit-scrollbar,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-panel-container::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-body::-webkit-scrollbar-thumb,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-tab-panel::-webkit-scrollbar-thumb,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-panel-container::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
  background-color: color-mix(in srgb, var(--ieum-dialog-ink) 24%, transparent);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-body::-webkit-scrollbar-track,
:root[${DIALOG_THEME_ATTRIBUTE}] .dialog-tab-panel::-webkit-scrollbar-track,
:root[${DIALOG_THEME_ATTRIBUTE}] .tcp-panel-container::-webkit-scrollbar-track {
  background: transparent;
}

/* ─────────────────────────────────────────────────────────────
   14. Modeless find panel (the dialog's smaller sibling)
   ───────────────────────────────────────────────────────────── */
:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog {
  position: fixed;
  overflow: hidden;
  background: var(--ieum-dialog-surface);
  border: 1px solid var(--ieum-dialog-line);
  border-radius: var(--ieum-dialog-radius);
  box-shadow: var(--ieum-dialog-shadow);
  color: var(--ieum-dialog-ink);
  font-family: var(--ieum-dialog-font);
  font-size: 12px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-title {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 42px;
  padding: 0 10px 0 16px;
  background: var(--ieum-dialog-title-surface);
  border-bottom: 1px solid var(--ieum-dialog-line);
  color: var(--ieum-dialog-title-ink);
  font-size: 13px;
  font-weight: 600;
  cursor: move;
  user-select: none;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-body {
  padding: 14px 16px 4px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-row {
  gap: 8px;
  margin-bottom: 9px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-label {
  width: 70px;
  color: var(--ieum-dialog-ink-muted);
  font-size: 11px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-input {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--ieum-dialog-field-line);
  border-radius: var(--ieum-dialog-radius-control);
  background: var(--ieum-dialog-field-surface);
  color: var(--ieum-dialog-ink);
  font-family: var(--ieum-dialog-font);
  font-size: 12px;
  box-shadow: var(--ieum-dialog-field-shadow);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-input:focus {
  border-color: var(--ieum-dialog-focus);
  outline: none;
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--ieum-dialog-focus) 18%, transparent),
    var(--ieum-dialog-field-shadow);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-body input[type='checkbox'] {
  margin: 0;
  accent-color: var(--ieum-dialog-accent);
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-status {
  color: var(--ieum-dialog-ink-muted);
  font-size: 11px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-match-count {
  color: var(--ieum-dialog-ink-hint);
  font-size: 11px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-buttons {
  justify-content: flex-end;
  gap: 6px;
  padding: 4px 16px 12px;
}

:root[${DIALOG_THEME_ATTRIBUTE}] .find-dialog-buttons .dialog-btn {
  min-width: 64px;
}

/* ─────────────────────────────────────────────────────────────
   15. Narrow windows and reduced motion
   ───────────────────────────────────────────────────────────── */
/* rhwp turns dialogs into a bottom sheet below 768px (responsive.css). Follow
   the same breakpoint, or the sheet keeps the card's padding and corners. */
@media (max-width: 767px) {
  :root[${DIALOG_THEME_ATTRIBUTE}] .modal-overlay {
    padding: 0;
  }

  :root[${DIALOG_THEME_ATTRIBUTE}] .dialog-wrap {
    max-height: 90dvh;
    border-radius: 12px 12px 0 0;
  }

  :root[${DIALOG_THEME_ATTRIBUTE}] .dialog-title {
    min-height: 52px;
    padding-left: 16px;
  }
}

@media (prefers-reduced-motion: reduce) {
  :root[${DIALOG_THEME_ATTRIBUTE}] .modal-overlay,
  :root[${DIALOG_THEME_ATTRIBUTE}] .dialog-wrap {
    animation: none;
  }

  :root[${DIALOG_THEME_ATTRIBUTE}] .dialog-btn {
    transition: none;
  }
}
`

/**
 * Puts the skin into the editor document. Safe to call more than once: the
 * style element is reused and the root attribute is only set once.
 *
 * The user's "oldschool" studio skin is left alone. A small observer follows
 * that setting, so choosing it later turns this layer off without a reload and
 * choosing the default skin turns it back on.
 *
 * @param {Document | undefined} doc
 * @returns {boolean} whether the skin is currently on
 */
export function installDialogTheme(doc = globalThis.document) {
  const root = doc?.documentElement
  if (!doc || !root) return false

  const already = doc.getElementById(DIALOG_THEME_STYLE_ID)
  if (!already) {
    const style = doc.createElement('style')
    style.id = DIALOG_THEME_STYLE_ID
    style.textContent = DIALOG_THEME_CSS
    ;(doc.head ?? root).appendChild(style)
  } else if (already.textContent !== DIALOG_THEME_CSS) {
    // A dev reload or a version bump on the same page must not keep the old
    // tokens; in the packaged app the text is identical, so this is a no-op.
    already.textContent = DIALOG_THEME_CSS
  }

  const sync = () => {
    const off = root.getAttribute('data-theme-skin') === 'oldschool'
    if (off) {
      root.removeAttribute(DIALOG_THEME_ATTRIBUTE)
    } else {
      root.setAttribute(DIALOG_THEME_ATTRIBUTE, String(DIALOG_THEME_VERSION))
    }
    return !off
  }

  const on = sync()
  // Observe the attribute, not every change in the tree: the studio sets the
  // skin on <html> and nothing else toggles it.
  const MutationObserverCtor = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver
  if (!doc.__ieumDialogThemeObserver && typeof MutationObserverCtor === 'function') {
    const observer = new MutationObserverCtor(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme-skin'] })
    doc.__ieumDialogThemeObserver = observer
  }
  return on
}
