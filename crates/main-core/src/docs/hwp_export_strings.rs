//! `apps/docs/src/main/hwp-export-strings.ts`: the confirmation box of the
//! HWP export. `en` defines the key set. Non-ASCII text is written as escapes.

use jscompat::JsObject;

use crate::packages::i18n::{I18n, create_i18n};

/// `HWP_EXPORT_STRINGS` as `(key, en, ko)`, the keys in the order of the
/// TypeScript's dictionaries (both list them alike).
pub const HWP_EXPORT_STRINGS: &[(&str, &str, &str)] = &[
    (
        "hwpExportTitle",
        "Export as HWP Document",
        "\u{D55C}\u{AE00} \u{BB38}\u{C11C}\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}",
    ),
    (
        "hwpConfirmMessage",
        "Some content changes or is left out in the HWP document.",
        "\u{D55C}\u{AE00} \u{BB38}\u{C11C}\u{C5D0}\u{C11C}\u{B294} \u{C77C}\u{BD80} \u{B0B4}\u{C6A9}\u{C774} \u{BC14}\u{B00C}\u{AC70}\u{B098} \u{BE60}\u{C9D1}\u{B2C8}\u{B2E4}.",
    ),
    (
        "featHiddenText",
        "Hidden text",
        "\u{C228}\u{AE34} \u{AE00}\u{C790}",
    ),
    (
        "featPicture",
        "Pictures that could not be read",
        "\u{C77D}\u{C744} \u{C218} \u{C5C6}\u{B294} \u{ADF8}\u{B9BC}",
    ),
    (
        "featTable",
        "Tables that could not be carried over",
        "\u{C62E}\u{AE30}\u{C9C0} \u{BABB}\u{D55C} \u{D45C}",
    ),
    (
        "featNote",
        "Footnotes and endnotes in tables or headers",
        "\u{D45C}\u{B098} \u{BA38}\u{B9AC}\u{B9D0} \u{C548}\u{C758} \u{AC01}\u{C8FC}\u{B7}\u{BBF8}\u{C8FC}",
    ),
    (
        "featPageBorder",
        "Page borders",
        "\u{CABD} \u{D14C}\u{B450}\u{B9AC}",
    ),
    (
        "featParaBorder",
        "Paragraph borders and shading",
        "\u{BB38}\u{B2E8} \u{D14C}\u{B450}\u{B9AC}\u{B7}\u{BC30}\u{ACBD}",
    ),
    (
        "featLineNumbers",
        "Line numbers",
        "\u{C904} \u{BC88}\u{D638}",
    ),
    (
        "featHyperlink",
        "Hyperlinks (kept as plain text)",
        "\u{D558}\u{C774}\u{D37C}\u{B9C1}\u{D06C}(\u{AE00}\u{B85C}\u{B9CC} \u{B0A8}\u{C74C})",
    ),
    (
        "featSection",
        "Section breaks (one section)",
        "\u{AD6C}\u{C5ED} \u{B098}\u{B214}(\u{D55C} \u{AD6C}\u{C5ED}\u{C73C}\u{B85C})",
    ),
    (
        "featHeaderVariant",
        "First-page and even-page headers and footers",
        "\u{CCAB} \u{CABD}\u{B7}\u{C9DD}\u{C218} \u{CABD} \u{BA38}\u{B9AC}\u{B9D0}\u{B7}\u{AF2C}\u{B9AC}\u{B9D0}",
    ),
    (
        "featHeaderContent",
        "Pictures and tables in headers and footers",
        "\u{BA38}\u{B9AC}\u{B9D0}\u{B7}\u{AF2C}\u{B9AC}\u{B9D0} \u{C548}\u{C758} \u{ADF8}\u{B9BC}\u{B7}\u{D45C}",
    ),
    (
        "featFloatingPicture",
        "Picture position and effects (placed in line)",
        "\u{ADF8}\u{B9BC}\u{C758} \u{C704}\u{CE58}\u{B7}\u{D6A8}\u{ACFC}(\u{AE00}\u{C790}\u{CC98}\u{B7FC} \u{B193}\u{C784})",
    ),
    (
        "featNestedTable",
        "Tables inside tables (as paragraphs)",
        "\u{D45C} \u{C548}\u{C758} \u{D45C}(\u{AE00}\u{B85C} \u{D480}\u{B9BC})",
    ),
    (
        "featTableLayout",
        "Table position and border styles",
        "\u{D45C} \u{BC30}\u{CE58}\u{B7}\u{D14C}\u{B450}\u{B9AC} \u{BAA8}\u{C591}",
    ),
    (
        "featNumbering",
        "Numbering styles",
        "\u{BC88}\u{D638} \u{BAA8}\u{C591}",
    ),
    ("featTabStop", "Tab stops", "\u{D0ED} \u{C124}\u{C815}"),
    (
        "featField",
        "Fields (kept as their result text)",
        "\u{D544}\u{B4DC}(\u{ACB0}\u{ACFC} \u{AE00}\u{B85C} \u{B0A8}\u{C74C})",
    ),
    (
        "featTextEffect",
        "Text effects",
        "\u{AE00}\u{C790} \u{D6A8}\u{ACFC}",
    ),
    (
        "featNoteFormat",
        "Character formatting in footnotes and endnotes",
        "\u{AC01}\u{C8FC}\u{B7}\u{BBF8}\u{C8FC}\u{C758} \u{AE00}\u{C790} \u{BAA8}\u{C591}",
    ),
    (
        "featTextDirection",
        "Vertical text",
        "\u{C138}\u{B85C} \u{C4F0}\u{AE30}",
    ),
    (
        "featPlainParagraph",
        "Paragraphs kept as plain text",
        "\u{C11C}\u{C2DD} \u{C5C6}\u{C774} \u{C62E}\u{AE34} \u{BB38}\u{B2E8}",
    ),
    ("featComment", "Comments", "\u{BA54}\u{BAA8}"),
    (
        "featRevision",
        "Tracked changes",
        "\u{BCC0}\u{ACBD} \u{AE30}\u{B85D}",
    ),
    ("featEquation", "Equations", "\u{C218}\u{C2DD}"),
    ("featChart", "Charts", "\u{CC28}\u{D2B8}"),
    ("featShape", "Shapes", "\u{B3C4}\u{D615}"),
    ("featTextbox", "Text boxes", "\u{AE00}\u{C0C1}\u{C790}"),
    (
        "featObject",
        "Other objects",
        "\u{AE30}\u{D0C0} \u{AC1C}\u{CCB4}",
    ),
    ("featInk", "Ink", "\u{D39C} \u{AE00}\u{C528}"),
    (
        "featWatermark",
        "Watermark",
        "\u{C6CC}\u{D130}\u{B9C8}\u{D06C}",
    ),
    (
        "featProtection",
        "Editing restrictions and read-only recommendation",
        "\u{D3B8}\u{C9D1} \u{C81C}\u{D55C}\u{B7}\u{C77D}\u{AE30} \u{C804}\u{C6A9} \u{AD8C}\u{C7A5}",
    ),
    ("featToc", "Table of contents", "\u{BAA9}\u{CC28}"),
    ("featColumns", "Columns", "\u{B2E4}\u{B2E8}"),
    ("featPassword", "Password", "\u{C554}\u{D638}"),
    (
        "hwpChanges",
        "What changes",
        "\u{BC14}\u{B00C}\u{B294} \u{AC83}",
    ),
    (
        "hwpLeftOut",
        "What is left out",
        "\u{BE60}\u{C9C0}\u{B294} \u{AC83}",
    ),
    ("hwpSave", "Save", "\u{C800}\u{C7A5}"),
    ("hwpCancel", "Cancel", "\u{CDE8}\u{C18C}"),
];

/// `createI18n(HWP_EXPORT_STRINGS)`
pub fn hwp_export_i18n() -> I18n {
    let mut en = JsObject::new();
    let mut ko = JsObject::new();
    for (key, en_text, ko_text) in HWP_EXPORT_STRINGS {
        en.set(*key, (*en_text).to_owned());
        ko.set(*key, (*ko_text).to_owned());
    }
    create_i18n(en, ko)
}
