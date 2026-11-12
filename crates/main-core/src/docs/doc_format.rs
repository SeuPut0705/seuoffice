//! `apps/docs/src/main/doc-format.ts`: format rules of the open and save
//! paths. `docFormatOfPath` is re-exported there from
//! `apps/docs/src/shared/open-file.ts`; it is ported here.

use jscompat::{js_regex, text_decoder_decode};

/// `DocFormat`: the formats the Word editor opens and saves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocFormat {
    Docx,
    Odt,
}

impl DocFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            DocFormat::Docx => "docx",
            DocFormat::Odt => "odt",
        }
    }
}

/// `docFormatOfPath(filePath)`: `.docx` is docx, `.odt` is odt, anything else
/// is not a Word-editor document.
pub fn doc_format_of_path(file_path: &str) -> Option<DocFormat> {
    if js_regex!(r"\.docx$", "i").test(file_path) {
        Some(DocFormat::Docx)
    } else if js_regex!(r"\.odt$", "i").test(file_path) {
        Some(DocFormat::Odt)
    } else {
        None
    }
}

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;

fn u16_le(bytes: &[u8], at: usize) -> u64 {
    u64::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]))
}

fn u32_le(bytes: &[u8], at: usize) -> u64 {
    u64::from(u32::from_le_bytes([
        bytes[at],
        bytes[at + 1],
        bytes[at + 2],
        bytes[at + 3],
    ]))
}

/// Entry names from a zip's central directory, or `None` when the bytes are
/// not a readable zip (zip64 directories included).
pub fn zip_entry_names(bytes: &[u8]) -> Option<Vec<String>> {
    if bytes.len() < 22 {
        return None;
    }
    let lowest = bytes.len().saturating_sub(22 + 0xffff);
    for at in (lowest..=bytes.len() - 22).rev() {
        if u32_le(bytes, at) != u64::from(EOCD_SIGNATURE) {
            continue;
        }
        let count = u16_le(bytes, at + 10);
        let mut offset = u32_le(bytes, at + 16);
        if count == 0xffff || offset == 0xffff_ffff {
            return None;
        }
        let len = bytes.len() as u64;
        let mut names = Vec::new();
        for _ in 0..count {
            if offset + 46 > len || u32_le(bytes, offset as usize) != u64::from(CENTRAL_SIGNATURE) {
                return None;
            }
            let name_length = u16_le(bytes, offset as usize + 28);
            let extra_length = u16_le(bytes, offset as usize + 30);
            let comment_length = u16_le(bytes, offset as usize + 32);
            if offset + 46 + name_length > len {
                return None;
            }
            let from = (offset + 46) as usize;
            names.push(text_decoder_decode(&bytes[from..from + name_length as usize]).into_owned());
            offset += 46 + name_length + extra_length + comment_length;
        }
        return Some(names);
    }
    None
}

/// An OpenDocument package: `mimetype` and `content.xml`, no OOXML content types.
pub fn is_odt_package(bytes: &[u8]) -> bool {
    zip_entry_names(bytes).is_some_and(|names| {
        names.iter().any(|name| name == "mimetype")
            && names.iter().any(|name| name == "content.xml")
            && !names.iter().any(|name| name == "[Content_Types].xml")
    })
}

/// Save As target: a name without a Word-editor extension takes the current
/// format's.
pub fn with_doc_extension(file_path: &str, fallback: DocFormat) -> String {
    if doc_format_of_path(file_path).is_some() {
        file_path.to_owned()
    } else {
        format!("{file_path}.{}", fallback.as_str())
    }
}

/// Extension of a document's crash-recovery copy: the copy keeps its
/// document's format.
pub fn recovery_ext_for(file_path: &str) -> &'static str {
    if doc_format_of_path(file_path) == Some(DocFormat::Odt) {
        ".odt"
    } else {
        ".docx"
    }
}

/// What `deps.materialize` answers: the document with its lazily served
/// pictures inlined, and the hashes it absorbed (a `Set`: each once, in order
/// of first appearance).
#[derive(Debug, Clone, PartialEq)]
pub struct Materialized {
    pub bytes: Vec<u8>,
    pub hashes: Vec<String>,
}

/// The open-password wrapper step of a save.
type EncryptStep<'a> = dyn FnMut(&[u8], &str) -> Result<Vec<u8>, String> + 'a;

/// The step protecting the plain recovery copy, `None` to skip the copy.
type ProtectStep<'a> = dyn FnMut(&[u8]) -> Result<Option<Vec<u8>>, String> + 'a;

/// `SaveBytesDeps`. A step that throws answers `Err` with the message.
pub struct SaveBytesDeps<'a> {
    /// docx only: inline lazily served pictures before the file is written
    pub materialize: &'a mut dyn FnMut(&[u8]) -> Result<Materialized, String>,
    /// docx only: the ECMA-376 open-password wrapper
    pub encrypt: &'a mut EncryptStep<'a>,
    /// docx only: the password the write uses (`None` = plain)
    pub password: Option<&'a str>,
}

/// `PreparedSave`
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedSave {
    /// what lands on disk
    pub bytes: Vec<u8>,
    /// the plain document (docx before encryption; the ODT itself)
    pub plain: Vec<u8>,
    /// lazy picture hashes the docx write absorbed (always empty for ODT)
    pub hashes: Vec<String>,
    pub encrypted: bool,
}

/// The bytes a save writes for `format`; bytes of the other format are
/// refused. The error is the message of the `Error` thrown.
pub fn prepare_save_bytes(
    format: DocFormat,
    data: &[u8],
    deps: &mut SaveBytesDeps<'_>,
) -> Result<PreparedSave, String> {
    if format == DocFormat::Odt {
        if !is_odt_package(data) {
            return Err("save data is not an ODT document".to_owned());
        }
        return Ok(PreparedSave {
            bytes: data.to_vec(),
            plain: data.to_vec(),
            hashes: Vec::new(),
            encrypted: false,
        });
    }
    if is_odt_package(data) {
        return Err("save data is not a docx document".to_owned());
    }
    let Materialized {
        bytes: plain,
        hashes,
    } = (deps.materialize)(data)?;
    // `deps.password ?` : an empty password is plain
    let password = jscompat::truthy(deps.password);
    let bytes = match password {
        Some(password) => (deps.encrypt)(&plain, password)?,
        None => plain.clone(),
    };
    Ok(PreparedSave {
        bytes,
        plain,
        hashes,
        encrypted: password.is_some(),
    })
}

/// `RecoveryBytesDeps`
pub struct RecoveryBytesDeps<'a> {
    pub materialize: &'a mut dyn FnMut(&[u8]) -> Result<Materialized, String>,
    /// docx only: protect the plain copy for the file's current state on disk,
    /// or `None` to skip this copy
    pub protect: &'a mut ProtectStep<'a>,
}

/// The bytes of a crash-recovery copy: what a save would write now. A
/// picture step that fails leaves the copy as built; bytes of the other
/// format give `None`.
pub fn prepare_recovery_bytes(
    format: DocFormat,
    data: &[u8],
    deps: &mut RecoveryBytesDeps<'_>,
) -> Result<Option<Vec<u8>>, String> {
    if format == DocFormat::Odt {
        return Ok(is_odt_package(data).then(|| data.to_vec()));
    }
    if is_odt_package(data) {
        return Ok(None);
    }
    let plain = match (deps.materialize)(data) {
        Ok(materialized) => materialized.bytes,
        // keep the copy as built
        Err(_) => data.to_vec(),
    };
    (deps.protect)(&plain)
}
