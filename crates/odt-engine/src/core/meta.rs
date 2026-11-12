//! `core/meta.ts`: the producing application, from meta.xml's
//! `meta:generator`. Hancom writes `hwp/hangul/13, 0, 0, 711/Windows_10`
//! (desktop) or `hwp/hangul/11, 0, 0, 65535/NAME="Red_Hat_Enterprise_Linux_Server"`
//! (the government server converter).

use jscompat::{js_regex, trim};

use super::xml::{
    CloseVerdict, ElementFrame, ElementVisitor, OpenVerdict, decode_xml_entities, read_root, slice,
    walk_elements,
};

/// `OdtProducer`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OdtProducer {
    Hancom,
    Libreoffice,
    Openoffice,
    MsWord,
    GoogleDocs,
    Polaris,
    /// a generator string none of the above
    Other,
    /// no generator recorded
    Unknown,
}

impl OdtProducer {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hancom => "hancom",
            Self::Libreoffice => "libreoffice",
            Self::Openoffice => "openoffice",
            Self::MsWord => "ms-word",
            Self::GoogleDocs => "google-docs",
            Self::Polaris => "polaris",
            Self::Other => "other",
            Self::Unknown => "unknown",
        }
    }
}

/// `OdtGenerator`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OdtGenerator {
    /// `meta:generator` text, decoded and trimmed; `None` when absent
    pub name: Option<String>,
    pub producer: OdtProducer,
}

/// `classifyGenerator`: names the producer of a generator string.
pub fn classify_generator(name: Option<&str>) -> OdtProducer {
    let Some(name) = name.filter(|n| !n.is_empty()) else {
        return OdtProducer::Unknown;
    };
    if js_regex!(r"^hwp\/|hancom|hangul", "i").test(name) {
        return OdtProducer::Hancom;
    }
    if js_regex!("libreoffice", "i").test(name) {
        return OdtProducer::Libreoffice;
    }
    if js_regex!("openoffice|staroffice", "i").test(name) {
        return OdtProducer::Openoffice;
    }
    if js_regex!("microsoft", "i").test(name) {
        return OdtProducer::MsWord;
    }
    if js_regex!("google", "i").test(name) {
        return OdtProducer::GoogleDocs;
    }
    if js_regex!("polaris", "i").test(name) {
        return OdtProducer::Polaris;
    }
    OdtProducer::Other
}

struct Generator<'a> {
    xml: &'a str,
    name: Option<String>,
}

impl ElementVisitor for Generator<'_> {
    type Data = ();

    fn open(
        &mut self,
        _el: &mut ElementFrame<()>,
        _parent: Option<&ElementFrame<()>>,
    ) -> OpenVerdict {
        OpenVerdict::Continue
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<()>,
        _parent: Option<&ElementFrame<()>>,
    ) -> CloseVerdict {
        if el.name != "meta:generator" {
            return CloseVerdict::Continue;
        }
        let inner = slice(self.xml, el.open_end, el.close_start.unwrap_or(el.open_end));
        let stripped = js_regex!("<[^>]*>").replace_all(inner, |_| String::new());
        let decoded = decode_xml_entities(&stripped);
        let trimmed = trim(&decoded);
        self.name = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        };
        CloseVerdict::Stop
    }
}

/// `detectGenerator`: reads `meta:generator` from meta.xml (missing part or
/// element: `unknown`).
pub fn detect_generator(meta_xml: Option<&str>) -> OdtGenerator {
    let root = meta_xml.filter(|x| !x.is_empty()).and_then(read_root);
    let (Some(xml), Some(root)) = (meta_xml.filter(|x| !x.is_empty()), root) else {
        return OdtGenerator {
            name: None,
            producer: OdtProducer::Unknown,
        };
    };
    let mut visitor = Generator { xml, name: None };
    walk_elements(xml, &root.prefixes, &mut visitor, 0, xml.len());
    OdtGenerator {
        producer: classify_generator(visitor.name.as_deref()),
        name: visitor.name,
    }
}
