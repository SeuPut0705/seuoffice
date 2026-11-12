//! `apps/shell/src/main/split-layout.ts`: pure split-view layout and drag
//! decision math. Numbers are JavaScript numbers (`f64`): NaN and the
//! infinities flow through as they do there.

use jscompat::{math_max, math_min};

/// `SPLIT_DIVIDER_PX` of `shared/split-view-api.ts`
const SPLIT_DIVIDER_PX: f64 = 6.0;
/// `SPLIT_MIN_PANE_PX` of the same file
const SPLIT_MIN_PANE_PX: f64 = 240.0;
/// `SPLIT_EDGE_ZONE_PX` of the same file
const SPLIT_EDGE_ZONE_PX: f64 = 120.0;
/// `TAB_STRIP_HEIGHT` of `shared/tab-drag-geometry.ts`
const TAB_STRIP_HEIGHT: f64 = 40.0;

/// Share of the first pane (a) a new split starts with.
pub const SPLIT_EVEN_RATIO: f64 = 0.5;

/// `Rect` of `shared/tab-drag-geometry.ts`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `SplitOrientation`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitOrientation {
    Side,
    Stack,
}

impl SplitOrientation {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            SplitOrientation::Side => "side",
            SplitOrientation::Stack => "stack",
        }
    }
}

/// `PaneRects`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PaneRects {
    pub a: Rect,
    pub b: Rect,
}

/// `splitAvailablePx`: space the two panes share along the split axis,
/// divider gap taken out.
pub fn split_available_px(content: &Rect, orientation: SplitOrientation) -> f64 {
    let along = if orientation == SplitOrientation::Side {
        content.width
    } else {
        content.height
    };
    math_max(0.0, along - SPLIT_DIVIDER_PX)
}

/// `splitRatioLimits`: `(min, max)`.
pub fn split_ratio_limits(content: &Rect, orientation: SplitOrientation) -> (f64, f64) {
    let available = split_available_px(content, orientation);
    if available <= 0.0 {
        return (SPLIT_EVEN_RATIO, SPLIT_EVEN_RATIO);
    }
    let min = SPLIT_MIN_PANE_PX / available;
    if min >= SPLIT_EVEN_RATIO {
        return (0.0, 1.0);
    }
    (min, 1.0 - min)
}

/// `clampSplitRatio`
pub fn clamp_split_ratio(ratio: f64, content: &Rect, orientation: SplitOrientation) -> f64 {
    let (min, max) = split_ratio_limits(content, orientation);
    math_min(max, math_max(min, ratio))
}

/// `paneRects`
pub fn pane_rects(content: &Rect, orientation: SplitOrientation, ratio: f64) -> PaneRects {
    let available = split_available_px(content, orientation);
    if orientation == SplitOrientation::Side {
        let a_width = available * ratio;
        return PaneRects {
            a: Rect {
                x: content.x,
                y: content.y,
                width: a_width,
                height: content.height,
            },
            b: Rect {
                x: content.x + a_width + SPLIT_DIVIDER_PX,
                y: content.y,
                width: available - a_width,
                height: content.height,
            },
        };
    }
    let a_height = available * ratio;
    PaneRects {
        a: Rect {
            x: content.x,
            y: content.y,
            width: content.width,
            height: a_height,
        },
        b: Rect {
            x: content.x,
            y: content.y + a_height + SPLIT_DIVIDER_PX,
            width: content.width,
            height: available - a_height,
        },
    }
}

/// `splitDropZone`
pub fn split_drop_zone(x: f64, y: f64, width: f64, height: f64) -> Option<SplitOrientation> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    if y < TAB_STRIP_HEIGHT {
        return None;
    }
    let from_right = width - x;
    let from_bottom = height - y;
    let right_hit = from_right <= SPLIT_EDGE_ZONE_PX;
    let bottom_hit = from_bottom <= SPLIT_EDGE_ZONE_PX;
    if right_hit && bottom_hit {
        return Some(if from_right <= from_bottom {
            SplitOrientation::Side
        } else {
            SplitOrientation::Stack
        });
    }
    if right_hit {
        return Some(SplitOrientation::Side);
    }
    if bottom_hit {
        return Some(SplitOrientation::Stack);
    }
    None
}

/// `'a' | 'b'`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pane {
    A,
    B,
}

impl Pane {
    pub fn as_str(self) -> &'static str {
        match self {
            Pane::A => "a",
            Pane::B => "b",
        }
    }
}

/// The fields of `SplitViewState` that `SplitDragContext.split` picks.
#[derive(Debug, Clone, PartialEq)]
pub struct DragSplit {
    pub a_tab_id: String,
    pub b_tab_id: String,
    pub orientation: SplitOrientation,
    pub focus: Pane,
}

/// `SplitDragContext.dragged`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DraggedTab {
    /// the dragged tab is a document tab (home/help/present are not)
    pub is_document: bool,
    /// the dragged tab is currently shown in one of the two panes
    pub is_pane_tab: bool,
    /// the pane whose document is this tab's document (by tab id or file path)
    pub doc_pane: Option<Pane>,
}

/// `SplitDragContext`
#[derive(Debug, Clone, PartialEq)]
pub struct SplitDragContext {
    /// the live split, or `None` when the window shows a single pane
    pub split: Option<DragSplit>,
    pub dragged: DraggedTab,
    /// the edge orientation the pointer was dropped on
    pub dropped: SplitOrientation,
}

/// `SplitDropIntent`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitDropIntent {
    Create(SplitOrientation),
    Replace,
    Reorient(SplitOrientation),
    Focus,
    Flip(SplitOrientation),
    Noop,
}

/// `decideSplitDrop`: `None` is "no split intent".
pub fn decide_split_drop(ctx: &SplitDragContext) -> Option<SplitDropIntent> {
    let SplitDragContext {
        split,
        dragged,
        dropped,
    } = ctx;
    if !dragged.is_document {
        return None;
    }
    let Some(split) = split else {
        // no split yet: the dragged tab opens the pane on the dropped side
        return if dragged.is_pane_tab {
            None
        } else {
            Some(SplitDropIntent::Create(*dropped))
        };
    };
    if dragged.is_pane_tab {
        return Some(if *dropped == split.orientation {
            SplitDropIntent::Noop
        } else {
            SplitDropIntent::Flip(*dropped)
        });
    }
    if dragged.doc_pane.is_some() {
        return Some(SplitDropIntent::Focus);
    }
    Some(if *dropped == split.orientation {
        SplitDropIntent::Replace
    } else {
        SplitDropIntent::Reorient(*dropped)
    })
}

/// `SplitActivationMode`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitActivationMode {
    Normal,
    Pane,
    ReplacePane,
    Cover,
}

impl SplitActivationMode {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            SplitActivationMode::Normal => "normal",
            SplitActivationMode::Pane => "pane",
            SplitActivationMode::ReplacePane => "replace-pane",
            SplitActivationMode::Cover => "cover",
        }
    }
}

/// `activationMode(split, tab)`: `split` is the pair of pane tab ids; `tab`
/// is `{ id, kind, present? }` with `present` true only where the TypeScript
/// holds `true`.
pub fn activation_mode(
    split: Option<(&str, &str)>,
    tab_id: &str,
    tab_kind: &str,
    tab_present: bool,
) -> SplitActivationMode {
    let Some((a_tab_id, b_tab_id)) = split else {
        return SplitActivationMode::Normal;
    };
    if tab_id == a_tab_id || tab_id == b_tab_id {
        return SplitActivationMode::Pane;
    }
    if tab_kind == "home" || tab_kind == "help" || tab_present {
        return SplitActivationMode::Cover;
    }
    SplitActivationMode::ReplacePane
}

/// `splitSurvivor`: the pane tab that survives when `removed_tab_id` leaves
/// the split, as `(keep, tab id)`.
pub fn split_survivor<'a>(
    a_tab_id: &'a str,
    b_tab_id: &'a str,
    removed_tab_id: &str,
) -> Option<(Pane, &'a str)> {
    if removed_tab_id == a_tab_id {
        return Some((Pane::B, b_tab_id));
    }
    if removed_tab_id == b_tab_id {
        return Some((Pane::A, a_tab_id));
    }
    None
}

/// One entry of `oppositeDocumentId`'s `tabs`.
#[derive(Debug, Clone, PartialEq)]
pub struct OppositeTab {
    pub id: String,
    pub kind: String,
    /// `present?: boolean`, truthy test
    pub present: bool,
    pub has_view: bool,
}

/// `oppositeDocumentId`: the "other document" a create-drop puts in the
/// opposite pane.
pub fn opposite_document_id<'a>(
    active_id: &'a str,
    previous_active_id: Option<&'a str>,
    exclude_id: &str,
    tabs: &'a [OppositeTab],
) -> Option<&'a str> {
    for candidate in [Some(active_id), previous_active_id] {
        let Some(candidate) = candidate else {
            continue;
        };
        if candidate == exclude_id {
            continue;
        }
        let Some(tab) = tabs.iter().find(|t| t.id == candidate) else {
            continue;
        };
        if !tab.has_view || tab.present {
            continue;
        }
        if tab.kind == "home" || tab.kind == "help" {
            continue;
        }
        return Some(&tab.id);
    }
    None
}
