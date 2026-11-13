//! `docprops.*`: doc-properties.ts, zotero-doc-props.ts, sources.ts and
//! protection.ts.

use docx_engine::doc_properties::zotero::{
    self, CUSTOM_PROPERTIES_CONTENT_TYPE, CUSTOM_PROPERTIES_PATH, CUSTOM_PROPERTIES_REL_TYPE,
};
use docx_engine::doc_properties::{self as props, DocumentProperties};
use docx_engine::protection::{self, ProtectionRecord, SpinCount};
use docx_engine::sources::{self, SourceInfo};
use jscompat::JsNum;
use serde_json::Value;

use super::{Returned, arg, package, required, value};

/// A value typed `unknown` in the TypeScript, as `resolveSpinCount` sees it.
fn spin_count(raw: Option<&Value>) -> SpinCount {
    match raw {
        None | Some(Value::Null) => SpinCount::Missing,
        Some(Value::Number(number)) => SpinCount::Number(number.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(text)) => SpinCount::Text(text.clone()),
        Some(other) => SpinCount::Other(other.to_string()),
    }
}

fn protection_record(args: &Value) -> Result<ProtectionRecord, String> {
    let record: Value = required(args, "protection")?;
    Ok(ProtectionRecord {
        hash: arg(&record, "hash")?,
        salt: arg(&record, "salt")?,
        spin_count: spin_count(record.get("spinCount")),
        algorithm_sid: arg(&record, "algorithmSid")?,
    })
}

/// The exported constants of the four modules, by name.
fn constant(name: &str) -> Returned {
    let keys = |table: &[(&'static str, &'static str)]| -> Vec<&'static str> {
        table.iter().map(|(key, _)| *key).collect()
    };
    match name {
        "CORE_PROPERTY_KEYS" => value(keys(&props::CORE_PROPERTIES)),
        "APP_PROPERTY_KEYS" => value(keys(&props::APP_PROPERTIES)),
        "emptyDocumentProperties" => value(DocumentProperties::default()),
        "CORE_PROPERTIES_PATH" => value(props::CORE_PROPERTIES_PATH),
        "APP_PROPERTIES_PATH" => value(props::APP_PROPERTIES_PATH),
        "CORE_PROPERTIES_CONTENT_TYPE" => value(props::CORE_PROPERTIES_CONTENT_TYPE),
        "CORE_PROPERTIES_REL_TYPE" => value(props::CORE_PROPERTIES_REL_TYPE),
        "APP_PROPERTIES_CONTENT_TYPE" => value(props::APP_PROPERTIES_CONTENT_TYPE),
        "APP_PROPERTIES_REL_TYPE" => value(props::APP_PROPERTIES_REL_TYPE),
        "CUSTOM_PROPERTIES_PATH" => value(CUSTOM_PROPERTIES_PATH),
        "CUSTOM_PROPERTIES_REL_TYPE" => value(CUSTOM_PROPERTIES_REL_TYPE),
        "CUSTOM_PROPERTIES_CONTENT_TYPE" => value(CUSTOM_PROPERTIES_CONTENT_TYPE),
        "SOURCES_NS" => value(sources::SOURCES_NS),
        "CUSTOM_XML_REL_TYPE" => value(sources::CUSTOM_XML_REL_TYPE),
        "DEFAULT_SPIN_COUNT" => value(JsNum(protection::DEFAULT_SPIN_COUNT)),
        "MAX_SPIN_COUNT" => value(JsNum(protection::MAX_SPIN_COUNT)),
        _ => Err(format!("no constant {name}")),
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "constants" => constant(&required::<String>(args, "name")?),
        "parseCorePropertiesXml" => {
            value(props::parse_core_properties_xml(text).map_err(|limit| limit.to_string())?)
        }
        "parseAppPropertiesXml" => {
            value(props::parse_app_properties_xml(text).map_err(|limit| limit.to_string())?)
        }
        "parseCustomPropertiesXml" => value(props::parse_custom_properties_xml(text)),
        "parseCustomPropertyTypesXml" => value(props::parse_custom_property_types_xml(text)),
        "readDocumentProperties" => value(
            props::read_document_properties(&package(args)?).map_err(|error| error.to_string())?,
        ),
        "parseZoteroDocumentDataXml" => value(zotero::parse_zotero_document_data_xml(text)),
        "readZoteroDocumentData" => value(
            zotero::read_zotero_document_data(&package(args)?)
                .map_err(|error| error.to_string())?,
        ),
        "decodeXmlText" => value(zotero::decode_xml_text(text)),
        "attrValue" => value(
            zotero::attr_value(text, &required::<String>(args, "name")?)
                .map_err(|error| error.to_string())?,
        ),
        "propertyText" => value(zotero::property_text(text)),
        "findSourcesPart" => {
            value(sources::find_sources_part(&package(args)?).map_err(|error| error.to_string())?)
        }
        "parseSourcesXml" => value(sources::parse_sources_xml(text)),
        "citationText" => value(sources::citation_text(&required::<SourceInfo>(
            args, "source",
        )?)),
        "bibliographyLine" => value(sources::bibliography_line(&required::<SourceInfo>(
            args, "source",
        )?)),
        "resolveSpinCount" => {
            // the text stands for the raw value where the arguments carry none
            let raw = match args.get("raw") {
                Some(raw) => spin_count(Some(raw)),
                None => SpinCount::Text(text.to_owned()),
            };
            value(JsNum(
                protection::resolve_spin_count(&raw).map_err(|error| error.to_string())?,
            ))
        }
        "hashProtectionPassword" => value(
            protection::hash_protection_password(
                text,
                &spin_count(args.get("spinCount")),
                // what `crypto.getRandomValues` is made to give the TypeScript side
                &required::<Vec<u8>>(args, "saltBytes")?,
            )
            .map_err(|error| error.to_string())?,
        ),
        "verifyProtectionPassword" => value(
            protection::verify_protection_password(text, &protection_record(args)?)
                .map_err(|error| error.to_string())?,
        ),
        _ => Err(format!("unknown function {function}")),
    }
}
