//! A loaded package: what the TypeScript engine holds as a `JSZip`.

use std::borrow::Borrow;
use std::cell::OnceCell;
use std::collections::HashMap;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::ops::Deref;
use std::rc::Rc;

use crate::decode_text;

/// What reading a damaged part throws in the TypeScript engine. JSZip inflates
/// a part when it is read, so the damage shows at the reader that asks for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadError {
    pub part: String,
    /// The message of the error JSZip throws.
    pub reason: String,
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "part {} cannot be read: {}", self.part, self.reason)
    }
}

impl std::error::Error for ReadError {}

/// A part name. The folders JSZip adds above a name are prefixes of it, and
/// share its text as a JavaScript substring does: a name with thousands of
/// slashes adds thousands of folders, and copies would take memory quadratic
/// in its length.
#[derive(Clone)]
pub struct PartName {
    text: Rc<str>,
    len: usize,
}

impl PartName {
    /// The first `len` bytes of this name, on a char boundary.
    fn prefix(&self, len: usize) -> Self {
        Self {
            text: Rc::clone(&self.text),
            len,
        }
    }

    pub fn as_str(&self) -> &str {
        &self.text[..self.len]
    }
}

impl From<String> for PartName {
    fn from(name: String) -> Self {
        let len = name.len();
        Self {
            text: name.into(),
            len,
        }
    }
}

impl From<&str> for PartName {
    fn from(name: &str) -> Self {
        Self {
            text: name.into(),
            len: name.len(),
        }
    }
}

impl Deref for PartName {
    type Target = str;
    fn deref(&self) -> &str {
        self.as_str()
    }
}

impl Borrow<str> for PartName {
    fn borrow(&self) -> &str {
        self.as_str()
    }
}

impl PartialEq for PartName {
    fn eq(&self, other: &Self) -> bool {
        self.as_str() == other.as_str()
    }
}

impl Eq for PartName {}

impl PartialEq<str> for PartName {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for PartName {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

/// As `str` hashes, so a `&str` finds a name in a map.
impl Hash for PartName {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.as_str().hash(state);
    }
}

impl fmt::Debug for PartName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self.as_str(), f)
    }
}

impl fmt::Display for PartName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

pub struct Part {
    pub name: PartName,
    pub is_dir: bool,
    content: Result<Vec<u8>, String>,
    text: OnceCell<String>,
}

impl Part {
    pub fn new(name: impl Into<PartName>, is_dir: bool, content: Result<Vec<u8>, String>) -> Self {
        Self {
            name: name.into(),
            is_dir,
            content,
            text: OnceCell::new(),
        }
    }

    /// `file.async('uint8array')`
    pub fn bytes(&self) -> Result<&[u8], ReadError> {
        self.content.as_deref().map_err(|reason| ReadError {
            part: self.name.to_string(),
            reason: reason.clone(),
        })
    }

    /// Transfers the loaded entry without another inflated-byte allocation.
    pub fn into_content(self) -> Result<(String, Vec<u8>), ReadError> {
        match self.content {
            Ok(content) => Ok((self.name.to_string(), content)),
            Err(reason) => Err(ReadError {
                part: self.name.to_string(),
                reason,
            }),
        }
    }

    /// `file.async('string')`
    pub fn text(&self) -> Result<&str, ReadError> {
        let bytes = self.bytes()?;
        Ok(self.text.get_or_init(|| decode_text(bytes).into_owned()))
    }
}

/// The index a JavaScript object orders a key by, when the key is an array
/// index ("0", "17", not "017"): such keys come first, in numeric order.
fn array_index(name: &str) -> Option<u32> {
    let canonical = name == "0" || !name.starts_with('0');
    let all_digits = !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit());
    (canonical && all_digits)
        .then(|| name.parse::<u32>().ok())
        .flatten()
        .filter(|index| *index != u32::MAX)
}

/// The parts in the order of `Object.keys(zip.files)`, found by name the way
/// `zip.file(name)` finds them.
#[derive(Default)]
pub struct Package {
    parts: Vec<Part>,
    by_name: HashMap<PartName, usize>,
    /// How many parts at the front have an array index for a name.
    indexed: usize,
}

impl Package {
    /// A package of in-memory files, added the way `zip.file(name, data)` adds
    /// them.
    pub fn from_parts<N: Into<String>, B: Into<Vec<u8>>>(
        parts: impl IntoIterator<Item = (N, B)>,
    ) -> Self {
        let mut package = Self::default();
        for (name, bytes) in parts {
            package.set_file(name.into(), bytes.into());
        }
        package
    }

    /// `zip.files[name] = part`: a name seen before keeps its place and takes
    /// the new content.
    pub fn set(&mut self, part: Part) {
        if let Some(&index) = self.by_name.get(part.name.as_str()) {
            self.parts[index] = part;
            return;
        }
        let at = match array_index(&part.name) {
            Some(index) => {
                let at = self.parts[..self.indexed]
                    .partition_point(|other| array_index(&other.name) < Some(index));
                self.indexed += 1;
                at
            }
            None => self.parts.len(),
        };
        if at < self.parts.len() {
            for index in self.by_name.values_mut().filter(|index| **index >= at) {
                *index += 1;
            }
        }
        self.by_name.insert(part.name.clone(), at);
        self.parts.insert(at, part);
    }

    /// `zip.file(name, data)`: the folders above the file are created first
    /// where they are missing, as JSZip does by default.
    pub fn set_file(&mut self, name: impl Into<PartName>, bytes: Vec<u8>) {
        let name: PartName = name.into();
        self.add_parent_folders(&name);
        self.set(Part::new(name, false, Ok(bytes)));
    }

    /// The folders above `name` that are missing, created outermost first. A
    /// loop, not a recursion: a name may hold thousands of slashes.
    fn add_parent_folders(&mut self, name: &PartName) {
        let mut missing = Vec::new();
        let mut path = name.strip_suffix('/').unwrap_or(name.as_str());
        // a slash at index 0 is no parent
        while let Some(last_slash) = path.rfind('/').filter(|at| *at > 0) {
            // JSZip's forceTrailingSlash: a parent ending in a slash keeps just
            // that one; either way the folder is the name up to that slash
            let parent = &path[..last_slash];
            let folder = if parent.ends_with('/') {
                name.prefix(last_slash)
            } else {
                name.prefix(last_slash + 1)
            };
            if self.by_name.contains_key(folder.as_str()) {
                break;
            }
            path = parent.strip_suffix('/').unwrap_or(parent);
            missing.push(folder);
        }
        for folder in missing.into_iter().rev() {
            self.set(Part::new(folder, true, Ok(Vec::new())));
        }
    }

    /// `zip.remove(name)`: a file goes; otherwise `name` (with a trailing slash
    /// added where it has none) is a folder prefix, and every entry under it
    /// goes, the folder itself included.
    pub fn remove(&mut self, name: &str) {
        let mut key = name.to_owned();
        let mut found = self.by_name.get(key.as_str()).copied();
        if found.is_none() {
            if !key.ends_with('/') {
                key.push('/');
            }
            found = self.by_name.get(key.as_str()).copied();
        }
        match found {
            Some(index) if !self.parts[index].is_dir => {
                self.parts.remove(index);
            }
            _ => self.parts.retain(|part| !part.name.starts_with(&key)),
        }
        self.by_name = self
            .parts
            .iter()
            .enumerate()
            .map(|(index, part)| (part.name.clone(), index))
            .collect();
        self.indexed = self
            .parts
            .iter()
            .filter(|part| array_index(&part.name).is_some())
            .count();
    }

    pub fn parts(&self) -> &[Part] {
        &self.parts
    }

    /// Transfers entries in `Object.keys(zip.files)` order.
    pub fn into_parts(self) -> Vec<Part> {
        self.parts
    }
    /// `zip.file(path)`: a folder is not a file.
    pub fn file(&self, path: &str) -> Option<&Part> {
        self.by_name
            .get(path)
            .map(|&index| &self.parts[index])
            .filter(|part| !part.is_dir)
    }

    /// `zip.file(path) !== null`
    pub fn has(&self, path: &str) -> bool {
        self.file(path).is_some()
    }

    /// `await zip.file(path)?.async('string')`
    pub fn text(&self, path: &str) -> Result<Option<&str>, ReadError> {
        self.file(path).map(Part::text).transpose()
    }

    /// `await zip.file(path)?.async('uint8array')`
    pub fn bytes(&self, path: &str) -> Result<Option<&[u8]>, ReadError> {
        self.file(path).map(Part::bytes).transpose()
    }
}
