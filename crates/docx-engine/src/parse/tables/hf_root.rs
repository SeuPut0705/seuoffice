//! hf-root.ts: the root element a rewritten header/footer part ends up under.
//! It follows from the part's own bytes, so the reader and the writer agree
//! on it: a wrapper carried on the part's runs may use only the prefixes that
//! root declares.

use std::sync::LazyLock;

use jscompat::{RegexLimit, js_regex};

use crate::generate::split_xml_children;
use crate::inline_opaque::{PartNamespaces, part_namespaces};
use crate::watermark::is_watermark_child;
use crate::xml_tag::{TagName, find_start_tag};

/// `HfRootName`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HfRootName {
    Hdr,
    Ftr,
}

impl HfRootName {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hdr => "w:hdr",
            Self::Ftr => "w:ftr",
        }
    }
}

/// `WATERMARK_NS`: namespaces the header part root needs when it carries a VML
/// watermark.
pub const WATERMARK_NS: &str = concat!(
    r#" xmlns:v="urn:schemas-microsoft-com:vml""#,
    r#" xmlns:o="urn:schemas-microsoft-com:office:office""#,
    r#" xmlns:w10="urn:schemas-microsoft-com:office:word""#
);

/// `HF_ROOT_ATTRS`: what the root of a header/footer part written anew declares.
pub fn hf_root_attrs() -> String {
    format!(
        concat!(
            r#" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#,
            r#" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#,
            "{}"
        ),
        WATERMARK_NS
    )
}

/// `HF_ROOT_NAMESPACES`
static HF_ROOT_NAMESPACES: LazyLock<PartNamespaces> = LazyLock::new(|| {
    part_namespaces(&format!("<w:hdr{}>", hf_root_attrs())).unwrap_or_else(|_| {
        unreachable!("a root tag of a few hundred characters is within the bound")
    })
});

/// What `hfKeptRoot` returns: the original part split at its root.
#[derive(Debug)]
pub struct HfKeptRoot {
    pub before: String,
    pub open: String,
    /// `(name, xml)` of each top-level child
    pub children: Vec<(String, String)>,
}

/// `isModelledPictures`: a text paragraph whose pictures are all inline blips
/// is fully modelled (the parser keeps them on its runs), so it is
/// regenerated like any text.
fn is_modelled_pictures(xml: &str) -> bool {
    js_regex!(r"<w:t[\s>]").test(xml)
        && !js_regex!(r"<w:pict[\s>]|<w:object[\s>]|<wp:anchor[\s>]").test(xml)
        && js_regex!(r"<w:drawing[\s>][\s\S]*?<\/w:drawing>", "g")
            .find_iter(xml)
            .all(|drawing| {
                drawing.as_str().contains("<wp:inline") && drawing.as_str().contains("<a:blip")
            })
}

/// `isProtectedPara`
fn is_protected_para(xml: &str) -> bool {
    js_regex!(r"<w:drawing[\s>]|<w:pict[\s>]|<w:object[\s>]").test(xml)
        && !is_modelled_pictures(xml)
}

/// `isTextPara` of the value `hfKeptRoot` returns.
pub fn is_text_para(name: &str, xml: &str) -> bool {
    name == "w:p" && !is_watermark_child(name, xml) && !is_protected_para(xml)
}

/// `hfKeptRoot`: the original part split at its root, when the rewritten part
/// keeps that root: it holds something besides text paragraphs (a table, a
/// block control, a paragraph with a drawing the text model does not carry),
/// which stays as its original bytes. `None` when the part is written anew,
/// root and all.
pub fn hf_kept_root(
    root: HfRootName,
    original_xml: &str,
) -> Result<Option<HfKeptRoot>, RegexLimit> {
    let root = root.as_str();
    let Some(root_tag) = find_start_tag(original_xml, TagName::Exact(root), 0) else {
        return Ok(None);
    };
    let Some(close_idx) = original_xml.rfind(&format!("</{root}>")) else {
        return Ok(None);
    };
    let (open, open_idx) = (root_tag.text, root_tag.start);
    let inner_start = open_idx + open.len();
    let inner = original_xml.get(inner_start..close_idx).unwrap_or("");
    let children = split_xml_children(inner)?;
    if children.iter().all(|(name, xml)| is_text_para(name, xml)) {
        return Ok(None);
    }
    Ok(Some(HfKeptRoot {
        before: original_xml[..open_idx].to_owned(),
        open: open.to_owned(),
        children,
    }))
}

/// `hfWrapNamespaces`: the prefixes a wrapper on the part's runs may use:
/// those of the original root when the rewritten part keeps it (`kept`), else
/// those of a root written anew, each only while it means what it meant in the
/// part the runs were read from.
pub fn hf_wrap_namespaces(
    original_xml: Option<&str>,
    kept: bool,
) -> Result<PartNamespaces, RegexLimit> {
    let Some(original_xml) = original_xml.filter(|xml| !xml.is_empty()) else {
        return Ok(clone_namespaces(&HF_ROOT_NAMESPACES));
    };
    let original = part_namespaces(original_xml)?;
    if kept {
        return Ok(original);
    }
    Ok(HF_ROOT_NAMESPACES
        .iter()
        .filter(|(prefix, uri)| {
            original.get(prefix).map_or(uri.as_str(), String::as_str) == uri.as_str()
        })
        .map(|(prefix, uri)| (prefix.to_owned(), uri.clone()))
        .collect())
}

fn clone_namespaces(namespaces: &PartNamespaces) -> PartNamespaces {
    namespaces
        .iter()
        .map(|(prefix, uri)| (prefix.to_owned(), uri.clone()))
        .collect()
}
