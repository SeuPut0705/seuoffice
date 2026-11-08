/**
 * Keeping text from a map file from ever being read as markup.
 *
 * A map file may come from anyone. Its titles, labels, notes, sheet names and
 * the text on summaries and relationships are shown as the characters they
 * are: a title with angle brackets shows angle brackets.
 *
 * How mind-elixir 5.15.1 puts text on screen:
 *
 * - a topic's title: `textContent`, unless the instance has a `markdown`
 *   function, in which case its result goes into `innerHTML`;
 * - the text of a summary and of a relationship: always `innerHTML`, of the raw
 *   label or of the `markdown` function's result;
 * - tags: `textContent`;
 * - a node's `dangerouslySetInnerHTML`: `innerHTML`, as the name says;
 * - a node's `hyperLink`: an anchor with that address and `target="_blank"`.
 *
 * So one path takes raw text into `innerHTML` whatever the options are (summary
 * and relationship text), and the only switch the library offers on it is the
 * `markdown` function. This module is that function: it escapes, and does
 * nothing else. With it in place every text the library draws goes through
 * the escape first, and the parsed result is a single text node holding the
 * original characters.
 *
 * The other two paths are closed in `convert.ts`: no node is ever given
 * `dangerouslySetInnerHTML` or `hyperLink`, and nodes pasted from the clipboard
 * are cleaned before the library sees them.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** The text as markup that parses back to exactly this text. Passed to the library as its `markdown` option. */
export function escapeMapText(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]!)
}
