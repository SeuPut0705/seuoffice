//! The `word/settings.xml` writers of patch.ts: a child inserted at its
//! CT_Settings position, the on/off flags, protection and personal information.

use jscompat::{TryJsRegex, js_regex, try_js_regex};

use super::markup::namespace_prefixes;
use super::{replace_first, thrown};
use crate::generate::escape_xml_attr;
use crate::model::{DocProtection, WriteProtection};
use crate::xml_tag::{TagName, find_start_tag, remove_elements};

/// `SETTINGS_CHILD_ORDER`: the CT_Settings child sequence (ECMA-376 17.15.1.78), in schema order.
const SETTINGS_CHILD_ORDER: [&str; 99] = [
    "writeProtection",
    "view",
    "zoom",
    "removePersonalInformation",
    "removeDateAndTime",
    "doNotDisplayPageBoundaries",
    "displayBackgroundShape",
    "printPostScriptOverText",
    "printFractionalCharacterWidth",
    "printFormsData",
    "embedTrueTypeFonts",
    "embedSystemFonts",
    "saveSubsetFonts",
    "saveFormsData",
    "mirrorMargins",
    "alignBordersAndEdges",
    "bordersDoNotSurroundHeader",
    "bordersDoNotSurroundFooter",
    "gutterAtTop",
    "hideSpellingErrors",
    "hideGrammaticalErrors",
    "activeWritingStyle",
    "proofState",
    "formsDesign",
    "attachedTemplate",
    "linkStyles",
    "stylePaneFormatFilter",
    "stylePaneSortMethod",
    "documentType",
    "mailMerge",
    "revisionView",
    "trackRevisions",
    "doNotTrackMoves",
    "doNotTrackFormatting",
    "documentProtection",
    "autoFormatOverride",
    "styleLockTheme",
    "styleLockQFSet",
    "defaultTabStop",
    "autoHyphenation",
    "consecutiveHyphenLimit",
    "hyphenationZone",
    "doNotHyphenateCaps",
    "showEnvelope",
    "summaryLength",
    "clickAndTypeStyle",
    "defaultTableStyle",
    "evenAndOddHeaders",
    "bookFoldRevPrinting",
    "bookFoldPrinting",
    "bookFoldPrintingSheets",
    "drawingGridHorizontalSpacing",
    "drawingGridVerticalSpacing",
    "displayHorizontalDrawingGridEvery",
    "displayVerticalDrawingGridEvery",
    "doNotUseMarginsForDrawingGridOrigin",
    "drawingGridHorizontalOrigin",
    "drawingGridVerticalOrigin",
    "doNotShadeFormData",
    "noPunctuationKerning",
    "characterSpacingControl",
    "printTwoOnOne",
    "strictFirstAndLastChars",
    "noLineBreaksAfter",
    "noLineBreaksBefore",
    "savePreviewPicture",
    "doNotValidateAgainstSchema",
    "saveInvalidXml",
    "ignoreMixedContent",
    "alwaysShowPlaceholderText",
    "doNotDemarcateInvalidXml",
    "saveXmlDataOnly",
    "useXSLTWhenSaving",
    "saveThroughXslt",
    "showXMLTags",
    "alwaysMergeEmptyNamespace",
    "updateFields",
    "hdrShapeDefaults",
    "footnotePr",
    "endnotePr",
    "compat",
    "docVars",
    "rsids",
    "mathPr",
    "uiCompat97To2003",
    "attachedSchema",
    "themeFontLang",
    "clrSchemeMapping",
    "doNotIncludeSubdocsInStats",
    "doNotAutoCompressPictures",
    "forceUpgrade",
    "captions",
    "readModeInkLockDown",
    "smartTagType",
    "schemaLibrary",
    "shapeDefaults",
    "doNotEmbedSmartTags",
    "decimalSymbol",
    "listSeparator",
];

/// `settingsChildRank`: rank of a CT_Settings child; -1 for a child the list does not model.
pub fn settings_child_rank(local_name: &str) -> i32 {
    SETTINGS_CHILD_ORDER
        .iter()
        .position(|name| *name == local_name)
        .map_or(-1, |at| at as i32)
}

/// `insertSettingsChild`: `child_xml` as a child of the w:settings root at its
/// CT_Settings position, every other child byte-identical.
pub fn insert_settings_child(
    xml: &str,
    local_name: &str,
    child_xml: &str,
) -> Result<String, String> {
    let rank = settings_child_rank(local_name);
    // an element start tag anywhere in the part, capturing the local name
    for found in js_regex!(r"<(?:[A-Za-z0-9._-]+:)?([A-Za-z0-9._-]+)[\s/>]", "g").find_iter(xml) {
        // Anchor on a child whose position the list knows: an unmodeled element
        // (the w:settings root itself included) could sit anywhere in the sequence.
        if settings_child_rank(found.get(1).unwrap_or_default()) > rank {
            let at = found.start();
            return Ok(format!("{}{child_xml}{}", &xml[..at], &xml[at..]));
        }
    }
    // nothing modeled to order against: land last, or after the root open tag
    if let Some(close) = js_regex!(r"<\/(?:[A-Za-z0-9._-]+:)?settings>").exec(xml) {
        let at = close.start();
        return Ok(format!("{}{child_xml}{}", &xml[..at], &xml[at..]));
    }
    let root_name = js_regex!(r"^(?:[A-Za-z0-9._-]+:)?settings$");
    let Some(root) = find_start_tag(xml, TagName::Matching(root_name), 0) else {
        return Ok(xml.to_owned());
    };
    if !root.self_closing {
        return Ok(format!(
            "{}{child_xml}{}",
            &xml[..root.end],
            &xml[root.end..]
        ));
    }
    let name = js_regex!(r"^<([^\s/>]+)")
        .exec(root.text)
        .and_then(|found| found.get(1))
        .unwrap_or_default();
    let open = js_regex!(r"\s*\/>$").replace_all(root.text, |_| ">".to_owned());
    // `replace` without the `g` flag changes the one match; the pattern is anchored at the end
    Ok(format!(
        "{}{open}{child_xml}</{name}>{}",
        &xml[..root.start],
        &xml[root.end..]
    ))
}

/// `applySettingsFlag`: set or remove an on/off settings flag at its CT_Settings position.
pub fn apply_settings_flag(xml: &str, tag: &str, on: bool) -> Result<String, String> {
    // the start tag and an optional paired end tag
    let pattern =
        TryJsRegex::new(&format!(r"<{tag}(?=[\s/>])[^>]*>(?:<\/{tag}>)?"), "").map_err(thrown)?;
    let out = replace_first(&pattern, xml, "").map_err(thrown)?;
    if !on {
        return Ok(out);
    }
    let local = tag.split_once(':').map_or(tag, |(_, local)| local);
    insert_settings_child(&out, local, &format!("<{tag}/>"))
}

/// `applyEvenAndOddHeaders`: set or remove `<w:evenAndOddHeaders/>` at its CT_Settings position.
pub fn apply_even_and_odd_headers(xml: &str, on: bool) -> Result<String, String> {
    let pattern =
        try_js_regex!(r"<w:evenAndOddHeaders(?=[\s/>])[^>]*>(?:<\/w:evenAndOddHeaders>)?");
    let out = replace_first(pattern, xml, "").map_err(thrown)?;
    if on {
        insert_settings_child(&out, "evenAndOddHeaders", "<w:evenAndOddHeaders/>")
    } else {
        Ok(out)
    }
}

/// `applyProtection`: set or remove `<w:documentProtection>` at its CT_Settings position.
pub fn apply_protection(xml: &str, protection: Option<&DocProtection>) -> Result<String, String> {
    // either spelling of the empty-content element, paired or self-closing
    let pattern = try_js_regex!(
        r"<w:documentProtection(?=[\s/>])[^>]*?(?:\/\s*>|>\s*<\/w:documentProtection\s*>)"
    );
    let mut out = replace_first(pattern, xml, "").map_err(thrown)?;
    if let Some(protection) = protection {
        let crypt = match truthy_str(protection.hash.as_deref()) {
            Some(hash) => crypt_attributes(
                protection.algorithm_sid.map(|n| n.0),
                protection.spin_count.map(|n| n.0),
                hash,
                protection.salt.as_deref(),
            ),
            None => String::new(),
        };
        let tag = format!(
            "<w:documentProtection w:edit=\"{}\"{}{crypt}/>",
            escape_xml_attr(&protection.edit),
            if protection.enforced {
                " w:enforcement=\"1\""
            } else {
                ""
            },
        );
        out = insert_settings_child(&out, "documentProtection", &tag)?;
    }
    Ok(out)
}

/// `applyWriteProtection`: set or remove `<w:writeProtection>` (password to modify).
pub fn apply_write_protection(
    xml: &str,
    write_protection: Option<&WriteProtection>,
) -> Result<String, String> {
    let pattern =
        try_js_regex!(r"<w:writeProtection(?=[\s/>])[^>]*?(?:\/\s*>|>\s*<\/w:writeProtection\s*>)");
    let mut out = replace_first(pattern, xml, "").map_err(thrown)?;
    if let Some(wp) = write_protection
        && (wp.recommended == Some(true) || truthy_str(wp.hash.as_deref()).is_some())
    {
        let crypt = match truthy_str(wp.hash.as_deref()) {
            Some(hash) => crypt_attributes(
                wp.algorithm_sid.map(|n| n.0),
                wp.spin_count.map(|n| n.0),
                hash,
                wp.salt.as_deref(),
            ),
            None => String::new(),
        };
        let recommended = if wp.recommended == Some(true) {
            " w:recommended=\"1\""
        } else {
            ""
        };
        let tag = format!("<w:writeProtection{recommended}{crypt}/>");
        out = insert_settings_child(&out, "writeProtection", &tag)?;
    }
    Ok(out)
}

fn truthy_str(text: Option<&str>) -> Option<&str> {
    text.filter(|text| !text.is_empty())
}

/// The hash attributes of a protection element; `sid` and `spin` default as `?? 14` and `?? 100000` do.
fn crypt_attributes(sid: Option<f64>, spin: Option<f64>, hash: &str, salt: Option<&str>) -> String {
    format!(
        " w:cryptProviderType=\"rsaAES\" w:cryptAlgorithmClass=\"hash\" w:cryptAlgorithmType=\"typeAny\" w:cryptAlgorithmSid=\"{}\" w:cryptSpinCount=\"{}\" w:hash=\"{}\"{}",
        jscompat::number_to_string(sid.unwrap_or(14.0)),
        jscompat::number_to_string(spin.unwrap_or(100000.0)),
        escape_xml_attr(hash),
        match truthy_str(salt) {
            Some(salt) => format!(" w:salt=\"{}\"", escape_xml_attr(salt)),
            None => String::new(),
        },
    )
}

const WORDPROCESSINGML_NAMESPACES: [&str; 2] = [
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
];

/// `applyRemovePersonalInfo`: set or remove removePersonalInformation while retaining the part's prefix.
pub fn apply_remove_personal_info(xml: &str, on: bool) -> Result<String, String> {
    let prefixes = namespace_prefixes(xml, &WORDPROCESSINGML_NAMESPACES);
    // `prefixes.find(Boolean)`: the first non-empty prefix
    let prefix = match prefixes.iter().find(|prefix| !prefix.is_empty()) {
        Some(prefix) => prefix.as_str(),
        None if prefixes.iter().any(String::is_empty) => "",
        None => "w",
    };
    let property = if prefix.is_empty() {
        "removePersonalInformation".to_owned()
    } else {
        format!("{prefix}:removePersonalInformation")
    };
    let escaped = jscompat::regex_escape(&property);
    let pattern = TryJsRegex::new(
        &format!(r"<{escaped}\b[^>]*(?:\/\s*>|>\s*<\/{escaped}\s*>)"),
        "",
    )
    .map_err(thrown)?;
    let out = pattern
        .try_replace_all(xml, |_| String::new())
        .map_err(thrown)?;
    if !on {
        return Ok(out);
    }
    insert_settings_child(&out, "removePersonalInformation", &format!("<{property}/>"))
}

/// `applyPageColor`: set, replace or remove `<w:background>` (it must be the
/// first child of `w:document`). Both spellings are valid OOXML, self-closing
/// or an element pair carrying a VML fill; the pair is stripped whole and the
/// canonical self-closing form re-emitted. The start tag is read past a quoted
/// `>` in an attribute value.
pub fn apply_page_color(document_xml: &str, color: Option<&str>) -> Result<String, String> {
    let mut xml = remove_elements(document_xml, "w:background", None);
    if let Some(color) = color.filter(|color| !color.is_empty())
        && let Some(root) = find_start_tag(&xml, TagName::Exact("w:document"), 0)
    {
        let at = root.end;
        xml = format!(
            "{}<w:background w:color=\"{}\"/>{}",
            &xml[..at],
            escape_xml_attr(color),
            &xml[at..]
        );
    }
    Ok(xml)
}
