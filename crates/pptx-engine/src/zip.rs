//! Port of packages/pptx-engine/src/zip.ts: opening the zip, the SHA-256 of
//! the original, and reading parts and their relationships.

use std::borrow::Cow;

use jscompat::{
    JsMap, JsNum, Radix, decode_uri_component, js_regex, parse_int, value_to_string, value_truthy,
};
use ooxml_pkg::{DeclaredPart, ZipLimits, decode_text, load_package};
use ooxml_xml::{ObjectOptions, parse_object};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::xml_utils::{as_xml_node, xml_array};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Relationship {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub target: String,
    #[serde(rename = "targetMode", skip_serializing_if = "Option::is_none")]
    pub target_mode: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SlideSize {
    pub cx: JsNum,
    pub cy: JsNum,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Presentation {
    pub size: SlideSize,
    #[serde(rename = "slidePaths")]
    pub slide_paths: Vec<String>,
}

/// A key is absent where the TypeScript leaves it `undefined`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SlideChain {
    #[serde(rename = "layoutPath", skip_serializing_if = "Option::is_none")]
    pub layout_path: Option<String>,
    #[serde(rename = "masterPath", skip_serializing_if = "Option::is_none")]
    pub master_path: Option<String>,
    #[serde(rename = "themePath", skip_serializing_if = "Option::is_none")]
    pub theme_path: Option<String>,
}

pub const PPTX_ZIP_LIMITS: ZipLimits = ZipLimits {
    max_parts: 10_000,
    max_part_bytes: 512.0 * 1024.0 * 1024.0,
    max_total_bytes: 1.5 * 1024.0 * 1024.0 * 1024.0,
};

/// `assertZipWithinLimits`: the declared sizes of the non-folder files of the
/// loaded zip, in `Object.values(zip.files)` order.
pub fn assert_zip_within_limits(files: &[DeclaredPart<'_>]) -> Result<(), String> {
    let limits = &PPTX_ZIP_LIMITS;
    if files.len() > limits.max_parts {
        return Err(format!(
            "pptx rejected: {} parts exceeds the {} limit",
            files.len(),
            limits.max_parts
        ));
    }
    let mut total = 0.0;
    for file in files {
        if file.usize > limits.max_part_bytes {
            return Err(format!(
                "pptx rejected: part {} declares {} uncompressed bytes (limit {})",
                file.name,
                jscompat::number_to_string(file.usize),
                jscompat::number_to_string(limits.max_part_bytes)
            ));
        }
        if file.usize > 0.0 {
            total += file.usize;
        }
    }
    if total > limits.max_total_bytes {
        return Err(format!(
            "pptx rejected: total uncompressed size {} exceeds the {} limit",
            jscompat::number_to_string(total),
            jscompat::number_to_string(limits.max_total_bytes)
        ));
    }
    Ok(())
}

/// `a ?? b`
fn or_else<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    first.filter(|value| !value.is_null()).or(second)
}

fn parse(xml: &str, array_names: &[&str]) -> Result<Value, String> {
    let options = ObjectOptions {
        array_names,
        ..ObjectOptions::default()
    };
    parse_object(xml, &options).map_err(|error| error.to_string())
}

const PRESENTATION: &str = "ppt/presentation.xml";

pub struct PackageArchive {
    entries: JsMap<Vec<u8>>,
    original_hash: String,
}

impl PackageArchive {
    /// The private constructor: the entries in the order given.
    pub fn from_parts(
        entries: impl IntoIterator<Item = (String, Vec<u8>)>,
        original_hash: String,
    ) -> Self {
        Self {
            entries: entries.into_iter().collect(),
            original_hash,
        }
    }

    pub fn open(bytes: &[u8]) -> Result<Self, String> {
        let original_hash = format!("{:x}", Sha256::digest(bytes));
        let package = load_package(bytes, &PPTX_ZIP_LIMITS, assert_zip_within_limits)?;
        let mut entries = JsMap::new();
        for part in package.into_parts() {
            if part.is_dir {
                continue;
            }
            let (name, content) = part.into_content().map_err(|error| error.reason)?;
            entries.set(name, content);
        }
        Ok(Self {
            entries,
            original_hash,
        })
    }

    pub fn entries(&self) -> &JsMap<Vec<u8>> {
        &self.entries
    }

    /// `archive.entries`, for the functions that replace a part.
    pub fn entries_mut(&mut self) -> &mut JsMap<Vec<u8>> {
        &mut self.entries
    }

    pub fn original_hash(&self) -> &str {
        &self.original_hash
    }

    pub fn into_parts(self) -> (String, JsMap<Vec<u8>>) {
        (self.original_hash, self.entries)
    }

    pub fn has(&self, path: &str) -> bool {
        self.entries.has(path)
    }

    /// `readText`: `None` is `null`.
    pub fn read_text(&self, path: &str) -> Option<Cow<'_, str>> {
        self.entries.get(path).map(|bytes| decode_text(bytes))
    }

    pub fn read_bytes(&self, path: &str) -> Option<&[u8]> {
        self.entries.get(path).map(Vec::as_slice)
    }

    pub fn read_rels(&self, part_path: &str) -> Result<JsMap<Relationship>, String> {
        let mut rels = JsMap::new();
        let Some(xml) = self
            .read_text(&rels_path_for(part_path))
            .filter(|xml| !xml.is_empty())
        else {
            return Ok(rels);
        };
        let doc = parse(&xml, &["Relationship", "sldId", "Override"])?;
        let list = as_xml_node(as_xml_node(Some(&doc)).get("Relationships")).get("Relationship");
        for r in xml_array(list) {
            let text = |key: &str| {
                or_else(r.get(key), None)
                    .map_or_else(String::new, |value| value_to_string(Some(value)))
            };
            let id = text("@_Id");
            let target_mode = r
                .get("@_TargetMode")
                .filter(|mode| !mode.is_null())
                .map(|mode| value_to_string(Some(mode)));
            rels.set(
                id.clone(),
                Relationship {
                    id,
                    r#type: text("@_Type"),
                    target: text("@_Target"),
                    target_mode,
                },
            );
        }
        Ok(rels)
    }

    pub fn read_presentation(&self) -> Result<Presentation, String> {
        let pres_xml = self
            .read_text(PRESENTATION)
            .filter(|xml| !xml.is_empty())
            .ok_or("pptx: missing ppt/presentation.xml")?;
        let pres = parse(&pres_xml, &["p:sldId"])?;
        let pres = as_xml_node(Some(&pres));
        let root_raw = or_else(pres.get("p:presentation"), pres.get("presentation"));
        if !value_truthy(root_raw) {
            return Err("pptx: malformed presentation.xml".to_owned());
        }
        let root = as_xml_node(root_raw);

        let sz_raw = or_else(root.get("p:sldSz"), root.get("sldSz"));
        let sz = value_truthy(sz_raw).then(|| as_xml_node(sz_raw));
        let emu_or = |raw: Option<&Value>, fallback: f64| {
            let parsed = parse_int(&value_to_string(raw), Radix::Ten);
            if parsed.is_finite() && parsed > 0.0 {
                parsed
            } else {
                fallback
            }
        };
        let size = SlideSize {
            cx: JsNum(sz.map_or(9_144_000.0, |sz| emu_or(sz.get("@_cx"), 9_144_000.0))),
            cy: JsNum(sz.map_or(6_858_000.0, |sz| emu_or(sz.get("@_cy"), 6_858_000.0))),
        };

        let rels = self.read_rels(PRESENTATION)?;
        let sld_id_lst = as_xml_node(or_else(root.get("p:sldIdLst"), root.get("sldIdLst")));
        let mut slide_paths = Vec::new();
        for id in xml_array(or_else(sld_id_lst.get("p:sldId"), sld_id_lst.get("sldId"))) {
            let r_id = or_else(id.get("@_r:id"), id.get("@_id"));
            if !value_truthy(r_id) {
                continue;
            }
            let Some(rel) = rels.get(&value_to_string(r_id)) else {
                continue;
            };
            slide_paths.push(resolve_target(PRESENTATION, &rel.target));
        }
        Ok(Presentation { size, slide_paths })
    }

    /// The first relationship of `part` whose type ends in `suffix`, resolved.
    fn first_target(&self, part: &str, suffix: &str) -> Result<Option<String>, String> {
        Ok(self
            .read_rels(part)?
            .values()
            .find(|rel| rel.r#type.ends_with(suffix))
            .map(|rel| resolve_target(part, &rel.target)))
    }

    pub fn resolve_slide_chain(&self, slide_path: &str) -> Result<SlideChain, String> {
        let mut layout_path = self.first_target(slide_path, "/slideLayout")?;
        if layout_path.as_deref().is_none_or(str::is_empty) {
            layout_path = self.fallback_layout_path(slide_path)?;
        }
        let mut master_path = None;
        let mut theme_path = None;
        if let Some(layout) = layout_path.as_deref().filter(|path| !path.is_empty()) {
            master_path = self.first_target(layout, "/slideMaster")?;
        }
        if let Some(master) = master_path.as_deref().filter(|path| !path.is_empty()) {
            theme_path = self.first_target(master, "/theme")?;
        }
        Ok(SlideChain {
            layout_path,
            master_path,
            theme_path,
        })
    }

    /// The layout for a slide that lost its slideLayout relationship.
    fn fallback_layout_path(&self, slide_path: &str) -> Result<Option<String>, String> {
        let Some(pres_xml) = self.read_text(PRESENTATION).filter(|xml| !xml.is_empty()) else {
            return Ok(None);
        };
        let pres_rels = self.read_rels(PRESENTATION)?;
        let master_rid = js_regex!(r#"<p:sldMasterId\b[^>]*\br:id="([^"]+)""#)
            .exec(&pres_xml)
            .and_then(|found| found.get(1));
        let master_rel = match master_rid {
            Some(rid) => pres_rels.get(rid),
            None => pres_rels
                .values()
                .find(|rel| rel.r#type.ends_with("/slideMaster")),
        };
        let Some(master_rel) = master_rel else {
            return Ok(None);
        };
        let master_path = resolve_target(PRESENTATION, &master_rel.target);
        let Some(master_xml) = self.read_text(&master_path).filter(|xml| !xml.is_empty()) else {
            return Ok(None);
        };
        let master_rels = self.read_rels(&master_path)?;
        let mut layouts: Vec<String> = js_regex!(r#"<p:sldLayoutId\b[^>]*\br:id="([^"]+)""#, "g")
            .find_iter(&master_xml)
            .filter_map(|found| master_rels.get(found.get(1)?))
            .map(|rel| resolve_target(&master_path, &rel.target))
            .collect();
        if layouts.is_empty() {
            layouts = master_rels
                .values()
                .filter(|rel| rel.r#type.ends_with("/slideLayout"))
                .map(|rel| resolve_target(&master_path, &rel.target))
                .collect();
        }
        if layouts.is_empty() {
            return Ok(None);
        }
        let text_of = |path: &str| self.read_text(path).unwrap_or_default();
        if js_regex!(r#"<p:ph\b[^>]*\btype="ctrTitle""#).test(&text_of(slide_path))
            && let Some(title) = layouts
                .iter()
                .find(|path| js_regex!(r#"<p:sldLayout\b[^>]*\btype="title""#).test(&text_of(path)))
        {
            return Ok(Some(title.clone()));
        }
        Ok(layouts.into_iter().next())
    }
}

/// 'ppt/slides/slide1.xml' → 'ppt/slides/_rels/slide1.xml.rels'
pub fn rels_path_for(part_path: &str) -> String {
    let (dir, file) = part_path.rsplit_once('/').unwrap_or(("", part_path));
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    format!("{prefix}_rels/{file}.rels")
}

/// A relative target resolved against the folder of `base_part`; `""` for an
/// external or undecodable one.
pub fn resolve_target(base_part: &str, target: &str) -> String {
    if js_regex!(r"^[A-Za-z][A-Za-z0-9+.-]*:").test(target) {
        return String::new();
    }
    let Ok(decoded) = decode_uri_component(target) else {
        return String::new();
    };
    let normalized = decoded.replace('\\', "/");
    let mut parts: Vec<&str> = if normalized.starts_with('/') {
        Vec::new()
    } else {
        base_part
            .rsplit_once('/')
            .map_or("", |(dir, _)| dir)
            .split('/')
            .filter(|seg| !seg.is_empty())
            .collect()
    };
    for seg in normalized.split('/') {
        match seg {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            seg => parts.push(seg),
        }
    }
    parts.join("/")
}
