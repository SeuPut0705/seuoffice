//! 3D models as PowerPoint stores them (packages/pptx-engine/src/model3d.ts):
//! an mc:AlternateContent whose Choice is a p:graphicFrame holding
//! am3d:model3d and whose Fallback is a p:pic of the model's latest
//! rendering. The editor moves the picture and keeps the Choice in step.

use std::f64::consts::PI;

use jscompat::{
    JsNum, JsRegex, js_regex, math_hypot, math_max, math_round, math_sin, number_to_string,
    number_truthy, replace_first, replace_first_with, to_number, truthy,
};
use serde::{Deserialize, Serialize};

use crate::xml_utils::{creation_id_xml, escape_xml_attr};

pub const AM3D_NS: &str = "http://schemas.microsoft.com/office/drawing/2017/model3d";
pub const MODEL3D_REL_TYPE: &str =
    "http://schemas.microsoft.com/office/2017/06/relationships/model3d";
/// PowerPoint's own spelling, with a dot.
pub const GLB_CONTENT_TYPE: &str = "model/gltf.binary";
const MC_NS: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/// Denominator of am3d's ratios (meterPerModelUnit, illuminance, intensity,
/// scale).
pub const MODEL3D_RATIO_ONE: f64 = 1_000_000.0;
/// am3d lengths are EMUs: 36,000,000 per meter.
pub const MODEL3D_EMU_PER_METER: f64 = 36_000_000.0;
/// PowerPoint's default camera: perspective, a field of view of 45 degrees in
/// 60,000ths of a degree.
pub const MODEL3D_FOV: f64 = 2_700_000.0;

/// am3d:rot, in 60,000ths of a degree, about the model's x, y and z axes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Model3dRotation {
    pub ax: JsNum,
    pub ay: JsNum,
    pub az: JsNum,
}

pub const NO_ROTATION: Model3dRotation = Model3dRotation {
    ax: JsNum(0.0),
    ay: JsNum(0.0),
    az: JsNum(0.0),
};

/// `GlbBounds` of glb-bounds.ts, as model3d.ts reads it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct GlbBounds {
    pub center: [JsNum; 3],
    pub size: [JsNum; 3],
}

/// `EmuRect` of types.ts. The port of types.ts replaces it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct EmuRect {
    pub x: JsNum,
    pub y: JsNum,
    pub cx: JsNum,
    pub cy: JsNum,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Model3dRatio {
    pub n: JsNum,
    pub d: JsNum,
}

/// What `model3dFraming` returns.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model3dFraming {
    pub meter_per_model_unit: Model3dRatio,
    pub pre_trans: [JsNum; 3],
    pub camera_z: JsNum,
}

/// `x || 1` on a number.
fn or_one(x: f64) -> f64 {
    if number_truthy(x) { x } else { 1.0 }
}

/// How PowerPoint frames a model: scaled to one meter across, centred, the
/// camera backed off to fit it.
pub fn model3d_framing(bounds: Option<&GlbBounds>) -> Model3dFraming {
    let size = bounds.map_or([1.0, 1.0, 1.0], |bounds| bounds.size.map(|s| s.0));
    let center = bounds.map_or([0.0, 0.0, 0.0], |bounds| bounds.center.map(|c| c.0));
    let [sx, sy, sz] = size;
    let max_extent = or_one(math_max(math_max(sx, sy), sz));
    let radius = or_one(math_hypot(&size.map(|s| s / 2.0)) / max_extent);
    let camera_z = radius / math_sin(((MODEL3D_FOV / 60000.0) * PI) / 360.0);
    Model3dFraming {
        meter_per_model_unit: if max_extent >= 1.0 {
            Model3dRatio {
                n: JsNum(MODEL3D_RATIO_ONE),
                d: JsNum(math_round(max_extent * MODEL3D_RATIO_ONE)),
            }
        } else {
            Model3dRatio {
                n: JsNum(math_round(MODEL3D_RATIO_ONE / max_extent)),
                d: JsNum(MODEL3D_RATIO_ONE),
            }
        },
        pre_trans: center.map(|c| JsNum(math_round((-c / max_extent) * MODEL3D_EMU_PER_METER))),
        camera_z: JsNum(math_round(camera_z * MODEL3D_EMU_PER_METER)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Model3dAmbientLight {
    pub rgb: [JsNum; 3],
    pub illuminance: JsNum,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Model3dPointLight {
    pub rgb: [JsNum; 3],
    pub intensity: JsNum,
    pub pos: [JsNum; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Model3dLights {
    pub ambient: Model3dAmbientLight,
    pub points: [Model3dPointLight; 3],
}

/// PowerPoint's default lighting for an inserted model: a grey ambient light
/// and three point lights (color in scRGB 100,000ths, intensity n/1,000,000,
/// position in EMUs).
pub const MODEL3D_LIGHTS: Model3dLights = Model3dLights {
    ambient: Model3dAmbientLight {
        rgb: [JsNum(50000.0), JsNum(50000.0), JsNum(50000.0)],
        illuminance: JsNum(500000.0),
    },
    points: [
        Model3dPointLight {
            rgb: [JsNum(100000.0), JsNum(75000.0), JsNum(50000.0)],
            intensity: JsNum(9765625.0),
            pos: [JsNum(21959998.0), JsNum(70920001.0), JsNum(16344003.0)],
        },
        Model3dPointLight {
            rgb: [JsNum(40000.0), JsNum(60000.0), JsNum(95000.0)],
            intensity: JsNum(12250000.0),
            pos: [JsNum(-37964106.0), JsNum(51130435.0), JsNum(57631972.0)],
        },
        Model3dPointLight {
            rgb: [JsNum(86837.0), JsNum(72700.0), JsNum(100000.0)],
            intensity: JsNum(3125000.0),
            pos: [JsNum(-37739122.0), JsNum(58056624.0), JsNum(-34769649.0)],
        },
    ],
};

/// `${n}`
fn text(n: f64) -> String {
    number_to_string(n)
}

fn scrgb([r, g, b]: [JsNum; 3]) -> String {
    format!(
        r#"<a:scrgbClr r="{}" g="{}" b="{}"/>"#,
        text(r.0),
        text(g.0),
        text(b.0)
    )
}

fn rot_xml(rot: &Model3dRotation) -> String {
    format!(
        r#"<am3d:rot ax="{}" ay="{}" az="{}"/>"#,
        text(math_round(rot.ax.0)),
        text(math_round(rot.ay.0)),
        text(math_round(rot.az.0)),
    )
}

/// What `model3dXml` is given.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Model3dXmlOptions<'a> {
    pub id: JsNum,
    pub name: &'a str,
    pub offset: EmuRect,
    pub model_r_id: &'a str,
    pub poster_r_id: &'a str,
    pub bounds: Option<GlbBounds>,
    pub rot: Option<Model3dRotation>,
}

/// The slide's mc:AlternateContent for a new model. `uuid` is what
/// `crypto.randomUUID()` gives its one `creationIdXml`.
pub fn model3d_xml(o: &Model3dXmlOptions<'_>, uuid: &str) -> String {
    let EmuRect { x, y, cx, cy } = o.offset;
    let framing = model3d_framing(o.bounds.as_ref());
    let [dx, dy, dz] = framing.pre_trans;
    let name = escape_xml_attr(o.name);
    let creation_id = creation_id_xml(uuid);
    let (x, y, cx_text, cy_text) = (text(x.0), text(y.0), text(cx.0), text(cy.0));
    let one = text(MODEL3D_RATIO_ONE);
    let mut model = String::new();
    model.push_str(&format!(r#"<am3d:model3d r:embed="{}">"#, o.model_r_id));
    model.push_str(&format!(
        r#"<am3d:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx_text}" cy="{cy_text}"/></a:xfrm>"#
    ));
    model.push_str(r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></am3d:spPr>"#);
    model.push_str(&format!(
        r#"<am3d:camera><am3d:pos x="0" y="0" z="{}"/>"#,
        text(framing.camera_z.0)
    ));
    model.push_str(&format!(
        r#"<am3d:up dx="0" dy="{}" dz="0"/><am3d:lookAt x="0" y="0" z="0"/>"#,
        text(MODEL3D_EMU_PER_METER)
    ));
    model.push_str(&format!(
        r#"<am3d:perspective fov="{}"/></am3d:camera>"#,
        text(MODEL3D_FOV)
    ));
    model.push_str(&format!(
        r#"<am3d:trans><am3d:meterPerModelUnit n="{}" d="{}"/>"#,
        text(framing.meter_per_model_unit.n.0),
        text(framing.meter_per_model_unit.d.0)
    ));
    model.push_str(&format!(
        r#"<am3d:preTrans dx="{}" dy="{}" dz="{}"/>"#,
        text(dx.0),
        text(dy.0),
        text(dz.0)
    ));
    model.push_str(&format!(
        r#"<am3d:scale><am3d:sx n="{one}" d="{one}"/><am3d:sy n="{one}" d="{one}"/>"#
    ));
    model.push_str(&format!(r#"<am3d:sz n="{one}" d="{one}"/></am3d:scale>"#));
    model.push_str(&rot_xml(o.rot.as_ref().unwrap_or(&NO_ROTATION)));
    model.push_str(r#"<am3d:postTrans dx="0" dy="0" dz="0"/></am3d:trans>"#);
    model.push_str(&format!(
        r#"<am3d:raster rName="Office3DRenderer" rVer="16.0.8326"><am3d:blip r:embed="{}"/></am3d:raster>"#,
        o.poster_r_id
    ));
    model.push_str(&format!(
        r#"<am3d:objViewport viewportSz="{}"/>"#,
        text(math_max(cx.0, cy.0))
    ));
    model.push_str(&format!(
        "<am3d:ambientLight><am3d:clr>{}</am3d:clr>",
        scrgb(MODEL3D_LIGHTS.ambient.rgb)
    ));
    model.push_str(&format!(
        r#"<am3d:illuminance n="{}" d="{one}"/></am3d:ambientLight>"#,
        text(MODEL3D_LIGHTS.ambient.illuminance.0)
    ));
    for light in &MODEL3D_LIGHTS.points {
        let [px, py, pz] = light.pos;
        model.push_str(&format!(
            r#"<am3d:ptLight rad="0"><am3d:clr>{}</am3d:clr>"#,
            scrgb(light.rgb)
        ));
        model.push_str(&format!(
            r#"<am3d:intensity n="{}" d="{one}"/>"#,
            text(light.intensity.0)
        ));
        model.push_str(&format!(
            r#"<am3d:pos x="{}" y="{}" z="{}"/></am3d:ptLight>"#,
            text(px.0),
            text(py.0),
            text(pz.0)
        ));
    }
    model.push_str("</am3d:model3d>");
    let id = text(o.id.0);
    let poster = o.poster_r_id;
    let mut out = String::with_capacity(model.len() + 1024);
    out.push_str(&format!(r#"<mc:AlternateContent xmlns:mc="{MC_NS}">"#));
    out.push_str(&format!(
        r#"<mc:Choice xmlns:am3d="{AM3D_NS}" Requires="am3d">"#
    ));
    out.push_str(&format!(
        r#"<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{id}" name="{name}">{creation_id}</p:cNvPr>"#
    ));
    out.push_str(r#"<p:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>"#);
    out.push_str(&format!(
        r#"<p:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx_text}" cy="{cy_text}"/></p:xfrm>"#
    ));
    out.push_str(&format!(
        r#"<a:graphic><a:graphicData uri="{AM3D_NS}">{model}</a:graphicData></a:graphic></p:graphicFrame>"#
    ));
    out.push_str("</mc:Choice><mc:Fallback>");
    out.push_str(&format!(
        r#"<p:pic><p:nvPicPr><p:cNvPr id="{id}" name="{name}">{creation_id}</p:cNvPr>"#
    ));
    out.push_str(
        r#"<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>"#,
    );
    out.push_str(&format!(
        r#"<p:blipFill><a:blip r:embed="{poster}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>"#
    ));
    out.push_str(&format!(
        r#"<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx_text}" cy="{cy_text}"/></a:xfrm>"#
    ));
    out.push_str(r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>"#);
    out.push_str("</mc:Fallback></mc:AlternateContent>");
    out
}

fn choice_frame_re() -> &'static JsRegex {
    js_regex!(r"(<mc:Choice\b[^>]*>\s*<p:graphicFrame\b[\s\S]*?)<p:xfrm\b[^>]*>[\s\S]*?<\/p:xfrm>")
}

fn fallback_xfrm_re() -> &'static JsRegex {
    js_regex!(r"<mc:Fallback\b[^>]*>[\s\S]*?(<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>)")
}

/// Copies the Fallback picture's frame, which the editor moves and resizes,
/// to the Choice: the graphicFrame's p:xfrm, the model's own extent and its
/// viewport.
pub fn sync_model3d_frame(xml: &str) -> String {
    let fallback = fallback_xfrm_re().exec(xml).and_then(|found| found.get(1));
    let choice = choice_frame_re().exec(xml);
    let (Some(fallback), Some(choice)) = (truthy(fallback), choice) else {
        return xml.to_owned();
    };
    let p_xfrm = replace_first(
        js_regex!(r"<\/a:xfrm>$"),
        0,
        &replace_first(js_regex!(r"^<a:xfrm\b"), 0, fallback, "<p:xfrm"),
        "</p:xfrm>",
    );
    let ext = js_regex!(r#"<a:ext cx="(\d+)" cy="(\d+)"\/>"#).exec(fallback);
    // `xml.replace(CHOICE_FRAME, ...)` replaces the match found above
    let mut out = format!(
        "{}{}{p_xfrm}{}",
        xml.get(..choice.start()).unwrap_or_default(),
        choice.get(1).unwrap_or_default(),
        xml.get(choice.end()..).unwrap_or_default(),
    );
    if let Some(ext) = ext {
        let cx = ext.get(1).unwrap_or_default();
        let cy = ext.get(2).unwrap_or_default();
        out = replace_first_with(
            js_regex!(r#"(<am3d:spPr>\s*<a:xfrm\b[^>]*>[\s\S]*?)<a:ext cx="\d+" cy="\d+"\/>"#),
            &out,
            |found| {
                format!(
                    r#"{}<a:ext cx="{cx}" cy="{cy}"/>"#,
                    found.get(1).unwrap_or_default()
                )
            },
        );
        out = replace_first(
            js_regex!(r#"<am3d:objViewport viewportSz="\d+""#),
            0,
            &out,
            &format!(
                r#"<am3d:objViewport viewportSz="{}""#,
                text(math_max(to_number(cx), to_number(cy)))
            ),
        );
    }
    out
}

/// The model's rotation, as am3d:rot holds it (absent axes are 0).
pub fn read_model3d_rotation(xml: &str) -> Model3dRotation {
    let tag = js_regex!(r"<am3d:rot\b[^>]*\/?>")
        .exec(xml)
        .map_or("", |found| found.as_str());
    let axis = |attr: &JsRegex| {
        JsNum(
            attr.exec(tag)
                .and_then(|found| found.get(1))
                .map_or(0.0, to_number),
        )
    };
    Model3dRotation {
        ax: axis(js_regex!(r#"\bax="(-?\d+)""#)),
        ay: axis(js_regex!(r#"\bay="(-?\d+)""#)),
        az: axis(js_regex!(r#"\baz="(-?\d+)""#)),
    }
}

pub fn set_model3d_rotation_xml(xml: &str, rot: &Model3dRotation) -> String {
    let rot_tag = js_regex!(r"<am3d:rot\b[^>]*\/>");
    if rot_tag.test(xml) {
        return replace_first(rot_tag, 0, xml, &rot_xml(rot));
    }
    // am3d:rot sits after scale and before postTrans in CT_Model3DTransform
    replace_first_with(
        js_regex!(r"<am3d:postTrans\b|<\/am3d:trans>"),
        xml,
        |next| format!("{}{}", rot_xml(rot), next.as_str()),
    )
}
