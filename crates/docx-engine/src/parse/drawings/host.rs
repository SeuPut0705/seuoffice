//! What the engine asks of its host: the conversions it does not do itself,
//! and the state `parse.ts` keeps per zip (`WeakMap<JSZip, ...>`) about the
//! media it has read.

use std::cell::{OnceCell, RefCell};
use std::collections::HashMap;

use crate::package::{ContentTypes, Thrown};

/// The conversions the TypeScript engine gets from its environment. A host
/// that has none answers as the TypeScript does when its converter fails.
pub trait MediaHost {
    /// `metafileToDataUrl(bytes, mime)` for an EMF, WMF, EMZ or WMZ part: the
    /// image as a data URL, `None` for the `null` of a failed or empty
    /// conversion.
    fn metafile_to_data_url(&self, bytes: &[u8], mime: &str) -> Option<String>;

    /// `tiffToDataUrlAsync(bytes)`: the picture re-encoded as a PNG data URL,
    /// `None` for `null`.
    fn tiff_to_data_url(&self, bytes: &[u8]) -> Option<String>;

    /// `hasAltChunkHtmlConverter()`
    fn has_alt_chunk_html_converter(&self) -> bool;

    /// The installed HTML converter of alt-chunk.ts, `htmlConverter(html)`:
    /// the docx bytes of the HTML, `None` for `null`.
    fn alt_chunk_html_to_docx(&self, html: &str) -> Option<Vec<u8>>;
}

/// A host with no converter: every conversion answers `None`.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoHost;

impl MediaHost for NoHost {
    fn metafile_to_data_url(&self, _bytes: &[u8], _mime: &str) -> Option<String> {
        None
    }

    fn tiff_to_data_url(&self, _bytes: &[u8]) -> Option<String> {
        None
    }

    fn has_alt_chunk_html_converter(&self) -> bool {
        false
    }

    fn alt_chunk_html_to_docx(&self, _html: &str) -> Option<Vec<u8>> {
        None
    }
}

/// The host and the per-zip state of the media readers: one per `parseDocx`,
/// shared by every context that reads the same package.
pub struct MediaEnv<'a> {
    pub host: &'a dyn MediaHost,
    /// `contentTypesCache.get(zip)`: [Content_Types].xml read once, a failure
    /// included.
    content_types: OnceCell<Result<ContentTypes, Thrown>>,
    /// `mediaDataUrlCache.get(zip)`: the data URL of each media part, by part
    /// path.
    data_urls: RefCell<HashMap<String, Option<String>>>,
    /// `lazyHashesByZip.get(zip)`: a Set, in insertion order.
    lazy_hashes: RefCell<Vec<String>>,
}

impl<'a> MediaEnv<'a> {
    pub fn new(host: &'a dyn MediaHost) -> Self {
        Self {
            host,
            content_types: OnceCell::new(),
            data_urls: RefCell::new(HashMap::new()),
            lazy_hashes: RefCell::new(Vec::new()),
        }
    }

    /// `contentTypesOf(zip)`
    pub fn content_types(
        &self,
        read: impl FnOnce() -> Result<ContentTypes, Thrown>,
    ) -> Result<&ContentTypes, Thrown> {
        self.content_types
            .get_or_init(read)
            .as_ref()
            .map_err(Clone::clone)
    }

    /// `mediaDataUrlCache.get(zip)?.get(partPath)`
    pub fn cached_data_url(&self, part_path: &str) -> Option<Option<String>> {
        self.data_urls.borrow().get(part_path).cloned()
    }

    /// `cache.set(partPath, pending)`
    pub fn cache_data_url(&self, part_path: &str, data_url: Option<String>) {
        self.data_urls
            .borrow_mut()
            .insert(part_path.to_owned(), data_url);
    }

    /// `lazyHashesByZip.get(zip).add(hash)`
    pub fn add_lazy_hash(&self, hash: &str) {
        let mut seen = self.lazy_hashes.borrow_mut();
        if !seen.iter().any(|known| known == hash) {
            seen.push(hash.to_owned());
        }
    }

    /// `[...lazyHashesByZip.get(zip) ?? []]`: the `lazyMediaHashes` of the
    /// parse extras.
    pub fn lazy_hashes(&self) -> Vec<String> {
        self.lazy_hashes.borrow().clone()
    }
}
