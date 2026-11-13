//! Core layer of the ODT bridge, ported from `packages/odt-engine/src/core`:
//! lenient package reading, the position map over content.xml's original
//! string, the style table, and the conversion skeleton the later layers
//! (text, tables, objects, pages, assembly) build on. `convert.rs` documents
//! the layout of the registry and the contexts; `body.rs` the offsets.

pub mod body;
pub mod convert;
pub mod docx_package;
pub mod errors;
pub mod flow;
pub mod manifest;
pub mod meta;
pub mod open;
pub mod package;
pub mod styles;
pub mod xml;

pub use body::{
    AnnotationPair, BookmarkPair, CellSpan, NodeSource, ODT_NODE_KINDS, OdtBody, OdtNode,
    OdtNodeKind, anchor_type, bookmark_name, cell_span, nodes_of_kind, odt_node_kind,
    pair_annotations, pair_bookmarks, scan_odt_body, slice_node, slice_range, walk_nodes,
};
pub use convert::*;
pub use docx_package::{
    BRIDGE_DOCUMENT_NAMESPACES, bridge_document_xml, build_bridge_docx, default_sect_pr,
    read_docx_part,
};
pub use errors::{OdtError, OdtOpenErrorCode, OdtResult, is_odt_open_error};
pub use flow::{
    CONTAINER_OWNER, align_items, block_elements, block_source, convert_container, convert_flow,
    convert_node, convert_odt_body, edited_items, edited_items_of_blocks, flow_children,
    paragraph_block_of, rebuild_container, rebuild_flow, rebuild_odt_body,
};
pub use manifest::{OdtManifest, OdtManifestEntry, read_manifest};
pub use meta::{OdtGenerator, OdtProducer, classify_generator, detect_generator};
pub use open::{OdtDocument, OpenOdtOptions, open_odt};
pub use package::{
    ODT_TEXT_MEDIA_TYPE, ODT_ZIP_LIMITS, OdtEntry, OdtPackage, ReadOdtPackageOptions,
    read_odt_package,
};
pub use styles::{
    OdtListLevel, OdtListLevelKind, OdtMasterPage, OdtMasterPageRegion, OdtMasterPageRegionName,
    OdtPropertyBag, OdtResolvedStyle, OdtStyle, OdtStyleContainers, OdtStyleKind, OdtStylePart,
    OdtStyleScope, OdtStyleTable, PerPart, read_odt_styles,
};
pub use xml::{
    CloseVerdict, ElementFrame, ElementRange, ElementVisitor, ODF_NAMESPACES, OpenVerdict,
    PrefixMap, XmlAttribute, XmlRoot, XmlScanner, XmlTokenKind, attribute_map, decode_xml_entities,
    escape_xml_attr, escape_xml_text, read_attributes, read_root, slice, walk_elements, walk_open,
};

/// The host's clock for the code that reads it: `Date.now()` and
/// `new Date().getTimezoneOffset()` at the moment of the public call. The
/// engine itself reads no clock (`assemble/zip.rs` and the meta writer take a
/// `HostNow`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HostNow {
    /// `Date.now()`, milliseconds since 1970 UTC
    pub ms: f64,
    /// `getTimezoneOffset()`: minutes from local time to UTC (UTC minus
    /// local, so UTC+9 is -540)
    pub offset_minutes: f64,
}
