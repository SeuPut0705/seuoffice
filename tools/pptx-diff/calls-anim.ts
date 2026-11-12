// Group `anim` of comparison (f): animation.ts of packages/pptx-engine. The
// Rust side answers in crates/office-wasm/src/calls/pptx_anim.rs to
// `pptxAnim.animation.<TypeScript name>`.
//
// None of the tracked decks has a <p:timing>, so the built inputs carry the
// comparison: timing trees as PowerPoint writes them, every list the model
// allows written by buildTimingXml and read back, and the read-back lists
// written again, appended to and edited.
import {
  ANIM_DIRECTIONS,
  ANIM_EFFECTS,
  ANIM_TRIGGERS,
  animClassOf,
  buildTimingXml,
  cNvPrIdsInXml,
  DEFAULT_MOTION_PATH,
  elementSpid,
  getSlideAnimations,
  isMediaEffect,
  patchSlideTimingIncrementalXml,
  patchSlideTimingXml,
  pruneTimingForSpids,
  readSlideTimingXml,
  setSlideAnimations,
  type AnimEffectKind,
  type AnimTrigger,
  type SlideAnimation,
} from '../../packages/pptx-engine/src/animation'
import { scanSlide } from '../../packages/pptx-engine/src/scan'
import type { Slide, SlideElement } from '../../packages/pptx-engine/src/types'
import type { CallSpec, Input } from '../docx-diff/calls-spec'

const TIMING_PART = /^ppt\/(?:slides|slideLayouts|slideMasters)\/[^/]+\.xml$/

const partsMatching = (parts: ReadonlyMap<string, string>, name: RegExp): string[] =>
  [...parts].filter(([path]) => name.test(path)).map(([, text]) => text)

/** What a Slide holds as bodySuffix: from the end of the last shape on. */
function suffixOf(text: string): string {
  try {
    return scanSlide(text).bodySuffix
  } catch {
    return text
  }
}

/** The bytes of every top-level shape: what an element's anchor.originalXml holds. */
function shapesOf(text: string): string[] {
  try {
    return scanSlide(text).elements.map((element) => text.slice(element.start, element.end))
  } catch {
    return []
  }
}

const slideOf = (text: string, args: Record<string, unknown>): Slide =>
  ({ bodySuffix: text, structureDirty: args.structureDirty === true }) as unknown as Slide

const anim = (
  spid: number,
  effect: AnimEffectKind,
  trigger: AnimTrigger = 'onClick',
  more: Partial<SlideAnimation> = {},
): SlideAnimation => ({ spid, effect, trigger, durationMs: 500, delayMs: 0, ...more })

// ── Timing trees as PowerPoint writes them ───────────────────────────────

const PREV =
  '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
const NEXT =
  '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>'

const tgt = (spid: number | string, inner = ''): string =>
  `<p:tgtEl><p:spTgt spid="${spid}"${inner ? `>${inner}</p:spTgt>` : '/>'}</p:tgtEl>`
const para = (n: number): string => `<p:txEl><p:pgRg st="${n}" end="${n}"/></p:txEl>`

const visibility = (
  id: number,
  target: string,
  value: string,
  delay: number | string = 0,
): string =>
  `<p:set><p:cBhvr><p:cTn id="${id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst></p:cTn>${target}` +
  `<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="${value}"/></p:to></p:set>`
const show = (id: number, target: string): string => visibility(id, target, 'visible')
const hide = (id: number, target: string, delay: number): string =>
  visibility(id, target, 'hidden', delay)

const fx = (
  id: number,
  target: string,
  dur: number | string,
  transition = 'in',
  filter = 'fade',
): string =>
  `<p:animEffect transition="${transition}" filter="${filter}"><p:cBhvr><p:cTn id="${id}" dur="${dur}"/>${target}</p:cBhvr></p:animEffect>`

const move = (
  id: number,
  target: string,
  dur: number,
  attr: string,
  from: string,
  to: string,
): string =>
  `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${id}" dur="${dur}" fill="hold"/>${target}` +
  `<p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst>` +
  `<p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav>` +
  `<p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`

/** One effect <p:par>; `head` holds the attributes of its cTn after the id. */
const effect = (id: number, head: string, delay: string, behaviors: string): string =>
  `<p:par><p:cTn id="${id}" ${head}><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>` +
  `<p:childTnLst>${behaviors}</p:childTnLst></p:cTn></p:par>`

const head = (
  id: number,
  cls: string,
  trigger: string,
  more = 'presetSubtype="0" grpId="0"',
): string => `presetID="${id}" presetClass="${cls}" ${more} fill="hold" nodeType="${trigger}"`

const group = (id: number, delay: string, effects: string): string =>
  `<p:par><p:cTn id="${id}" fill="hold"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst>` +
  `<p:par><p:cTn id="${id + 1}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst>` +
  `<p:childTnLst>${effects}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`

const mainSeq = (groups: string): string =>
  '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq">' +
  `<p:childTnLst>${groups}</p:childTnLst></p:cTn>${PREV}${NEXT}</p:seq>`

const root = (children: string, bld = '', open = '<p:timing>'): string =>
  `${open}<p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">` +
  `<p:childTnLst>${children}</p:childTnLst></p:cTn></p:par></p:tnLst>${bld}</p:timing>`

/** A trigger sequence: clicking `trigger` fades `target` in. */
const interactive = (trigger: number, target: number, id = 60, seqAttrs = ''): string =>
  `<p:seq concurrent="1" nextAc="seek"${seqAttrs}><p:cTn id="${id}" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq">` +
  `<p:stCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${trigger}"/></p:tgtEl></p:cond></p:stCondLst>` +
  '<p:endSync evt="end" delay="0"><p:rtn val="all"/></p:endSync><p:childTnLst>' +
  `<p:par><p:cTn id="${id + 1}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
  effect(
    id + 2,
    head(10, 'entr', 'clickEffect'),
    '0',
    show(id + 3, tgt(target)) + fx(id + 4, tgt(target), 500),
  ) +
  '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn>' +
  `<p:nextCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${trigger}"/></p:tgtEl></p:cond></p:nextCondLst></p:seq>`

const mediaNode = (name: 'p:video' | 'p:audio', spid: number, id: number, attrs = ''): string =>
  `<${name}${attrs}><p:cMediaNode vol="80000"><p:cTn id="${id}" fill="hold" display="0">` +
  '<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:endCondLst><p:cond evt="onNext" delay="0">' +
  `<p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:endCondLst></p:cTn>${tgt(spid)}</p:cMediaNode></${name}>`

const cmd = (
  id: number,
  presetId: number,
  command: string,
  spid: number,
  trigger = 'clickEffect',
): string =>
  effect(
    id,
    head(presetId, 'mediacall', trigger),
    '0',
    `<p:cmd type="call" cmd="${command}"><p:cBhvr><p:cTn id="${id + 1}" dur="1" fill="hold"/>${tgt(spid)}</p:cBhvr></p:cmd>`,
  )

const RICH_GROUPS =
  group(
    3,
    'indefinite',
    effect(5, head(10, 'entr', 'clickEffect'), '0', show(6, tgt(2)) + fx(7, tgt(2), 500)) +
      effect(
        8,
        'presetSubtype="8" presetClass="entr" presetID="2" nodeType="withEffect" grpId="0" fill="hold"',
        '250',
        show(9, tgt(3)) +
          move(10, tgt(3), 750, 'ppt_x', '0-#ppt_w/2', '#ppt_x') +
          move(11, tgt(3), 750, 'ppt_y', '#ppt_y', '#ppt_y'),
      ) +
      effect(
        12,
        head(53, 'entr', 'afterEffect', 'presetSubtype="16" grpId="0"'),
        '0',
        show(13, tgt(4)) +
          `<p:animScale><p:cBhvr><p:cTn id="14" dur="1000" fill="hold"/>${tgt(4)}</p:cBhvr><p:from x="0" y="0"/><p:to x="100000" y="100000"/></p:animScale>` +
          fx(15, tgt(4), 1000),
      ),
  ) +
  group(
    16,
    'indefinite',
    effect(
      18,
      head(26, 'emph', 'clickEffect', 'presetSubtype="0" grpId="1"'),
      '0',
      `<p:animScale><p:cBhvr><p:cTn id="19" dur="250" autoRev="1" fill="hold"/>${tgt(2)}</p:cBhvr><p:by x="105000" y="105000"/></p:animScale>`,
    ) +
      effect(
        20,
        head(99, 'emph', 'withEffect', 'presetSubtype="0" grpId="2"'),
        '125',
        `<p:animClr clrSpc="rgb" dir="cw"><p:cBhvr override="childStyle"><p:cTn id="21" dur="2000" fill="hold"/>${tgt(2)}` +
          '<p:attrNameLst><p:attrName>style.color</p:attrName></p:attrNameLst></p:cBhvr><p:to><a:srgbClr val="FF0000"/></p:to></p:animClr>',
      ) +
      effect(
        22,
        head(22, 'exit', 'afterEffect', 'presetSubtype="4" grpId="1"'),
        '300',
        fx(23, tgt(3), 500, 'out', 'wipe(up)') + hide(24, tgt(3), 499),
      ) +
      effect(
        25,
        head(47, 'exit', 'withEffect', 'presetSubtype="0" grpId="1"'),
        '0',
        fx(26, tgt(4), 750, 'out', 'fade') + hide(27, tgt(4), 749),
      ),
  ) +
  group(
    28,
    'indefinite',
    effect(
      30,
      'presetID="0" presetClass="path" presetSubtype="0" accel="50000" decel="50000" fill="hold" grpId="0" nodeType="clickEffect"',
      '0',
      `<p:animMotion origin="layout" path="M 0 0 L 0.25 0.1 E" pathEditMode="relative" rAng="0" ptsTypes="AA"><p:cBhvr><p:cTn id="31" dur="2000" fill="hold"/>${tgt(8)}` +
        '<p:attrNameLst><p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr><p:rCtr x="12500" y="5000"/></p:animMotion>',
    ) +
      effect(
        32,
        head(10, 'entr', 'withEffect'),
        '0',
        show(33, tgt(5, para(1))) + fx(34, tgt(5, para(1)), 500),
      ) +
      effect(
        35,
        head(10, 'entr', 'afterEffect'),
        '0',
        show(36, tgt(5, para(2))) + fx(37, tgt(5, para(2)), 500),
      ),
  ) +
  group(
    38,
    'indefinite',
    cmd(40, 2, 'playFrom(0.0)', 6) +
      cmd(42, 1, 'togglePause', 6, 'withEffect') +
      cmd(44, 2, 'playFrom(2.5)', 6, 'afterEffect') +
      cmd(46, 3, 'stop', 7, 'withEffect') +
      cmd(48, 3, 'seek(1)', 7, 'withEffect'),
  )

const RICH_BLD =
  '<p:bldLst><p:bldP spid="2" grpId="0" animBg="1"/><p:bldP spid="3" grpId="0"/><p:bldP spid="4" grpId="0"/>' +
  '<p:bldP spid="5" grpId="0" build="p"/><p:bldDgm spid="9" grpId="0" bld="one"/>' +
  '<p:bldGraphic spid="10" grpId="0"><p:bldAsOne/></p:bldGraphic>' +
  '<p:bldP spid="12" grpId="0"><p:tmplLst><p:tmpl lvl="1"/></p:tmplLst></p:bldP></p:bldLst>'

const PPT_RICH = root(
  mainSeq(RICH_GROUPS) +
    interactive(11, 4) +
    mediaNode('p:video', 6, 70) +
    mediaNode('p:audio', 7, 71, ' isNarration="1"'),
  RICH_BLD,
)

/** Group 0 plays after the transition: its first effect is withEffect. */
const PPT_AUTO = root(
  mainSeq(
    group(
      3,
      '0',
      effect(5, head(1, 'entr', 'withEffect'), '0', show(6, tgt(2))) +
        effect(
          7,
          head(10, 'exit', 'afterEffect'),
          '500',
          fx(8, tgt(2), 400, 'out') + hide(9, tgt(2), 399),
        ),
    ) +
      group(
        10,
        'indefinite',
        effect(
          12,
          head(8, 'emph', 'clickEffect'),
          '0',
          `<p:animRot by="21600000"><p:cBhvr><p:cTn id="13" dur="2000" fill="hold"/>${tgt(3)}<p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:animRot>`,
        ),
      ),
  ),
  '<p:bldLst><p:bldP spid="2" grpId="0"/><p:bldP spid="2" grpId="1"/><p:bldP spid="3" grpId="0"/></p:bldLst>',
)

const PPT_INTERACTIVE_ONLY = root(
  interactive(11, 4) + mediaNode('p:video', 6, 70),
  '<p:bldLst><p:bldP spid="4" grpId="0"/></p:bldLst>',
)

const PPT_NO_ROOT =
  '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite"><p:childTnLst>' +
  mainSeq(
    group(
      3,
      'indefinite',
      effect(5, head(10, 'entr', 'clickEffect'), '0', show(6, tgt(2)) + fx(7, tgt(2), 500)),
    ),
  ) +
  '</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'

const PPT_SELF_CLOSING_SEQ = root(
  '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"/></p:seq>',
)

/** No grpId on the effect cTn, no bldLst. */
const PPT_NO_GRP = root(
  mainSeq(
    group(
      3,
      'indefinite',
      effect(
        5,
        head(10, 'entr', 'clickEffect', 'presetSubtype="0"'),
        '0',
        show(6, tgt(2)) + fx(7, tgt(2), 500),
      ),
    ) +
      group(
        8,
        'indefinite',
        effect(
          10,
          head(10, 'entr', 'clickEffect', 'presetSubtype="0"'),
          '0',
          show(11, tgt(3)) + fx(12, tgt(3), 500),
        ),
      ),
  ),
)

/** An ink replay effect: a presetClass cTn whose target is no <p:spTgt>. */
const PPT_INK = root(
  mainSeq(
    group(
      3,
      'indefinite',
      effect(
        5,
        head(1, 'entr', 'clickEffect'),
        '0',
        visibility(6, '<p:tgtEl><p:inkTgt spid="13"/></p:tgtEl>', 'visible'),
      ),
    ) +
      group(
        7,
        'indefinite',
        effect(9, head(10, 'entr', 'clickEffect'), '0', show(10, tgt(2)) + fx(11, tgt(2), 500)),
      ),
  ),
  '<p:bldLst><p:bldP spid="2" grpId="0"/></p:bldLst>',
)

/** One effect whose behaviors target two shapes. */
const PPT_SHARED = root(
  mainSeq(
    group(
      3,
      'indefinite',
      effect(5, head(10, 'entr', 'clickEffect'), '0', show(6, tgt(12)) + show(7, tgt(13))) +
        effect(8, head(10, 'entr', 'withEffect'), '0', show(9, tgt(12))),
    ),
  ),
  '<p:bldLst><p:bldP spid="12" grpId="0"/><p:bldP spid="13" grpId="0"/></p:bldLst>',
)

/** A surviving effect whose value holds `$&` and `$$`. */
const PPT_DOLLAR = root(
  mainSeq(
    group(
      3,
      'indefinite',
      effect(5, head(10, 'entr', 'clickEffect'), '0', show(6, tgt(2)) + fx(7, tgt(2), 500)) +
        effect(8, head(1, 'entr', 'withEffect'), '0', visibility(9, tgt(3), 'US$&amp;$$')),
    ),
  ),
)

const suffix = (timing: string, tail = ''): string =>
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${timing}${tail}</p:sld>`
const EXT_TAIL = '<p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"/></p:extLst>'

const RICH = suffix(PPT_RICH)
const RICH_READ = readSlideTimingXml(RICH)

// A presetClass value that holds `/></p:cTn>`: the balanced scan reads the
// cTn as self-closing and ends the first effect's body inside that value, and
// the cTn's own match runs on over the next effect's open tag, which the
// search from the body's end still finds.
const STRADDLE =
  '<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>' +
  '<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
  '<p:par><p:cTn id="5" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect">' +
  '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
  '<p:set><p:cBhvr><p:cTn id="6" dur="1"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cBhvr></p:set>' +
  '<p:cTn id="7" presetClass="x/></p:cTn><p:cTn id="9" presetID="1" presetClass="entr" nodeType="withEffect">' +
  '<p:childTnLst><p:set><p:cBhvr><p:cTn id="10" dur="1"/><p:tgtEl><p:spTgt spid="3"/></p:tgtEl></p:cBhvr></p:set>' +
  '</p:childTnLst></p:cTn></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>' +
  '</p:childTnLst></p:cTn></p:par>'

const READ_EDGES: string[] = [
  '',
  root(mainSeq(STRADDLE)),
  suffix(''),
  '<p:timing/>',
  suffix('<p:timing xmlns:p="urn:x"/>'),
  suffix(root(mainSeq(RICH_GROUPS), '', '<p:timing xmlns:p="urn:x">')),
  suffix('<p:timing><p:tnLst>'),
  suffix(PPT_SELF_CLOSING_SEQ),
  suffix(PPT_INTERACTIVE_ONLY),
  suffix(PPT_NO_ROOT),
  suffix(PPT_AUTO),
  suffix(PPT_NO_GRP),
  suffix(PPT_INK),
  suffix(PPT_SHARED),
  suffix(PPT_DOLLAR),
  // single-quoted presetClass, nodeType missing, presetID and presetSubtype not digits
  root(
    mainSeq(
      group(
        3,
        'indefinite',
        effect(5, "presetID='10' presetClass='entr'", '0', show(6, tgt(2))) +
          effect(
            7,
            'presetClass="entr" presetID="x" presetSubtype="-4"',
            '0',
            show(8, tgt(2)) + fx(9, tgt(2), 600),
          ) +
          effect(
            10,
            'presetClass="" presetID="022" presetSubtype="04" nodeType="afterEffect"',
            '10',
            show(11, tgt(3)),
          ) +
          effect(
            12,
            'presetID="2" presetClass="constructor" nodeType="withEffect"',
            '20',
            show(13, tgt(3)),
          ) +
          effect(
            14,
            'presetID="2" presetClass="__proto__" nodeType="withEffect"',
            '20',
            show(15, tgt(3)),
          ) +
          effect(
            16,
            'presetID="2" presetClass="toString" nodeType="bogus"',
            '20',
            show(17, tgt(3)),
          ),
      ),
    ),
  ),
  // starts without digits, a start past 2^53, one of 400 digits, a dur of 400 digits
  root(
    mainSeq(
      group(
        3,
        'indefinite',
        effect(
          5,
          head(10, 'entr', 'clickEffect'),
          'indefinite',
          show(6, tgt(2)) + fx(7, tgt(2), 500),
        ) +
          effect(
            8,
            head(10, 'entr', 'afterEffect'),
            '9007199254740993',
            show(9, tgt(3)) + fx(10, tgt(3), '7'.repeat(400)),
          ) +
          effect(
            11,
            head(10, 'entr', 'afterEffect'),
            '9'.repeat(400),
            show(12, tgt(4)) + fx(13, tgt(4), 500),
          ) +
          effect(
            14,
            head(10, 'entr', 'withEffect'),
            '0',
            show(15, tgt(5)) + fx(16, tgt(5), 'indefinite'),
          ),
      ),
    ),
  ),
  // targets that are not digits, a target with two spaces, nested and self-closing preset cTns
  root(
    mainSeq(
      group(
        3,
        'indefinite',
        effect(5, head(10, 'entr', 'clickEffect'), '0', show(6, tgt(-1))) +
          effect(7, head(10, 'entr', 'clickEffect'), '0', show(8, tgt('1.5'))) +
          effect(9, head(10, 'entr', 'clickEffect'), '0', show(10, tgt(''))) +
          effect(
            11,
            head(10, 'entr', 'clickEffect'),
            '0',
            show(12, '<p:tgtEl><p:spTgt  spid="7"/></p:tgtEl>'),
          ) +
          effect(
            13,
            head(22, 'entr', 'clickEffect', 'presetSubtype="8" grpId="0"'),
            '40',
            effect(
              14,
              head(2, 'exit', 'withEffect', 'presetSubtype="1"'),
              '0',
              fx(15, tgt(8), 300),
            ) + show(16, tgt(9)),
          ) +
          `<p:par><p:cTn id="17" presetID="10" presetClass="entr" nodeType="withEffect"/>${show(18, tgt(10))}</p:par>`,
      ),
    ),
  ),
  // non-BMP and CJK attribute values before the effects; a cTn never closed
  root(
    mainSeq(
      group(
        3,
        'indefinite',
        effect(
          5,
          'evtFilter="\u{1F600}\uD55C\uAE00" ' + head(26, 'entr', 'clickEffect'),
          '0',
          show(6, tgt(2)) + fx(7, tgt(2), 500),
        ) +
          `<p:par><p:cTn id="8" ${head(10, 'emph', 'afterEffect')}><p:stCondLst><p:cond delay="5"/></p:stCondLst>${tgt(3)}<p:cTn id="9" dur="300">`,
      ),
    ),
  ),
  // paths: none, empty, a doubled end marker; a paragraph that is not digits; a cmd without a command
  root(
    mainSeq(
      group(
        3,
        'indefinite',
        effect(
          5,
          head(0, 'path', 'clickEffect'),
          '0',
          `<p:animMotion origin="layout"><p:cBhvr><p:cTn id="6" dur="900" fill="hold"/>${tgt(2)}</p:cBhvr></p:animMotion>`,
        ) +
          effect(
            7,
            head(0, 'path', 'withEffect'),
            '0',
            `<p:animMotion path=""><p:cBhvr><p:cTn id="8" dur="900" fill="hold"/>${tgt(2)}</p:cBhvr></p:animMotion>`,
          ) +
          effect(
            9,
            head(42, 'path', 'afterEffect'),
            '0',
            `<p:animMotion path="M 0 0 L 1 1 E E"><p:cBhvr><p:cTn id="10" dur="900" fill="hold"/>${tgt(2)}</p:cBhvr></p:animMotion>`,
          ) +
          effect(
            11,
            head(10, 'entr', 'clickEffect'),
            '0',
            show(12, tgt(3, '<p:txEl><p:pgRg st="x" end="x"/></p:txEl>')),
          ) +
          effect(
            13,
            head(2, 'mediacall', 'clickEffect'),
            '0',
            `<p:cmd type="call"><p:cBhvr><p:cTn id="14" dur="1" fill="hold"/>${tgt(6)}</p:cBhvr></p:cmd>`,
          ),
      ),
    ),
  ),
]

// ── Lists the model allows ───────────────────────────────────────────────

const PATHS: Array<string | undefined> = [
  undefined,
  '',
  '   ',
  'M 0 0 L 1 1',
  'M 0 0 L 1 1 E',
  ' M 0 0 L 0.5 0.5 E ',
  'M 0 0 C 0.1 0.2 0.3 0.4 0.5 0.6 Z',
  'E',
  'M0 0LE',
  'M 0 0 L 1 0 e',
  '\tM 0 0\u00A0',
  'M 0 0 L 1 0\uFEFF',
  'M 0 0 L \uD55C 0',
]

const NUMBERS = [0, -5, 0.4, 0.5, 1.5, 2.5, -0.5, 1, 2, 3, 1e21, 1e300, 123456.789, 2 ** 53 + 2]

const LISTS: SlideAnimation[][] = [
  ...ANIM_EFFECTS.map((effect) => [anim(2, effect)]),
  ANIM_EFFECTS.map((effect, i) =>
    anim(2 + (i % 4), effect, ANIM_TRIGGERS[i % 3]!, { durationMs: 100 + 37 * i, delayMs: 13 * i }),
  ),
  ...(['flyIn', 'flyOut', 'wipe', 'wipeOut'] as const).flatMap((effect) =>
    ANIM_DIRECTIONS.map((direction) => [anim(3, effect, 'onClick', { direction })]),
  ),
  [
    anim(3, 'fade', 'onClick', { direction: 'left' }),
    anim(3, 'wipeDown', 'withPrev', { direction: 'left' }),
  ],
  ...PATHS.map((motionPath) => [
    anim(4, 'motionPath', 'onClick', motionPath === undefined ? {} : { motionPath }),
  ]),
  [anim(4, 'fade', 'onClick', { motionPath: 'M 0 0 L 1 1' })],
  [
    anim(5, 'fade', 'onClick', { paragraph: 0 }),
    anim(5, 'fade', 'onClick', { paragraph: 1 }),
    anim(5, 'wipe', 'withPrev', { paragraph: 2, direction: 'top' }),
  ],
  [anim(5, 'fade'), anim(5, 'flyIn', 'onClick', { paragraph: 0 }), anim(5, 'fadeOut')],
  [anim(5, 'zoom', 'onClick', { paragraph: 7.5 }), anim(6, 'zoom', 'onClick', { paragraph: -1 })],
  [anim(5, 'grow', 'onClick', { paragraph: null as unknown as number })],
  [
    anim(6, 'mediaPlay', 'onClick', { mediaKind: 'video' }),
    anim(6, 'mediaPause', 'onClick', { mediaKind: 'video' }),
    anim(7, 'mediaStop', 'withPrev', { mediaKind: 'audio' }),
    anim(8, 'mediaPlay', 'afterPrev'),
  ],
  [
    anim(6, 'fade'),
    anim(6, 'mediaPlay', 'withPrev', { mediaKind: 'video' }),
    anim(6, 'fadeOut'),
    anim(9, 'fade', 'onClick', { mediaKind: 'audio' }),
  ],
  ...(['pulse', 'fadeOut', 'fade', 'appear'] as const).map((effect) =>
    NUMBERS.map((durationMs) => anim(2, effect, 'afterPrev', { durationMs })),
  ),
  NUMBERS.map((delayMs, i) => anim(2, 'spin', i % 2 ? 'withPrev' : 'afterPrev', { delayMs })),
  [-1, 0.5, 1.5, 1e21, 2 ** 53, 0.49999999999999994].map((delayMs) =>
    anim(3, 'grow', 'withPrev', { delayMs }),
  ),
  [0, 1.5, -3, 1e21, 2 ** 53 + 2, 4294967297, -0].map((spid) => anim(spid, 'fade')),
  [
    anim(2, 'fade', 'withPrev'),
    anim(3, 'fade', 'afterPrev', { delayMs: 250 }),
    anim(2, 'grow', 'onClick'),
    anim(3, 'spin', 'afterPrev', { delayMs: 100, durationMs: 2000 }),
    anim(4, 'teeter', 'withPrev', { delayMs: 50 }),
  ],
  [anim(2, 'bounce', 'afterPrev', { delayMs: 300 }), anim(2, 'shrink', 'afterPrev')],
  RICH_READ,
]

/** A written list read back: the list as the reader sees it, and the seeds of edits. */
const ROUND_TRIPS: string[] = LISTS.map((list) => suffix(buildTimingXml(list)))

const L1: SlideAnimation[] = [
  anim(2, 'fade'),
  anim(3, 'flyIn', 'withPrev', { direction: 'left', delayMs: 250 }),
  anim(2, 'pulse', 'afterPrev'),
  anim(4, 'motionPath', 'onClick', { motionPath: 'M 0 0 L 0.5 0' }),
]
const L2: SlideAnimation[] = [anim(4, 'zoomOut'), anim(2, 'spin', 'withPrev', { delayMs: 40 })]
const BUILT1 = suffix(buildTimingXml(L1))
const OLD1 = readSlideTimingXml(BUILT1)
const NO_BLD = suffix(PPT_NO_GRP)
const OLD_NO_BLD = readSlideTimingXml(NO_BLD)
const AUTO = suffix(PPT_AUTO)
const OLD_AUTO = readSlideTimingXml(AUTO)
const INK = suffix(PPT_INK)
const OLD_INK = readSlideTimingXml(INK)
const BUILT_DIR = suffix(
  buildTimingXml([anim(2, 'fade'), anim(3, 'flyIn', 'onClick', { direction: 'left' })]),
)
const OLD_DIR = readSlideTimingXml(BUILT_DIR)

const edit = (
  list: SlideAnimation[],
  at: number,
  more: Partial<SlideAnimation>,
): SlideAnimation[] => list.map((item, i) => (i === at ? { ...item, ...more } : item))

/** Index of the read-back item kept verbatim with presetID 53. */
const RICH_PRESET_53 = RICH_READ.findIndex((a) => a.preset?.id === 53)

const BODY_NO_TIMING = suffix('')
const BODY_EXT = suffix('', EXT_TAIL)
const BODY_EXT_TIMING = suffix(PPT_AUTO, EXT_TAIL)

/** (bodySuffix, anims) pairs for the two patch functions and setSlideAnimations. */
const PATCH_INPUTS: Input[] = [
  { text: BODY_NO_TIMING, args: { anims: [] } },
  { text: BODY_NO_TIMING, args: { anims: L1 } },
  { text: BODY_EXT, args: { anims: L1 } },
  { text: BODY_EXT_TIMING, args: { anims: L2 } },
  { text: BODY_EXT_TIMING, args: { anims: [] } },
  { text: '<p:cSld/>', args: { anims: L1 } },
  { text: BUILT1, args: { anims: L2 } },
  { text: BUILT1, args: { anims: [] } },
  { text: BUILT1, args: { anims: OLD1 } },
  { text: RICH, args: { anims: [] } },
  { text: RICH, args: { anims: RICH_READ } },
  { text: RICH, args: { anims: RICH_READ.slice(2) } },
  { text: RICH, args: { anims: L1 } },
  {
    text: RICH,
    args: {
      anims: [
        anim(6, 'mediaPlay', 'onClick', { mediaKind: 'video' }),
        anim(7, 'mediaStop', 'withPrev', { mediaKind: 'audio' }),
      ],
    },
  },
  { text: suffix(PPT_INTERACTIVE_ONLY), args: { anims: L1 } },
  { text: suffix(PPT_INTERACTIVE_ONLY), args: { anims: [] } },
  { text: suffix(PPT_NO_ROOT), args: { anims: L1 } },
  { text: suffix(PPT_NO_ROOT), args: { anims: [] } },
  { text: suffix(PPT_SELF_CLOSING_SEQ), args: { anims: L1 } },
  { text: suffix(PPT_SELF_CLOSING_SEQ), args: { anims: [] } },
  { text: suffix('<p:timing/>'), args: { anims: L1 } },
  { text: suffix('<p:timing/>'), args: { anims: [] } },
  { text: suffix(root(mainSeq(''), '<p:bldLst/>')), args: { anims: L1 } },
  {
    text: suffix(root(mainSeq(''), '<p:bldLst><p:bldP spid="2" grpId="0"/></p:bldLst>')),
    args: { anims: [] },
  },
  {
    text: suffix(root(mainSeq(''), '<p:bldLst><p:bldP spid="2" grpId="0"/></p:bldLst>')),
    args: { anims: [anim(6, 'mediaPlay')] },
  },
  { text: suffix(root(interactive(11, 4))), args: { anims: [anim(6, 'mediaPlay')] } },
  { text: suffix(root(mainSeq('')) + root(mainSeq(''))), args: { anims: L2 } },
  // incremental: A. pure append
  { text: BUILT1, args: { anims: [...OLD1, anim(5, 'zoom')] } },
  { text: BUILT1, args: { anims: [...OLD1, anim(5, 'zoom', 'withPrev')] } },
  { text: BUILT1, args: { anims: [...OLD1, anim(2, 'fade', 'onClick', { paragraph: 0 })] } },
  {
    text: BUILT1,
    args: {
      anims: [
        ...OLD1,
        anim(6, 'mediaPlay', 'onClick', { mediaKind: 'video' }),
        anim(6, 'mediaStop', 'withPrev', { mediaKind: 'video' }),
        anim(2, 'grow', 'afterPrev'),
      ],
    },
  },
  {
    text: BUILT1,
    args: {
      anims: [
        ...OLD1,
        anim(7, 'fade', 'onClick', { paragraph: 0 }),
        anim(7, 'fade', 'afterPrev', { paragraph: 1 }),
      ],
    },
  },
  { text: RICH, args: { anims: [...RICH_READ, anim(5, 'fade', 'onClick', { paragraph: 3 })] } },
  { text: RICH, args: { anims: [...RICH_READ, anim(14, 'spin'), anim(2, 'teeter', 'afterPrev')] } },
  {
    text: NO_BLD,
    args: { anims: [...OLD_NO_BLD, anim(3, 'wipe', 'onClick', { direction: 'right' })] },
  },
  {
    text: AUTO,
    args: { anims: [...OLD_AUTO, anim(3, 'flyOut', 'onClick', { direction: 'top' })] },
  },
  { text: BUILT1, args: { anims: [...OLD1.slice(0, 2), anim(9, 'fade'), ...OLD1.slice(2)] } },
  // incremental: B. one item changed
  { text: BUILT1, args: { anims: edit(OLD1, 3, { durationMs: 900 }) } },
  // only the direction of one effect differs: a list that is not the same list
  { text: BUILT1, args: { anims: edit(OLD1, 1, { direction: 'right' }) } },
  { text: BUILT1, args: { anims: edit(OLD1, 1, { direction: 'top' }) } },
  { text: BUILT_DIR, args: { anims: edit(OLD_DIR, 1, { direction: 'right' }) } },
  { text: BUILT_DIR, args: { anims: edit(OLD_DIR, 1, { direction: undefined }) } },
  { text: BUILT1, args: { anims: edit(OLD1, 3, { direction: 'left' }) } },
  { text: BUILT1, args: { anims: edit(OLD1, 3, { motionPath: 'M 0 0 L 0 1' }) } },
  { text: BUILT1, args: { anims: edit(OLD1, 0, { durationMs: 900 }) } },
  { text: BUILT1, args: { anims: edit(OLD1, 2, { delayMs: 100, effect: 'spin' }) } },
  { text: BUILT1, args: { anims: edit(OLD1, 3, { trigger: 'withPrev' }) } },
  { text: BUILT1, args: { anims: edit(OLD1, 3, { spid: 9 }) } },
  { text: BUILT1, args: { anims: edit(OLD1, 3, { paragraph: 0 }) } },
  { text: BUILT1, args: { anims: edit(edit(OLD1, 3, { durationMs: 1 }), 2, { durationMs: 2 }) } },
  { text: BUILT1, args: { anims: OLD1 } },
  { text: RICH, args: { anims: edit(RICH_READ, RICH_PRESET_53, { delayMs: 450 }) } },
  { text: RICH, args: { anims: edit(RICH_READ, RICH_READ.length - 1, { durationMs: 10 }) } },
  { text: NO_BLD, args: { anims: edit(OLD_NO_BLD, 1, { effect: 'flipIn' }) } },
  { text: AUTO, args: { anims: edit(OLD_AUTO, 2, { durationMs: 3000 }) } },
  { text: INK, args: { anims: edit(OLD_INK, 0, { durationMs: 900 }) } },
  { text: INK, args: { anims: [...OLD_INK, anim(3, 'fade')] } },
  { text: suffix(PPT_INTERACTIVE_ONLY), args: { anims: [anim(4, 'fade')] } },
]

/** (bodySuffix, spids) pairs for pruneTimingForSpids. */
const PRUNE_INPUTS: Input[] = [
  ...[
    [],
    [99],
    [2],
    [3],
    [4],
    [5],
    [6],
    [7],
    [8],
    [9],
    [11],
    [12],
    [2, 2, 3],
    [11, 4],
    [6, 7, 2],
  ].map((spids) => ({ text: RICH, args: { spids } })),
  { text: RICH, args: { spids: [2, 3, 4, 5, 6, 7, 8, 11, 12] } },
  { text: RICH, args: { spids: [99], structureDirty: true } },
  { text: BUILT1, args: { spids: [2, 3, 4] } },
  { text: BUILT1, args: { spids: [2] } },
  { text: AUTO, args: { spids: [2] } },
  { text: AUTO, args: { spids: [2, 3] } },
  { text: suffix(PPT_SHARED), args: { spids: [12] } },
  { text: suffix(PPT_SHARED), args: { spids: [13] } },
  { text: suffix(PPT_SHARED), args: { spids: [12, 13] } },
  { text: suffix(PPT_INTERACTIVE_ONLY), args: { spids: [11] } },
  { text: suffix(PPT_INTERACTIVE_ONLY), args: { spids: [6] } },
  {
    text: suffix(root(mainSeq(RICH_GROUPS), RICH_BLD, '<p:timing xmlns:p="urn:x">')),
    args: { spids: [2] },
  },
  { text: BODY_NO_TIMING, args: { spids: [2] } },
  // the head of the trigger sequence is read as 400 UTF-16 code units: with N characters in
  // x="...", nodeType="interactiveSeq" ends at 142 + N units (BMP) or 142 + 2N (astral)
  ...[
    '\uD55C'.repeat(150),
    '\uD55C'.repeat(258),
    '\uD55C'.repeat(259),
    '\u{1F600}'.repeat(129),
    '\u{1F600}'.repeat(130),
  ].map((filler) => ({
    text: suffix(root(interactive(11, 4, 60, ` x="${filler}"`))),
    args: { spids: [11] },
  })),
  { text: suffix(PPT_DOLLAR), args: { spids: [2] } },
  { text: suffix(PPT_DOLLAR), args: { spids: [3] } },
]

const ELEMENT_TEXTS = [
  '',
  '<p:sp><p:nvSpPr><p:cNvPr id="5" name="x"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr></p:sp>',
  "<p:sp><p:nvSpPr><p:cNvPr id='7' name='x'/></p:nvSpPr></p:sp>",
  '<p:sp><p:nvSpPr><p:cNvPr\nid="3"/></p:nvSpPr></p:sp>',
  '<p:sp><p:nvSpPr><p:cNvPrX id="1"/></p:nvSpPr></p:sp>',
  '<p:sp><p:nvSpPr><p:cNvPr id="2" descr="x" xid="3"/></p:nvSpPr></p:sp>',
  '<p:sp><p:nvSpPr><p:cNvPr name="a" id="12345678901234567890"/></p:nvSpPr></p:sp>',
  '<p:sp><p:nvSpPr><p:cNvPr id="5\'/></p:nvSpPr></p:sp>',
  '<p:sp><p:nvSpPr><p:cNvPr id=""/></p:nvSpPr></p:sp>',
  '<p:sp><p:nvSpPr><p:cNvPr id="-4"/></p:nvSpPr></p:sp>',
  '<p:sp><p:nvSpPr><p:cNvPr id="0042" name="\u{1F600}"/></p:nvSpPr></p:sp>',
  '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="g"/></p:nvGrpSpPr>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="11"/></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="10"/></p:nvSpPr></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="012"/></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="12"/></p:nvSpPr></p:sp></p:grpSp>',
  '<p:pic><p:nvPicPr><p:cNvPr descr="id=&quot;9&quot;" id="4"/></p:nvPicPr></p:pic>',
  '<p:sp><p:nvSpPr><p:cNvPr id="6" name="a>b"/></p:nvSpPr></p:sp>',
]

const EFFECT_NAMES = [
  ...ANIM_EFFECTS,
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
  '',
  'Fade',
  'unknown',
]

const listInputs = (values: readonly string[]): Input[] => [
  { args: { whole: true } },
  ...[...values, 'constructor', '__proto__', '', 'x'].map((text) => ({ text })),
]

/** Corpus inputs of the patch functions: the timing of each part, cleared and given one effect. */
function patchInputsOf(parts: ReadonlyMap<string, string>): Input[] {
  return partsMatching(parts, TIMING_PART).flatMap((text) => {
    const ids = [...cNvPrIdsInXml(text)]
    const body = suffixOf(text)
    return [
      { text: body, args: { anims: [] } },
      { text: body, args: { anims: ids.slice(0, 3).map((spid) => anim(spid, 'fade')) } },
    ]
  })
}

export const ANIM: CallSpec[] = [
  {
    fn: 'pptxAnim.animation.ANIM_DIRECTIONS',
    call: (text, args) => (args.whole ? ANIM_DIRECTIONS : ANIM_DIRECTIONS.indexOf(text as never)),
    built: listInputs(ANIM_DIRECTIONS),
  },
  {
    fn: 'pptxAnim.animation.ANIM_TRIGGERS',
    call: (text, args) => (args.whole ? ANIM_TRIGGERS : ANIM_TRIGGERS.indexOf(text as never)),
    built: listInputs(ANIM_TRIGGERS),
  },
  {
    fn: 'pptxAnim.animation.ANIM_EFFECTS',
    call: (text, args) => (args.whole ? ANIM_EFFECTS : ANIM_EFFECTS.indexOf(text as never)),
    built: listInputs(ANIM_EFFECTS),
  },
  {
    fn: 'pptxAnim.animation.DEFAULT_MOTION_PATH',
    call: (text, args) => (args.whole ? DEFAULT_MOTION_PATH : DEFAULT_MOTION_PATH.indexOf(text)),
    built: [
      { args: { whole: true } },
      ...['M', 'L', '0.25', ' 0', 'M 0 0 L 0.25 0', 'M 0 0 L 0.25 0 E', 'x', ''].map((text) => ({
        text,
      })),
    ],
  },
  {
    fn: 'pptxAnim.animation.isMediaEffect',
    call: (text) => isMediaEffect(text as AnimEffectKind),
    built: EFFECT_NAMES.map((text) => ({ text })),
  },
  {
    fn: 'pptxAnim.animation.animClassOf',
    call: (text) => animClassOf(text as AnimEffectKind),
    built: EFFECT_NAMES.map((text) => ({ text })),
  },
  {
    fn: 'pptxAnim.animation.elementSpid',
    call: (text) => elementSpid({ anchor: { originalXml: text } } as unknown as SlideElement),
    fromDocument: (parts) =>
      partsMatching(parts, TIMING_PART)
        .flatMap(shapesOf)
        .slice(0, 40)
        .map((text) => ({ text })),
    built: ELEMENT_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'pptxAnim.animation.buildTimingXml',
    call: (_text, args) => buildTimingXml(args.anims as SlideAnimation[]),
    built: [[], ...LISTS].map((anims) => ({ args: { anims } })),
    mutation: 'none',
  },
  {
    fn: 'pptxAnim.animation.patchSlideTimingXml',
    call: (text, args) => patchSlideTimingXml(text, args.anims as SlideAnimation[]),
    fromDocument: patchInputsOf,
    built: PATCH_INPUTS,
  },
  {
    fn: 'pptxAnim.animation.readSlideTimingXml',
    call: (text) => readSlideTimingXml(text),
    fromDocument: (parts) =>
      partsMatching(parts, TIMING_PART).flatMap((text) => [{ text }, { text: suffixOf(text) }]),
    built: [RICH, ...READ_EDGES, ...ROUND_TRIPS].map((text) => ({ text })),
  },
  {
    fn: 'pptxAnim.animation.patchSlideTimingIncrementalXml',
    call: (text, args) => patchSlideTimingIncrementalXml(text, args.anims as SlideAnimation[]),
    fromDocument: patchInputsOf,
    built: PATCH_INPUTS,
  },
  {
    fn: 'pptxAnim.animation.setSlideAnimations',
    call: (text, args) => {
      const slide = slideOf(text, args)
      setSlideAnimations(slide, args.anims as SlideAnimation[])
      return { bodySuffix: slide.bodySuffix, structureDirty: slide.structureDirty }
    },
    fromDocument: patchInputsOf,
    built: PATCH_INPUTS,
  },
  {
    fn: 'pptxAnim.animation.getSlideAnimations',
    call: (text, args) => getSlideAnimations(slideOf(text, args)),
    fromDocument: (parts) =>
      partsMatching(parts, TIMING_PART).map((text) => ({ text: suffixOf(text) })),
    built: [RICH, AUTO, BUILT1, INK, NO_BLD, BODY_NO_TIMING].map((text) => ({ text })),
  },
  {
    fn: 'pptxAnim.animation.pruneTimingForSpids',
    call: (text, args) => {
      const slide = slideOf(text, args)
      const changed = pruneTimingForSpids(slide, new Set(args.spids as number[]))
      return { changed, bodySuffix: slide.bodySuffix, structureDirty: slide.structureDirty }
    },
    fromDocument: (parts) =>
      partsMatching(parts, TIMING_PART).map((text) => ({
        text: suffixOf(text),
        args: { spids: [...cNvPrIdsInXml(text)] },
      })),
    built: PRUNE_INPUTS,
  },
  {
    fn: 'pptxAnim.animation.cNvPrIdsInXml',
    call: (text) => cNvPrIdsInXml(text),
    fromDocument: (parts) =>
      partsMatching(parts, TIMING_PART)
        .flatMap((text) => [text, ...shapesOf(text).slice(0, 10)])
        .map((text) => ({ text })),
    built: [...ELEMENT_TEXTS, RICH].map((text) => ({ text })),
  },
]
