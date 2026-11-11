---
name: html-document
description: 'Make an HTML document that reads well on screen and prints cleanly: decide whether it is a designed page or a written document, settle the reader, the length and the paper, hand those choices to the page writer, then measure the pages and check what was written. Use for reports, one-pagers, handouts, newsletters, guides and printable sheets.'
metadata:
  ieum-editors: html
---

# Making an HTML document

In the HTML editor you do not write whole pages yourself: a page writer does, from a brief or a plan. **The page writer never sees this skill.** It sees the user's request and the confirmed brief, or the `plan` and `context` you pass. So this skill is about what to decide, what to hand over, and what to check afterwards.

The tool names below are those of the HTML editor's AI panel. In another window, apply the content and checking rules with the tools that window gives you.

## 1. Choose the route

| The user wants | Route |
| --- | --- |
| A designed page: one-pager, landing page, poster, newsletter, invitation, dashboard | `ask_clarification` if real choices are open, then `plan_page` (`new`) |
| Text to be written as a whole document: article, guide, memo, announcement, report | `write_document` (it replaces the whole page) |
| A small change to the page that is there | `apply_ops` |
| A new look for the page that is there | `plan_page` (`restyle`) |
| The whole page rebuilt | `plan_page` (`redesign`) |
| Something to print: handout, worksheet, form, report | Either route above, plus section 4 |

## 2. Decide, then hand it over

Settle these from the request and the material. Ask only for what is missing and matters.

1. **Reader and purpose** in one line, and the one thing the reader should take away.
2. **Length:** number of sections for a screen page (four to seven), number of pages for paper.
3. **Sections in order,** each with its job: what it tells the reader, with which facts.
4. **Facts to use:** the exact figures, dates, names and quotations from the material, each with its source. Nothing else may appear as a fact.
5. **Paper** when it will be printed: size, orientation, page count.

Hand them over where the writer will find them:

- **`plan_page`:** the brief is drafted from the conversation, so the facts and sections must be in it. When they came from an attachment or a search, state the ones to use in your message before the call. Put the choices to honour (reader, length, paper, tone) into `notes`, in three sentences at most.
- **`write_document`:** `plan` holds the numbered outline with one line per section, the target length, the voice, and the paper and page count when it will be printed; `context` holds the facts, figures and quotations word for word with their sources. `plan` is cut at 4,000 characters and `context` at 8,000, so put the most important first. A decision left out of both is not followed.

## 3. What a good document holds

Hand over what matters from this list (section 2). After the page is written, fix what is missing with `apply_ops`.

- **The point comes first:** a title that names the subject and one sentence below it that says the conclusion.
- **Headings are plain labels or short statements,** three levels at most, none skipped. One section, one idea. Paragraphs of four sentences or fewer.
- **Parallel items are a list; comparisons are a table** with a header row, units in the headers and numbers aligned right. A chart only for three or more comparable values, with one message, labelled directly.
- **A picture only where it carries information,** with alternative text that says what it shows.
- **Readable type:** body lines of 60 to 75 characters (35 to 45 in Korean, Japanese or Chinese), line height of at least 1.6, and for Korean text `word-break: keep-all`. The page's `lang` matches its language.
- **Self-contained:** no outside scripts, fonts or stylesheets unless the user asks. The page must open without a network.

## 4. When it will be printed

- Name the paper and the page count up front; A4 portrait unless the user says otherwise.
- **Nothing may depend on scripts, hover or animation.** PDF export runs with scripts turned off, while printing and `check_pages` run them: what a script draws can pass `check_pages` and still be missing from the PDF.
- Dark text on white, no dark or full-page coloured background: they waste ink and print unevenly. The page writer does not assume this for paper, so say it in `notes` or `plan`.
- Body text of 10 to 11 pt, never below 9 pt. Write a link's address out where the reader needs it; paper cannot be clicked.
- Keep tables, figures and cards whole on a page, and keep a heading with what follows it.
- For a sheet to write on, leave ruled lines or boxes at least 8 mm high.
- After the page is written, and after any edit that changes what fits, measure with `check_pages` and fix what it reports. A page from `write_document` has no `@page` rule unless the plan asked for paper: add one with `apply_ops` first.

## 5. Check before you answer (required)

Read what was written with `get_outline`, and `read_source` where you need the markup, and go through this list. Fix what fails with `apply_ops`; do not have the whole page written again for a small fault.

- Every planned section is there, in order.
- No placeholder text left (lorem ipsum, "Your text here", TODO, a bracketed blank).
- Every figure, date and name matches the material; sources are named where a search was used.
- One `h1`; heading levels do not skip.
- Tables have a header row; pictures have alternative text.
- No outside script, font or stylesheet the user did not ask for.
- For paper: `check_pages` shows the page count asked for, nothing cut by a page boundary, no nearly empty last page.

In your reply say in one or two sentences what the document holds, what you assumed, and what the user still has to supply.
