# The HTML editor

The HTML editor opens .html / .htm with two modes: **preview** (the rendered page) and **source**.

- **Preview**: true rendering; relative stylesheets and images load next to the file.
- **Preview inspector**: click to select an element, double-click to edit its text in place, toolbar delete, and Ask AI against the selection.
- **Slides**: a page of slides gets a slide list down the left of the preview, drawn by the page itself; click one to show that slide. An edit that reloads the preview comes back to the slide you were on, and keys you type into a slide's text never turn the slide.
- **Source mode**: edit the HTML; ctrl+F find, Replace All saves the rewritten markup.
- **Saving**: byte-faithful (BOM/CRLF/trailing newline preserved); unmodified saves do not rewrite.
- **Zoom**: ctrl+wheel / pinch scales the preview; ctrl+Z inside the preview undoes the last edit.
- **Hide from AI**: in source mode, right-click a selection — element contents, attribute values, script strings — and the model sees a placeholder instead; the rendered page never changes (details in the AI panel chapter).

## The toolbar

Click any element in the preview and a toolbar floats above it:

![The floating toolbar over a selected element](img/html-toolbar.png)

- **File & history**: Save, Save As, Undo, Redo, Find; the **AutoSave** toggle writes changes on a timer.
- **Preview / Source** switch; **Present** shows the page full-screen.
- **Formatting**: bold, italic, font size up/down; the **style panel** for the selected element (colors and more).
- **Insert**: heading, paragraph, table, image (by link), more.
- **Image actions** (with an image selected): crop, **remove background**, replace, lock aspect ratio.
- **Element actions** (with an element selected in the preview inspector): delete, duplicate, move up/down.
- **AI button**: opens the AI panel; ask about the selected element directly.

## Exporting

File menu, all local and all asking where to put the result:

- **Export as Word…** and **Export as PDF…** write a real .docx or .pdf.
- **Export as ODT…** writes an .odt (OpenDocument text) through the same conversion as the Word export; if something changes or is dropped on the way, you see the list and confirm first.
- **Export as Single-File HTML…** writes one .html with the images embedded in it. It will not overwrite the file you currently have open, and it tells you how many images it could not embed.

## Insert skeleton

For a blank page, **Insert ▸ Insert skeleton** writes a minimal standards-mode document:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title></title>
  </head>
  <body></body>
</html>
```

Each part is there for a reason, which is why it is a command rather than something to type:

- the **doctype**, or the preview runs in quirks mode, where box sizing and table layout follow different rules than you expect;
- the **`lang`**, or a screen reader has no language to read the page in and the browser picks a font and a spell-checker for the wrong one;
- the **charset**, or a page of non-Latin text can decode as mojibake.

A viewport meta is deliberately absent: this renders in a desktop pane with no mobile viewport for it to affect.

The `lang` follows the app's UI language, so the skeleton you insert is the one your tooling is already set up for. Edit it freely afterwards.

The item only appears in edit mode, and only while the document is empty — there is nothing to insert a skeleton _into_ once there is content.

## Edit equation

Type visually or edit LaTeX. Saved HTML keeps the source for later editing.

Choose Insert equation in the toolbar. Use the visual field, templates or LaTeX, then apply. Click a saved equation in the preview to edit it again. For inline math, select a paragraph and turn off the separate-line option; the equation is appended to that paragraph.

An expression the typesetter cannot handle is not lost: the equation keeps its LaTeX source and shows the raw text in the page, so you can open it again and correct it.
