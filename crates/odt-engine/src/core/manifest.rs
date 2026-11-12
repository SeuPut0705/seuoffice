//! `core/manifest.ts`: META-INF/manifest.xml: the listed parts and, above all,
//! whether any part is encrypted. A password-protected ODT marks its
//! encrypted parts with `manifest:encryption-data`; such a document is never
//! opened.
//!
//! `start` and `end` of an entry are byte offsets into the manifest text.

use super::xml::{
    CloseVerdict, ElementFrame, ElementVisitor, OpenVerdict, attribute_map, read_root,
    walk_elements,
};

/// `OdtManifestEntry`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OdtManifestEntry {
    pub full_path: String,
    pub media_type: Option<String>,
    pub version: Option<String>,
    /// the entry carries `manifest:encryption-data`
    pub encrypted: bool,
    /// source range of the `manifest:file-entry` element (bytes)
    pub start: usize,
    pub end: usize,
}

/// `OdtManifest`
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OdtManifest {
    pub entries: Vec<OdtManifestEntry>,
    /// media type of the `/` entry (the package itself)
    pub root_media_type: Option<String>,
    /// any entry is encrypted
    pub encrypted: bool,
}

struct Reader<'a> {
    xml: &'a str,
    prefixes: &'a super::xml::PrefixMap,
    entries: Vec<OdtManifestEntry>,
    /// index of the entry being read
    current: Option<usize>,
}

impl ElementVisitor for Reader<'_> {
    /// the index of the entry in `entries`
    type Data = usize;

    fn open(
        &mut self,
        el: &mut ElementFrame<usize>,
        _parent: Option<&ElementFrame<usize>>,
    ) -> OpenVerdict {
        if el.name == "manifest:file-entry" {
            let a = attribute_map(self.xml, el.name_end, el.open_end, self.prefixes);
            let entry = OdtManifestEntry {
                full_path: a.get("manifest:full-path").cloned().unwrap_or_default(),
                media_type: a.get("manifest:media-type").cloned(),
                version: a.get("manifest:version").cloned(),
                encrypted: false,
                start: el.start,
                end: el.open_end,
            };
            self.entries.push(entry);
            let index = self.entries.len() - 1;
            el.data = Some(index);
            self.current = Some(index);
        } else if el.name == "manifest:encryption-data" {
            if let Some(current) = self.current {
                self.entries[current].encrypted = true;
            }
        }
        OpenVerdict::Continue
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<usize>,
        _parent: Option<&ElementFrame<usize>>,
    ) -> CloseVerdict {
        let Some(index) = el.data else {
            return CloseVerdict::Continue;
        };
        self.entries[index].end = el.end.unwrap_or(self.entries[index].end);
        if self.current == Some(index) {
            self.current = None;
        }
        CloseVerdict::Continue
    }
}

/// `readManifest`: reads the manifest leniently; a missing or unreadable
/// manifest yields no entries.
pub fn read_manifest(xml: Option<&str>) -> OdtManifest {
    let root = xml.filter(|x| !x.is_empty()).and_then(read_root);
    let (Some(xml), Some(root)) = (xml.filter(|x| !x.is_empty()), root) else {
        return OdtManifest::default();
    };
    let mut reader = Reader {
        xml,
        prefixes: &root.prefixes,
        entries: Vec::new(),
        current: None,
    };
    walk_elements(xml, &root.prefixes, &mut reader, 0, xml.len());
    let entries = reader.entries;
    OdtManifest {
        root_media_type: entries
            .iter()
            .find(|e| e.full_path == "/")
            .and_then(|e| e.media_type.clone()),
        encrypted: entries.iter().any(|e| e.encrypted),
        entries,
    }
}
