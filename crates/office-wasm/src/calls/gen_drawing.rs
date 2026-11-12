//! The picture and shape patches of generate.ts, called by name. A number
//! argument may cross as text (`"NaN"`, `"Infinity"`), read with `Number`.

use docx_engine::generate::drawing_patch::{
    ImagePatch, MarginAlign, PosOffset, ShapeDrawingLocation, ShapeStylePatch, TextboxSizePatch,
    apply_image_wrap, apply_image_z_order, apply_shape_wrap_at, apply_shape_z_order_at,
    patch_drawing_extent, patch_image_paragraph_xml, patch_shape_styles, patch_textbox_heights,
    patch_textbox_sizes, resize_anchored_picture_xml, resize_inline_picture_xml, swap_anchor_wrap,
};
use docx_engine::model::ImageWrap;
use jscompat::to_number;
use serde_json::Value;

use super::{Returned, value};

fn number(v: &Value, key: &str) -> Result<f64, String> {
    match v {
        Value::Number(n) => n.as_f64().ok_or_else(|| format!("the {key} argument")),
        Value::String(s) => Ok(to_number(s)),
        _ => Err(format!("the {key} argument is not a number")),
    }
}

/// `undefined` and `null` as `None`.
fn opt_number(o: &Value, key: &str) -> Result<Option<f64>, String> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => number(v, key).map(Some),
    }
}

/// `None` undefined, `Some(None)` null.
fn nullable_number(o: &Value, key: &str) -> Result<Option<Option<f64>>, String> {
    match o.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => number(v, key).map(|n| Some(Some(n))),
    }
}

fn nullable_string(o: &Value, key: &str) -> Result<Option<Option<String>>, String> {
    match o.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.clone()))),
        Some(_) => Err(format!("the {key} argument is not a string")),
    }
}

fn opt_string(o: &Value, key: &str) -> Option<String> {
    o.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn req_number(o: &Value, key: &str) -> Result<f64, String> {
    opt_number(o, key)?.ok_or_else(|| format!("the {key} argument is missing"))
}

fn wrap(args: &Value) -> Result<Option<ImageWrap>, String> {
    match args.get("wrap") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("the wrap argument: {e}")),
    }
}

fn location(args: &Value) -> Result<ShapeDrawingLocation, String> {
    let l = args
        .get("location")
        .ok_or("the location argument is missing")?;
    Ok(ShapeDrawingLocation {
        shape_id: opt_string(l, "shapeId"),
        box_index: req_number(l, "boxIndex")?,
    })
}

fn list<T>(
    args: &Value,
    key: &str,
    f: impl Fn(&Value) -> Result<T, String>,
) -> Result<Vec<Option<T>>, String> {
    args.get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("the {key} argument is not a list"))?
        .iter()
        .map(|v| {
            if v.is_null() {
                Ok(None)
            } else {
                f(v).map(Some)
            }
        })
        .collect()
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "patchImageParagraphXml" => {
            let p = args.get("patch").ok_or("the patch argument is missing")?;
            let patch = ImagePatch {
                width_px: opt_number(p, "widthPx")?,
                height_px: opt_number(p, "heightPx")?,
                align: nullable_string(p, "align")?,
                pos_offset_x: opt_number(p, "posOffsetX")?,
                pos_offset_y: opt_number(p, "posOffsetY")?,
                rot_deg: opt_number(p, "rotDeg")?,
                flip_h: p.get("flipH").and_then(Value::as_bool),
                flip_v: p.get("flipV").and_then(Value::as_bool),
            };
            value(patch_image_paragraph_xml(text, &patch))
        }
        "applyImageZOrder" => value(apply_image_z_order(text, opt_number(args, "zOrder")?)),
        "applyImageWrap" => {
            let pos = match args.get("posOffset") {
                None | Some(Value::Null) => None,
                Some(p) => Some(PosOffset {
                    x: req_number(p, "x")?,
                    y: req_number(p, "y")?,
                    relative_to: opt_string(p, "relativeTo"),
                }),
            };
            let margin = match args.get("marginAlign") {
                None | Some(Value::Null) => None,
                Some(m) => Some(MarginAlign {
                    h: opt_string(m, "h").ok_or("the marginAlign.h argument")?,
                    v: opt_string(m, "v").ok_or("the marginAlign.v argument")?,
                }),
            };
            value(apply_image_wrap(
                text,
                wrap(args)?,
                pos.as_ref(),
                margin.as_ref(),
                opt_number(args, "zOrder")?,
            ))
        }
        "applyShapeZOrderAt" => value(apply_shape_z_order_at(
            text,
            &location(args)?,
            req_number(args, "zOrder")?,
        )),
        "applyShapeWrapAt" => value(apply_shape_wrap_at(
            text,
            &location(args)?,
            wrap(args)?,
            opt_number(args, "zOrder")?,
        )),
        "swapAnchorWrap" => value(swap_anchor_wrap(
            text,
            wrap(args)?.ok_or("the wrap argument is missing")?,
            opt_number(args, "zOrder")?,
        )),
        "patchTextboxHeights" => {
            let heights = list(args, "heightsPx", |v| number(v, "heightsPx"))?;
            value(patch_textbox_heights(text, &heights))
        }
        "patchTextboxSizes" => {
            let sizes = list(args, "sizes", |s| {
                Ok(TextboxSizePatch {
                    w_px: opt_number(s, "wPx")?,
                    h_px: opt_number(s, "hPx")?,
                })
            })?;
            value(patch_textbox_sizes(text, &sizes))
        }
        "patchShapeStyles" => {
            let styles = list(args, "styles", |s| {
                Ok(ShapeStylePatch {
                    fill_hex: nullable_string(s, "fillHex")?,
                    border_hex: nullable_string(s, "borderHex")?,
                    rot_deg: nullable_number(s, "rotDeg")?,
                    border_width_px: nullable_number(s, "borderWidthPx")?,
                })
            })?;
            value(patch_shape_styles(text, &styles))
        }
        "patchDrawingExtent" => value(patch_drawing_extent(
            text,
            req_number(args, "wPx")?,
            req_number(args, "hPx")?,
        )),
        "resizeInlinePictureXml" => value(resize_inline_picture_xml(
            text,
            req_number(args, "widthPx")?,
            req_number(args, "heightPx")?,
        )),
        "resizeAnchoredPictureXml" => value(resize_anchored_picture_xml(
            text,
            req_number(args, "widthPx")?,
            req_number(args, "heightPx")?,
        )),
        _ => Err(format!("unknown function {function}")),
    }
}
