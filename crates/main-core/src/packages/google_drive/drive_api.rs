//! `packages/google-drive/src/drive-api.ts`: the Drive v3 REST calls the app
//! makes. Every call takes its access token from the connection and its
//! fetch from the caller, so tests never reach Google. Calls do not throw: a
//! failure is a [`DriveErrorKind`] the screen translates. The two places where
//! the TypeScript does throw (a JSON `null` where it reads a property, a
//! `files` that is no array) are [`DriveFailure::Thrown`].

use std::rc::Rc;

use jscompat::{
    JsonValue, encode_uri_component, json_stringify, math_max, math_min, number_to_string,
    to_number,
};

use super::formats::{FOLDER_MIME, SHORTCUT_MIME};
use super::oauth::{member, response_json};
use crate::packages::ai_provider::jsval::{Obj, object, text};
use crate::packages::ai_provider::task::{
    Fetcher, JsError, LocalBoxFuture, Request, RequestBody, Response, Rt, Signal,
};

/// `DRIVE_API`
pub const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";
/// `DRIVE_UPLOAD_API`
pub const DRIVE_UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3";

const REQUEST_TIMEOUT_MS: f64 = 30_000.0;
const TRANSFER_TIMEOUT_MS: f64 = 10.0 * 60.0 * 1000.0;

/// `MAX_OPEN_BYTES`: largest file the app downloads to open.
pub const MAX_OPEN_BYTES: f64 = 300.0 * 1024.0 * 1024.0;
/// `MAX_READ_BYTES`: the most the AI may read in one go.
pub const MAX_READ_BYTES: f64 = 30.0 * 1024.0 * 1024.0;

/// `DriveErrorKind`. `NotConnected`: no Drive connection, or Google ended it;
/// `NotFound`: the file is gone or this account cannot see it; `Forbidden`:
/// the account may see the file but not do this; `TooLarge`: past the app's
/// limit, or past Google's export limit for its own documents; `RateLimit`:
/// Google asked to slow down; `Network`: anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveErrorKind {
    NotConnected,
    NotFound,
    Forbidden,
    TooLarge,
    RateLimit,
    Network,
}

impl DriveErrorKind {
    /// the kind as the TypeScript spells it
    pub fn as_str(self) -> &'static str {
        match self {
            DriveErrorKind::NotConnected => "not-connected",
            DriveErrorKind::NotFound => "not-found",
            DriveErrorKind::Forbidden => "forbidden",
            DriveErrorKind::TooLarge => "too-large",
            DriveErrorKind::RateLimit => "rate-limit",
            DriveErrorKind::Network => "network",
        }
    }
}

/// What a `DriveResult` answers where it is not `{ ok: true }`.
#[derive(Debug, Clone, PartialEq)]
pub enum DriveFailure {
    /// `{ ok: false, kind }`
    Kind(DriveErrorKind),
    /// the promise rejected
    Thrown(JsError),
}

impl DriveFailure {
    /// The `kind` of `{ ok: false, kind }`.
    pub fn kind(&self) -> Option<DriveErrorKind> {
        match self {
            DriveFailure::Kind(kind) => Some(*kind),
            DriveFailure::Thrown(_) => None,
        }
    }
}

impl From<DriveErrorKind> for DriveFailure {
    fn from(kind: DriveErrorKind) -> Self {
        DriveFailure::Kind(kind)
    }
}

impl From<JsError> for DriveFailure {
    fn from(error: JsError) -> Self {
        DriveFailure::Thrown(error)
    }
}

/// `DriveResult<T>`: the `{ ok: true } & T` side is `Ok(T)`.
pub type DriveResult<T> = Result<T, DriveFailure>;

/// `DriveFile['shortcutTarget']`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutTarget {
    pub id: String,
    pub mime_type: String,
}

/// `DriveFile`
#[derive(Debug, Clone, PartialEq)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    /// ISO time
    pub modified_time: String,
    /// the account may change the file's content
    pub can_edit: bool,
    /// bytes; absent for Google's own documents and folders
    pub size: Option<f64>,
    /// content hash of a stored file; absent for Google's own documents
    pub md5_checksum: Option<String>,
    pub parents: Option<Vec<String>>,
    /// a shortcut's target, when this entry is a shortcut
    pub shortcut_target: Option<ShortcutTarget>,
}

/// `DriveAccount`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveAccount {
    pub display_name: String,
    pub email_address: String,
}

/// `AccessTokenSource`: gives a valid access token, refreshing when needed;
/// `None` when not connected.
pub type AccessTokenSource = Rc<dyn Fn(Rt, Option<Signal>) -> LocalBoxFuture<Option<String>>>;

/// `DriveApiOptions`. `fetch` serves every call but a file's bytes and must
/// not follow a redirect: each call carries the token. `download` serves a
/// file's bytes (`alt=media`, an export) and may follow one, provided it
/// leaves the token behind when it leaves the origin; `fetch` when absent.
#[derive(Clone)]
pub struct DriveApiOptions {
    pub token: AccessTokenSource,
    pub fetch: Fetcher,
    pub download: Option<Fetcher>,
}

const FILE_FIELDS: &str =
    "id,name,mimeType,modifiedTime,size,md5Checksum,parents,capabilities/canEdit,shortcutDetails";

/// `typeof value === 'string'`
fn string_of(value: Option<JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(s)) => Some(s),
        _ => None,
    }
}

/// `fileFrom(raw)`: `None` for an entry that lacks a string `id`, `name` or
/// `mimeType`; a `null` entry throws, as the property read does.
pub fn file_from(raw: &JsonValue) -> Result<Option<DriveFile>, JsError> {
    let Some(id) = string_of(member(raw, "id")?) else {
        return Ok(None);
    };
    let Some(name) = string_of(member(raw, "name")?) else {
        return Ok(None);
    };
    let Some(mime_type) = string_of(member(raw, "mimeType")?) else {
        return Ok(None);
    };
    let modified_time = string_of(member(raw, "modifiedTime")?).unwrap_or_default();
    let can_edit = match member(raw, "capabilities")? {
        Some(capabilities) if capabilities != JsonValue::Null => {
            member(&capabilities, "canEdit")? == Some(JsonValue::Bool(true))
        }
        _ => false,
    };
    let mut file = DriveFile {
        id,
        name,
        mime_type,
        modified_time,
        can_edit,
        size: None,
        md5_checksum: None,
        parents: None,
        shortcut_target: None,
    };
    let size = match member(raw, "size")? {
        Some(JsonValue::String(size)) => to_number(&size),
        _ => f64::NAN,
    };
    if size.is_finite() && size >= 0.0 {
        file.size = Some(size);
    }
    if let Some(JsonValue::String(md5)) = member(raw, "md5Checksum")? {
        file.md5_checksum = Some(md5);
    }
    if let Some(JsonValue::Array(parents)) = member(raw, "parents")? {
        file.parents = Some(
            parents
                .into_iter()
                .filter_map(|p| match p {
                    JsonValue::String(s) => Some(s),
                    _ => None,
                })
                .collect(),
        );
    }
    let target = member(raw, "shortcutDetails")?;
    if file.mime_type == SHORTCUT_MIME
        && let Some(target) = target
        && target != JsonValue::Null
        && let Some(JsonValue::String(target_id)) = member(&target, "targetId")?
        && let Some(JsonValue::String(target_mime)) = member(&target, "targetMimeType")?
    {
        file.shortcut_target = Some(ShortcutTarget {
            id: target_id,
            mime_type: target_mime,
        });
    }
    Ok(Some(file))
}

/// `timeout(ms, signal)`
fn timeout(rt: &Rt, ms: f64, signal: Option<&Signal>) -> Signal {
    let timer = rt.timeout_signal(ms);
    match signal {
        Some(signal) => rt.any_signal(&[signal, &timer]),
        None => timer,
    }
}

/// `kindOf(response)`: the error a failed answer stands for. A 403 body of an
/// unexpected shape throws; the caller turns that into `Network`.
async fn kind_of(response: &Response) -> Result<DriveErrorKind, JsError> {
    let status = response.status();
    if status == 401.0 {
        return Ok(DriveErrorKind::NotConnected);
    }
    if status == 404.0 {
        return Ok(DriveErrorKind::NotFound);
    }
    if status == 429.0 {
        return Ok(DriveErrorKind::RateLimit);
    }
    if status == 403.0 {
        let body = response_json(response)
            .await
            .unwrap_or_else(|_| JsonValue::Object(Obj::new()));
        // (body.error?.errors ?? []).map((e) => e.reason)
        let errors = match member(&body, "error")? {
            Some(error) if error != JsonValue::Null => member(&error, "errors")?,
            _ => None,
        };
        let mut reasons: Vec<Option<JsonValue>> = Vec::new();
        match errors {
            None | Some(JsonValue::Null) => {}
            Some(JsonValue::Array(items)) => {
                for item in &items {
                    reasons.push(member(item, "reason")?);
                }
            }
            Some(_) => {
                return Err(JsError::type_error(
                    "(intermediate value).map is not a function",
                ));
            }
        }
        let is = |reason: &Option<JsonValue>, expected: &str| matches!(reason, Some(JsonValue::String(s)) if s == expected);
        if reasons.iter().any(|r| is(r, "exportSizeLimitExceeded")) {
            return Ok(DriveErrorKind::TooLarge);
        }
        if reasons
            .iter()
            .any(|r| is(r, "userRateLimitExceeded") || is(r, "rateLimitExceeded"))
        {
            return Ok(DriveErrorKind::RateLimit);
        }
        return Ok(DriveErrorKind::Forbidden);
    }
    Ok(DriveErrorKind::Network)
}

/// `queryLiteral(value)`: quote a value for a Drive query string.
pub fn query_literal(value: &str) -> String {
    // the global replaces of a backslash and of a quote, in that order
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// `DriveListing`: what a list shows: the files the app may open, most
/// recently viewed first, or a search among them. With the `drive.file`
/// scope Google answers only with files the person picked in its picker or
/// the app made (decision 0085), so neither list reaches the rest of the
/// Drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriveListing {
    Recent,
    Search { text: String },
}

/// `listingQuery(listing)`: `(q, orderBy)`.
pub fn listing_query(listing: &DriveListing) -> (String, String) {
    match listing {
        DriveListing::Recent => (
            format!(
                "mimeType != {} and trashed = false",
                query_literal(FOLDER_MIME)
            ),
            "viewedByMeTime desc".to_owned(),
        ),
        DriveListing::Search { text } => {
            let text = query_literal(text);
            (
                format!("(name contains {text} or fullText contains {text}) and trashed = false"),
                // Drive refuses an ordering on full-text searches
                String::new(),
            )
        }
    }
}

/// `new URLSearchParams(pairs).toString()`
fn query(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs.iter())
        .finish()
}

/// What `list` answers besides its files.
#[derive(Debug, Clone, PartialEq)]
pub struct DriveList {
    pub files: Vec<DriveFile>,
    pub next_page_token: Option<String>,
}

/// The `options` of `list`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ListOptions {
    pub page_token: Option<String>,
    pub page_size: Option<f64>,
}

/// Where `upload` puts the bytes: `existingId` replaces that file's content
/// (keeping its id, sharing and history); without it a new file is made in
/// `parentId`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadTarget {
    Existing {
        id: String,
    },
    New {
        name: String,
        parent_id: Option<String>,
    },
}

/// The `init` of a call: what `RequestInit` carries but the signal.
struct CallInit {
    method: Option<&'static str>,
    headers: Vec<(String, String)>,
    body: Option<RequestBody>,
}

impl CallInit {
    fn get() -> CallInit {
        CallInit {
            method: None,
            headers: Vec::new(),
            body: None,
        }
    }
}

/// A header value as `Headers` keeps it: a character past 255 throws, the
/// white space at both ends is stripped, a NUL, CR or LF inside throws.
fn header_value(value: &str) -> Option<String> {
    if value.chars().any(|c| u32::from(c) > 255) {
        return None;
    }
    let value = value.trim_matches(|c| matches!(c, '\t' | '\n' | '\r' | ' '));
    if value.contains(['\0', '\r', '\n']) {
        return None;
    }
    Some(value.to_owned())
}

/// `new Headers(given)` then `headers.set('Authorization', ...)`, read back
/// by `[...headers.entries()]`: names lower-cased and sorted. `None` is what
/// threw.
fn with_authorization(given: &[(String, String)], token: &str) -> Option<Vec<(String, String)>> {
    let mut entries: Vec<(String, String)> = Vec::new();
    for (name, value) in given {
        let value = header_value(value)?;
        let name = name.to_lowercase();
        match entries.iter_mut().find(|(known, _)| *known == name) {
            Some(slot) => {
                slot.1.push_str(", ");
                slot.1.push_str(&value);
            }
            None => entries.push((name, value)),
        }
    }
    let bearer = header_value(&format!("Bearer {token}"))?;
    match entries
        .iter_mut()
        .find(|(known, _)| known == "authorization")
    {
        Some(slot) => slot.1 = bearer,
        None => entries.push(("authorization".to_owned(), bearer)),
    }
    entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    Some(entries)
}

/// `new Uint8Array(await response.arrayBuffer())` of a response with no body
/// is empty; otherwise `readCapped`.
async fn read_capped(response: &Response, max_bytes: f64) -> DriveResult<Vec<u8>> {
    let declared = match response.header("Content-Length") {
        Some(length) => to_number(&length),
        None => f64::NAN,
    };
    if declared.is_finite() && declared > max_bytes {
        response.cancel();
        return Err(DriveErrorKind::TooLarge.into());
    }
    if !response.has_body() {
        return Ok(Vec::new());
    }
    let mut bytes: Vec<u8> = Vec::new();
    let mut total = 0.0_f64;
    loop {
        match response.read().await {
            Ok(None) => break,
            Ok(Some(chunk)) => {
                total += chunk.len() as f64;
                if total > max_bytes {
                    response.cancel();
                    return Err(DriveErrorKind::TooLarge.into());
                }
                bytes.extend_from_slice(&chunk);
            }
            Err(_) => return Err(DriveErrorKind::Network.into()),
        }
    }
    Ok(bytes)
}

/// `DriveApi`
#[derive(Clone)]
pub struct DriveApi {
    options: DriveApiOptions,
}

impl DriveApi {
    pub fn new(options: DriveApiOptions) -> DriveApi {
        DriveApi { options }
    }

    /// `call(url, init, signal, ms, send)`: the response, or the kind of
    /// error it stands for.
    async fn call(
        &self,
        rt: &Rt,
        url: &str,
        init: CallInit,
        signal: Option<&Signal>,
        ms: f64,
        send: Fetcher,
    ) -> Result<Response, DriveErrorKind> {
        let token = (self.options.token)(rt.clone(), signal.cloned()).await;
        let Some(token) = token.filter(|t| !t.is_empty()) else {
            return Err(DriveErrorKind::NotConnected);
        };
        let Some(headers) = with_authorization(&init.headers, &token) else {
            return Err(DriveErrorKind::Network);
        };
        let timer = timeout(rt, ms, signal);
        let request = Request {
            method: init.method.map(str::to_owned),
            headers,
            body: init.body,
            redirect: None,
        };
        let Ok(response) = rt.fetch(send, url, request, Some(&timer)).await else {
            return Err(DriveErrorKind::Network);
        };
        if !response.ok() {
            return Err(kind_of(&response).await.unwrap_or(DriveErrorKind::Network));
        }
        Ok(response)
    }

    /// `account(signal)`
    pub async fn account(&self, rt: &Rt, signal: Option<&Signal>) -> DriveResult<DriveAccount> {
        let res = self
            .call(
                rt,
                &format!("{DRIVE_API}/about?fields=user(displayName,emailAddress)"),
                CallInit::get(),
                signal,
                REQUEST_TIMEOUT_MS,
                self.options.fetch,
            )
            .await?;
        let body = response_json(&res)
            .await
            .unwrap_or_else(|_| JsonValue::Object(Obj::new()));
        let user = member(&body, "user")?;
        let read = |key: &str| -> Result<String, JsError> {
            Ok(match user.as_ref() {
                Some(user) if *user != JsonValue::Null => {
                    string_of(member(user, key)?).unwrap_or_default()
                }
                _ => String::new(),
            })
        };
        Ok(DriveAccount {
            display_name: read("displayName")?,
            email_address: read("emailAddress")?,
        })
    }

    /// `list(listing, options, signal)`
    pub async fn list(
        &self,
        rt: &Rt,
        listing: &DriveListing,
        options: &ListOptions,
        signal: Option<&Signal>,
    ) -> DriveResult<DriveList> {
        let (q, order_by) = listing_query(listing);
        let fields = format!("nextPageToken,files({FILE_FIELDS})");
        let page_size = number_to_string(math_min(
            math_max(options.page_size.unwrap_or(100.0), 1.0),
            1000.0,
        ));
        let mut pairs: Vec<(&str, &str)> = vec![
            ("q", q.as_str()),
            ("fields", fields.as_str()),
            ("pageSize", page_size.as_str()),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
            ("corpora", "user"),
        ];
        if !order_by.is_empty() {
            pairs.push(("orderBy", order_by.as_str()));
        }
        if let Some(token) = options.page_token.as_deref().filter(|t| !t.is_empty()) {
            pairs.push(("pageToken", token));
        }
        let res = self
            .call(
                rt,
                &format!("{DRIVE_API}/files?{}", query(&pairs)),
                CallInit::get(),
                signal,
                REQUEST_TIMEOUT_MS,
                self.options.fetch,
            )
            .await?;
        let body = response_json(&res)
            .await
            .unwrap_or_else(|_| JsonValue::Object(Obj::new()));
        // (body.files ?? []).map(fileFrom).filter(...)
        let raw = match member(&body, "files")? {
            None | Some(JsonValue::Null) => Vec::new(),
            Some(JsonValue::Array(items)) => items,
            Some(_) => {
                return Err(
                    JsError::type_error("(intermediate value).map is not a function").into(),
                );
            }
        };
        let mut files = Vec::new();
        for item in &raw {
            if let Some(file) = file_from(item)? {
                files.push(file);
            }
        }
        let next_page_token = string_of(member(&body, "nextPageToken")?);
        Ok(DriveList {
            files,
            next_page_token,
        })
    }

    /// `file(id, signal)`
    pub async fn file(&self, rt: &Rt, id: &str, signal: Option<&Signal>) -> DriveResult<DriveFile> {
        let params = query(&[("fields", FILE_FIELDS), ("supportsAllDrives", "true")]);
        let res = self
            .call(
                rt,
                &format!("{DRIVE_API}/files/{}?{params}", encode_uri_component(id)),
                CallInit::get(),
                signal,
                REQUEST_TIMEOUT_MS,
                self.options.fetch,
            )
            .await?;
        let body = response_json(&res)
            .await
            .unwrap_or_else(|_| JsonValue::Object(Obj::new()));
        match file_from(&body)? {
            Some(file) => Ok(file),
            None => Err(DriveErrorKind::Network.into()),
        }
    }

    /// `download(id, maxBytes, signal)`: a stored file's bytes, refusing past
    /// `maxBytes`.
    pub async fn download(
        &self,
        rt: &Rt,
        id: &str,
        max_bytes: f64,
        signal: Option<&Signal>,
    ) -> DriveResult<Vec<u8>> {
        let params = query(&[("alt", "media"), ("supportsAllDrives", "true")]);
        let res = self
            .call(
                rt,
                &format!("{DRIVE_API}/files/{}?{params}", encode_uri_component(id)),
                CallInit::get(),
                signal,
                TRANSFER_TIMEOUT_MS,
                self.options.download.unwrap_or(self.options.fetch),
            )
            .await?;
        read_capped(&res, max_bytes).await
    }

    /// `export(id, mime, maxBytes, signal)`: a Google document's bytes in
    /// another format.
    pub async fn export(
        &self,
        rt: &Rt,
        id: &str,
        mime: &str,
        max_bytes: f64,
        signal: Option<&Signal>,
    ) -> DriveResult<Vec<u8>> {
        let params = query(&[("mimeType", mime)]);
        let res = self
            .call(
                rt,
                &format!(
                    "{DRIVE_API}/files/{}/export?{params}",
                    encode_uri_component(id)
                ),
                CallInit::get(),
                signal,
                TRANSFER_TIMEOUT_MS,
                self.options.download.unwrap_or(self.options.fetch),
            )
            .await?;
        read_capped(&res, max_bytes).await
    }

    /// `upload(target, bytes, mime, signal)`: through a resumable session, in
    /// one piece.
    pub async fn upload(
        &self,
        rt: &Rt,
        target: &UploadTarget,
        bytes: &[u8],
        mime: &str,
        signal: Option<&Signal>,
    ) -> DriveResult<DriveFile> {
        let params = query(&[
            ("uploadType", "resumable"),
            ("supportsAllDrives", "true"),
            ("fields", FILE_FIELDS),
        ]);
        let (url, method, metadata) = match target {
            UploadTarget::Existing { id } => (
                format!(
                    "{DRIVE_UPLOAD_API}/files/{}?{params}",
                    encode_uri_component(id)
                ),
                "PATCH",
                object(Vec::new()),
            ),
            UploadTarget::New { name, parent_id } => {
                let mut entries = vec![("name", text(name.as_str()))];
                if let Some(parent) = parent_id.as_deref().filter(|p| !p.is_empty()) {
                    entries.push(("parents", JsonValue::Array(vec![text(parent)])));
                }
                (
                    format!("{DRIVE_UPLOAD_API}/files?{params}"),
                    "POST",
                    object(entries),
                )
            }
        };
        let start = self
            .call(
                rt,
                &url,
                CallInit {
                    method: Some(method),
                    headers: vec![
                        (
                            "Content-Type".to_owned(),
                            "application/json; charset=UTF-8".to_owned(),
                        ),
                        ("X-Upload-Content-Type".to_owned(), mime.to_owned()),
                        (
                            "X-Upload-Content-Length".to_owned(),
                            number_to_string(bytes.len() as f64),
                        ),
                    ],
                    body: Some(RequestBody::Text(json_stringify(&metadata))),
                },
                signal,
                REQUEST_TIMEOUT_MS,
                self.options.fetch,
            )
            .await?;
        let session = start.header("Location");
        // the session address must stay on Google's upload host before the bytes go to it
        let session = match session {
            Some(session) if session.starts_with(&format!("{DRIVE_UPLOAD_API}/")) => session,
            _ => return Err(DriveErrorKind::Network.into()),
        };
        let put = self
            .call(
                rt,
                &session,
                CallInit {
                    method: Some("PUT"),
                    headers: vec![("Content-Type".to_owned(), mime.to_owned())],
                    body: Some(RequestBody::Bytes(bytes.to_vec())),
                },
                signal,
                TRANSFER_TIMEOUT_MS,
                self.options.fetch,
            )
            .await?;
        let body = response_json(&put)
            .await
            .unwrap_or_else(|_| JsonValue::Object(Obj::new()));
        match file_from(&body)? {
            Some(file) => Ok(file),
            None => Err(DriveErrorKind::Network.into()),
        }
    }
}
