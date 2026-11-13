//! identity.ts, redaction-xml.ts and model3d.ts of the slides engine, called
//! as `<module>.<TypeScript name>`. An element is built from `text` (its
//! `anchor.originalXml`) and `args` (`elId`, `nvId`, `noAnchor`), as
//! tools/pptx-diff/calls-ident.ts builds it.

use std::sync::Arc;

use jscompat::{JsNum, number_to_string};
use ooxml_xml::ObjectOptions;
use pptx_engine::identity::{
    element_cnvpr_id, element_durable_id, ensure_creation_id, group_child_durable_id,
    matches_element_ref, slide_durable_id, with_fresh_creation_ids,
};
use pptx_engine::model3d::{
    AM3D_NS, GLB_CONTENT_TYPE, GlbBounds, MODEL3D_EMU_PER_METER, MODEL3D_FOV, MODEL3D_LIGHTS,
    MODEL3D_RATIO_ONE, MODEL3D_REL_TYPE, Model3dRotation, Model3dXmlOptions, NO_ROTATION,
    model3d_framing, model3d_xml, read_model3d_rotation, set_model3d_rotation_xml,
    sync_model3d_frame,
};
use pptx_engine::redaction_xml::{
    REDACT_EL, REDACT_EXT_URI, REDACT_NS_WRITTEN, REDACT_PREFIX, diagram_data_redact_label,
    has_redact_ext_in, read_redact_label, redact_ext_xml, set_redact_ext, strip_redact_ext,
    sync_redact_ext,
};
use pptx_engine::types::{ByteAnchor, Slide, SlideElement, TextElement};
use pptx_engine::xml_utils::xml_parse_object as parse_object;
use serde_json::{Value, json};

use super::{Returned, arg, optional, required, value};

/// `isArray` of the parser of packages/pptx-engine/src/parse.ts, which
/// parses the `<a:rPr>` and `<p:spPr>` nodes `readRedactLabel` is given.
const PARSE_ARRAY_NAMES: [&str; 12] = [
    "a:p",
    "a:r",
    "a:br",
    "a:fld",
    "p:sp",
    "p:pic",
    "p:graphicFrame",
    "p:grpSp",
    "p:cxnSp",
    "a:tr",
    "a:tc",
    "a:gridCol",
];

/// An element that holds only the fields the gate gives: `id`, the bytes of
/// its anchor and `nvId`.
pub(super) fn element_with(
    id: Option<String>,
    anchor_xml: Option<&str>,
    nv_id: Option<String>,
) -> SlideElement {
    let mut el = TextElement::default();
    if let Some(id) = id {
        el.id.set(id);
    }
    if let Some(xml) = anchor_xml {
        el.anchor.set(ByteAnchor {
            sp_index: 0,
            original_xml: Arc::from(xml),
            range: [0, 0],
            gap_after: None,
        });
    }
    if let Some(nv_id) = nv_id {
        el.nv_id.set(nv_id);
    }
    SlideElement::Text(Box::new(el))
}

/// `nvId` of the args: the text, or the number as `${nvId}`.
fn nv_id_arg(args: &Value) -> Result<Option<String>, String> {
    match args.get("nvId") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(Value::Number(number)) => number
            .as_f64()
            .map(|n| Some(number_to_string(n)))
            .ok_or_else(|| "nvId: not a number".to_owned()),
        Some(_) => Err("nvId: expected a string or a number".to_owned()),
    }
}

/// The element of `text` and `args`: no anchor where `args.noAnchor` is true.
fn element_of(text: &str, args: &Value) -> Result<SlideElement, String> {
    let no_anchor: Option<bool> = arg(args, "noAnchor")?;
    Ok(element_with(
        Some(arg(args, "elId")?.unwrap_or_default()),
        (no_anchor != Some(true)).then_some(text),
        nv_id_arg(args)?,
    ))
}

fn redaction_constant(name: &str) -> Returned {
    match name {
        "REDACT_EXT_URI" => value(REDACT_EXT_URI),
        "REDACT_EL" => value(REDACT_EL),
        "REDACT_NS_WRITTEN" => value(REDACT_NS_WRITTEN),
        "REDACT_PREFIX" => value(REDACT_PREFIX),
        _ => Err(format!("no constant {name}")),
    }
}

fn model3d_constant(name: &str) -> Returned {
    match name {
        "AM3D_NS" => value(AM3D_NS),
        "MODEL3D_REL_TYPE" => value(MODEL3D_REL_TYPE),
        "GLB_CONTENT_TYPE" => value(GLB_CONTENT_TYPE),
        "MODEL3D_RATIO_ONE" => value(JsNum(MODEL3D_RATIO_ONE)),
        "MODEL3D_EMU_PER_METER" => value(JsNum(MODEL3D_EMU_PER_METER)),
        "MODEL3D_FOV" => value(JsNum(MODEL3D_FOV)),
        "NO_ROTATION" => value(NO_ROTATION),
        "MODEL3D_LIGHTS" => value(MODEL3D_LIGHTS),
        _ => Err(format!("no constant {name}")),
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "identity.elementDurableId" => value(element_durable_id(&element_of(text, args)?)?),
        "identity.slideDurableId" => {
            let mut slide = Slide::default();
            slide.path.set(text.to_owned());
            value(slide_durable_id(&slide))
        }
        "identity.elementCNvPrId" => value(element_cnvpr_id(&element_of(text, args)?)?),
        "identity.matchesElementRef" => value(matches_element_ref(
            &element_of(text, args)?,
            &required::<String>(args, "id")?,
        )?),
        "identity.withFreshCreationIds" => {
            let uuid: String = required(args, "uuid")?;
            value(with_fresh_creation_ids(text, || uuid.clone())?)
        }
        "identity.ensureCreationId" => {
            let mut el = element_of(text, args)?;
            ensure_creation_id(&mut el, &required::<String>(args, "uuid")?)?;
            optional(match &el {
                SlideElement::Text(text) => text
                    .anchor
                    .as_ref()
                    .map(|anchor| json!({ "originalXml": &*anchor.original_xml })),
                _ => None,
            })
        }
        "identity.groupChildDurableId" => {
            let grp_no_anchor: Option<bool> = arg(args, "grpNoAnchor")?;
            let grp = element_with(
                Some(String::new()),
                (grp_no_anchor != Some(true)).then_some(text),
                None,
            );
            let child_xml: String = arg(args, "childXml")?.unwrap_or_default();
            let child = element_with(Some(String::new()), Some(&child_xml), nv_id_arg(args)?);
            value(group_child_durable_id(&grp, &child)?)
        }
        "redaction-xml.constants" => redaction_constant(&required::<String>(args, "name")?),
        "redaction-xml.redactExtXml" => value(redact_ext_xml(text)),
        "redaction-xml.hasRedactExtIn" => {
            value(has_redact_ext_in(text).map_err(|error| error.to_string())?)
        }
        "redaction-xml.diagramDataRedactLabel" => optional(diagram_data_redact_label(Some(text))?),
        "redaction-xml.syncRedactExt" => {
            let label: Option<String> = arg(args, "label")?;
            value(
                sync_redact_ext(text, &required::<String>(args, "tag")?, label.as_deref())
                    .map_err(|error| error.to_string())?,
            )
        }
        "redaction-xml.readRedactLabel" => {
            let tree = parse_object(
                text,
                &ObjectOptions {
                    trim_values: false,
                    parse_tag_value: false,
                    array_names: &PARSE_ARRAY_NAMES,
                },
            )
            .map_err(|error| error.to_string())?;
            optional(read_redact_label(
                tree.get(required::<String>(args, "name")?.as_str()),
            ))
        }
        "redaction-xml.stripRedactExt" => {
            value(strip_redact_ext(text).map_err(|error| error.to_string())?)
        }
        "redaction-xml.setRedactExt" => value(
            set_redact_ext(text, &required::<String>(args, "label")?)
                .map_err(|error| error.to_string())?,
        ),
        "model3d.constants" => model3d_constant(&required::<String>(args, "name")?),
        "model3d.model3dFraming" => {
            let bounds: Option<GlbBounds> = arg(args, "bounds")?;
            value(model3d_framing(bounds.as_ref()))
        }
        "model3d.model3dXml" => {
            let model_r_id: String = required(args, "modelRId")?;
            let poster_r_id: String = required(args, "posterRId")?;
            let options = Model3dXmlOptions {
                id: required(args, "id")?,
                name: text,
                offset: required(args, "offset")?,
                model_r_id: &model_r_id,
                poster_r_id: &poster_r_id,
                bounds: arg(args, "bounds")?,
                rot: arg(args, "rot")?,
            };
            value(model3d_xml(&options, &required::<String>(args, "uuid")?))
        }
        "model3d.syncModel3dFrame" => value(sync_model3d_frame(text)),
        "model3d.readModel3dRotation" => value(read_model3d_rotation(text)),
        "model3d.setModel3dRotationXml" => value(set_model3d_rotation_xml(
            text,
            &required::<Model3dRotation>(args, "rot")?,
        )),
        _ => Err(format!("unknown function {function}")),
    }
}
