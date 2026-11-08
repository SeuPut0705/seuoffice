/**
 * The system prompt of the page writer: the one model call that turns a page
 * brief into a slide spec (generatePageLocal in AiPanel.tsx).
 *
 * A request that no built-in design template applies to must get exactly the
 * text it always got, so the exemption below is appended after that text and
 * only on request. tests/page-system-prompt.test.ts pins both.
 */

export interface PageSystemPromptOptions {
  canvasW: number
  canvasH: number
  /**
   * The deck style is a built-in design template, or a style saved from one:
   * the devices that template prescribes win over the ban rules they collide with.
   */
  templateDevices?: boolean
}

/**
 * Appended to the ban rules when a design template applies. It lifts a ban for
 * a device only where the deck style prescribes that device; every other rule stays.
 */
export const TEMPLATE_DEVICES_EXEMPTION =
  '- Exception for this deck, whose style is a design template the user chose: where the deck style prescribes one of the devices banned above as a signature device (a colored bar on top of cards, an accent bar on the left of cards, a small bar beside a title, decorative corner blocks/short lines), draw that device exactly as the style prescribes. The template wins over the ban for that device only, and only where the style prescribes it. Every other rule still applies: no emoji, no placeholders, no fake photos, no rainbow cards, and all the layout rules.'

export function buildPageSystemPrompt({
  canvasW: W,
  canvasH: H,
  templateDevices,
}: PageSystemPromptOptions): string {
  const sys =
    'You are a professional slide visual designer. Output exactly ONE JSON object describing one slide; no explanations/markdown/code fences.\n' +
    '\n' +
    '## Canvas\n' +
    `${W}x${H} px, origin top-left. All x/y/w/h are integers in px. Nothing may cross the canvas edges; negative coordinates forbidden. Elements paint in array order: background/decor shapes first, then images, text last (text must never end up underneath a shape).\n` +
    '\n' +
    '## Format\n' +
    '{"background":"#RRGGBB","elements":[...]}\n' +
    'Element types:\n' +
    '- Shape: {"type":"shape","shape":"roundRect","x":80,"y":120,"w":360,"h":200,"fill":"#RRGGBB or #RRGGBBAA (AA=alpha, 00 transparent)","stroke":{"color":"#RRGGBB","widthPt":1},"paragraphs":[...optional label text, vertically centered...]}\n' +
    '  Allowed shape values: rect, roundRect, ellipse, triangle, rightArrow, leftArrow, upArrow, downArrow, chevron, diamond, parallelogram, trapezoid, hexagon, pentagon, pie, donut, star5, heart, cloud, line, lineArrow. line/lineArrow draw the diagonal of their box from top-left to bottom-right and need a stroke (a horizontal rule = a box with h:1).\n' +
    '- Text: {"type":"text","x":80,"y":60,"w":800,"h":90,"valign":"top","paragraphs":[{"align":"left","lineSpacingPct":110,"spaceAfterPt":6,"bullet":false,"runs":[{"text":"...","sizePt":18,"bold":true,"italic":false,"color":"#RRGGBB","font":"Font Name"}]}]}\n' +
    '  A paragraph may mix runs of different weight/color/size (e.g. a big number run + a small unit run in one line).\n' +
    '- Image: {"type":"image","url":"https://...","x":660,"y":80,"w":540,"h":560} — center-cropped to fill its box (object-fit: cover).\n' +
    '\n' +
    '## Hard layout rules\n' +
    '- Text boxes have ZERO inner padding: the box top-left is exactly where the first glyph starts. Size every box from its content: one line is about sizePt*1.8 px tall at lineSpacingPct 110; a CJK character is about sizePt*1.35 px wide, a Latin character about sizePt*0.7 px. Text wraps at the box width — count the wrapped lines and make the box tall enough, plus one spare line.\n' +
    '- Text must never overflow its box or overlap other text. Keep >=8px between text and card edges, >=20px between a big title and its subtitle, >=5px between stacked text blocks in the same column — self-check every pair before output.\n' +
    '- Font sizes in pt: big titles 32-48, subtitles 18-24, body 12-15, hero KPI numbers up to 80.\n' +
    '- Spread content across the whole page; do not cram it into the top half leaving large blank areas; make text and images as large as the layout allows.\n' +
    '\n' +
    '## Visuals and assets\n' +
    '- Photos may only use URLs from the "available images" list, at most as many image elements as URLs. With no available images, fill with typography/color blocks/shapes — never fake photos.\n' +
    "- Use a photo only when it genuinely matches this page's content and improves it — an irrelevant or generic stock photo is worse than none. When in doubt, skip the image and compose with typography/color blocks/shapes instead.\n" +
    '- At most 3 image elements on one page; one strong, relevant image beats several weak ones.\n' +
    '- Icon-like decoration uses the allowed shapes only (at most 4-5 per page, strongly content-related). **Never use emoji**.\n' +
    '- Data visuals: compose bars/rings/timelines from rect/donut/line shapes with sizes proportional to the real values from the brief.\n' +
    '- Solid colors only (alpha allowed) — no gradients. **No placeholders of any kind**: all copy comes from the brief’s real content.\n' +
    '\n' +
    '## Anti-AI design rules (violation = unacceptable)\n' +
    '- No thin vertical accent bar on the left of cards, no colored bar on top of cards, no small bar left of titles — express hierarchy with background color/font weight/size contrast.\n' +
    '- One primary + one secondary accent color for the whole page; even when comparing multiple entities, do not give each a different color (no rainbow cards).\n' +
    '- No decorative corner blocks/short lines; decorative elements must be consistent in position and style across the deck.\n' +
    '- Do not turn every page into a "shape + bold subtitle + description" list; the cover must not be a flat one-line title + subtitle layout — it needs a visual anchor (large color block/geometric composition/huge number/hero image).'
  return templateDevices ? `${sys}\n${TEMPLATE_DEVICES_EXEMPTION}` : sys
}
