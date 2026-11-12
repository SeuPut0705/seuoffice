/**
 * Parse one slide → Slide element tree.
 *
 * Semantic parsing uses fast-xml-parser; byte-fidelity anchors come from scanSlide
 * (one-to-one in top-level shape order). Phase 1 supports: text boxes / pictures /
 * simple shapes; everything else → passthrough.
 */
import { type Theme } from './theme'
import { type PlaceholderMap, type MasterTextStyles, type TextStyleLevels } from './placeholder'
import type { Slide, SlideElement, Fill } from './types'
import { call } from './engine'

const EMU_PER_PT = 12700
/** <a:bodyPr> inset defaults (EMU): 0.1" left/right, 0.05" top/bottom. */
export const DEFAULT_BODY_INSETS = { l: 91440, t: 45720, r: 91440, b: 45720 }
export interface ParseContext {
  theme?: Theme
  /** Effective fill of the enclosing group (<a:grpFill/> in a child resolves to this) */
  groupFill?: Fill
  /** Placeholder color for resolving style ref templates (value substituted for schemeClr val="phClr") */
  phClr?: string
  /** Media rId → zip path, for picture parsing */
  mediaRels?: Map<string, string>
  /** Hyperlink rId → resolved target: external url, or "slide:N" (0-based) for slide jumps */
  hlinkRels?: Map<string, string>
  /** Chart rId → chartN.xml content (chart part referenced by a graphicFrame) */
  chartXmls?: Map<string, string>
  /** Chart rId → chartUserShapes drawing content (user-drawn overlays on the chart) */
  chartUserShapes?: Map<string, string>
  /** Audio/video rId → media zip path or external URL (r:link of videoFile/audioFile) */
  avRels?: Map<string, { target: string; external?: boolean }>
  /** 3D model rId → .glb zip path (am3d:model3d r:embed) */
  model3dRels?: Map<string, string>
  /** SmartArt: diagramData rId (dgm:relIds@r:dm) → data part content (fallback layout without a drawing part) */
  diagramDatas?: Map<string, string>
  /** SmartArt: diagramData rId (dgm:relIds@r:dm) → prerendered drawing part content */
  diagramDrawings?: Map<string, string>
  /** SmartArt: diagramLayout rId (dgm:relIds@r:lo) → layout definition part content */
  diagramLayouts?: Map<string, string>
  /** SmartArt: diagramColors rId (dgm:relIds@r:cs) → color definition part content */
  diagramColors?: Map<string, string>
  /** Placeholder geometry inheritance table: from the slideLayout (read-only) */
  layoutPlaceholders?: PlaceholderMap
  /** Placeholder geometry inheritance table: from the slideMaster (read-only, fallback when the layout lacks it) */
  masterPlaceholders?: PlaceholderMap
  /** master <p:txStyles> text style defaults (title/body/other families) */
  masterTextStyles?: MasterTextStyles
  /** presentation.xml <p:defaultTextStyle>: base defaults for every non-placeholder shape */
  defaultTextStyle?: TextStyleLevels
  /** Full layout XML (read-only, for background inheritance) */
  layoutBg?: string
  /** Full master XML (read-only, background inheritance fallback) */
  masterBg?: string
  /** Layout/master part image rels (blip rIds in inherited backgrounds live in those parts) */
  layoutMediaRels?: Map<string, string>
  masterMediaRels?: Map<string, string>
  /** Theme part image rels (blip rIds inside fmtScheme fill templates live in the theme part) */
  themeMediaRels?: Map<string, string>
  /** Chart rId → that chart part's own image rels (for chart background picture fills) */
  chartMediaRels?: Map<string, Map<string, string>>
  /** Chart rIds whose part has a Microsoft chartStyle companion (modern gray label defaults) */
  chartStyleRels?: Set<string>
  /** chart rId → its themeOverride part XML (chart-local clrScheme/fontScheme) */
  chartThemeOverrides?: Map<string, string>
  /** Diagram data rId → the drawing part's own image rels (SmartArt picture fills) */
  diagramMediaRels?: Map<string, Map<string, string>>
  /** ppt/tableStyles.xml source (table style definitions, read-only) */
  tableStyles?: string
  /** Legacy VML previews: oleObj spid → preview image zip path (v:shape/v:imagedata) */
  vmlPreviews?: Map<string, string>
}
export interface SlideParseInput {
  path: string
  slideXml: string
  layoutPath?: string
  masterPath?: string
  ctx: ParseContext
}
export function parseSlide(input: SlideParseInput): Slide {
  return call('parseSlide', [input], {
    names: ['input'],
    shape: {
      k: 'obj',
      f: {
        elements: {
          k: 'arr',
          v: {
            k: 'obj',
            f: {
              chart: {
                k: 'obj',
                f: {
                  series: {
                    k: 'arr',
                    v: {
                      k: 'obj',
                      f: {
                        pointColors: { k: 'arr', u: true },
                        pointFills: { k: 'arr', u: true },
                        pointNoFill: { k: 'arr', u: true },
                        pointLines: { k: 'arr', u: true },
                        pointExplosionPct: { k: 'arr', u: true },
                      },
                    },
                  },
                  sunburst: { k: 'obj', f: { pointColors: { k: 'arr', u: true } } },
                },
              },
            },
          },
        },
        decorations: {
          k: 'arr',
          v: {
            k: 'obj',
            f: {
              chart: {
                k: 'obj',
                f: {
                  series: {
                    k: 'arr',
                    v: {
                      k: 'obj',
                      f: {
                        pointColors: { k: 'arr', u: true },
                        pointFills: { k: 'arr', u: true },
                        pointNoFill: { k: 'arr', u: true },
                        pointLines: { k: 'arr', u: true },
                        pointExplosionPct: { k: 'arr', u: true },
                      },
                    },
                  },
                  sunburst: { k: 'obj', f: { pointColors: { k: 'arr', u: true } } },
                },
              },
            },
          },
        },
      },
    },
  }) as never
}
/** Extract the <p:bg> background fill from slide/layout/master XML (read-only). */
export function parseBackground(xml: string, ctx: ParseContext): Fill | undefined {
  return call('parseBackground', [xml, ctx], { names: ['xml', 'ctx'], undef: true }) as never
}
/** Direct child fragments of a p:grpSp in document order (depth-aware: nested groups stay one slice). */
export function sliceGroupChildXmls(grpXml: string): string[] {
  return call('sliceGroupChildXmls', [grpXml]) as never
}
/**
 * SmartArt without a usable prerendered drawing: lay the data tree out ourselves.
 * Flat lists keep the PowerPoint-measured tile grid; hierarchical data dispatches on
 * the layout part's uniqueId to a small family of hand-written algorithms
 * (columns / table list / stacked list / hierarchy), defaulting to top-node tiles
 * with descendant bullet text.
 */
export function layoutDiagramFallback(
  dataXml: string,
  ctx: ParseContext,
  frameCx: number,
  frameCy: number,
  layoutId?: string,
  colorsXml?: string,
  layoutXml?: string,
): SlideElement[] {
  return call(
    'layoutDiagramFallback',
    [dataXml, ctx, frameCx, frameCy, layoutId, colorsXml, layoutXml],
    {
      names: ['dataXml', 'ctx', 'frameCx', 'frameCy', 'layoutId', 'colorsXml', 'layoutXml'],
      shape: {
        k: 'arr',
        v: {
          k: 'obj',
          f: {
            chart: {
              k: 'obj',
              f: {
                series: {
                  k: 'arr',
                  v: {
                    k: 'obj',
                    f: {
                      pointColors: { k: 'arr', u: true },
                      pointFills: { k: 'arr', u: true },
                      pointNoFill: { k: 'arr', u: true },
                      pointLines: { k: 'arr', u: true },
                      pointExplosionPct: { k: 'arr', u: true },
                    },
                  },
                },
                sunburst: { k: 'obj', f: { pointColors: { k: 'arr', u: true } } },
              },
            },
          },
        },
      },
    },
  ) as never
}
// ── master/layout decoration layer ───────────────────────────────────

export interface DecorationOptions {
  /**
   * Footer-family placeholder types allowed to render (subset of ftr/sldNum/dt).
   * Such placeholders on the master show only when <p:hf> hasn't disabled them
   * and the slide has no placeholder of the same type.
   */
  hfTypes?: Set<string>
  /** Actual value of the slide-number field <a:fld type="slidenum"> (replaces the cached text) */
  slideNum?: number
  /** Skip non-placeholder shapes (showMasterSp="0"), keeping only the hf placeholders */
  hideShapes?: boolean
}
/**
 * Parse decoration-layer elements from layout/master XML (read-only render, not saved):
 * - Non-placeholder concrete shapes (logos/color bars/decor images/connectors/groups) are all kept;
 * - Placeholders keep only the footer family specified by opts.hfTypes (ftr/sldNum/dt);
 *   the rest (title/body/pic etc. are content carriers, overridden by the slide) are skipped.
 */
export function parseDecorations(
  xml: string,
  ctx: ParseContext,
  opts: DecorationOptions = {},
): SlideElement[] {
  return call('parseDecorations', [xml, ctx, opts], {
    names: ['xml', 'ctx', 'opts'],
    shape: {
      k: 'arr',
      v: {
        k: 'obj',
        f: {
          chart: {
            k: 'obj',
            f: {
              series: {
                k: 'arr',
                v: {
                  k: 'obj',
                  f: {
                    pointColors: { k: 'arr', u: true },
                    pointFills: { k: 'arr', u: true },
                    pointNoFill: { k: 'arr', u: true },
                    pointLines: { k: 'arr', u: true },
                    pointExplosionPct: { k: 'arr', u: true },
                  },
                },
              },
              sunburst: { k: 'obj', f: { pointColors: { k: 'arr', u: true } } },
            },
          },
        },
      },
    },
  }) as never
}
export { EMU_PER_PT }
