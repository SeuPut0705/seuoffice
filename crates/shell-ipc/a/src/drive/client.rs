//! What `packages/google-drive` (connection.ts, drive-api.ts, oauth.ts,
//! formats.ts) gives the shell's Drive module. It is not in `main-core` on
//! this branch (stage 2 ports it as `main_core::packages::google_drive`), so
//! the module reaches it through [`DriveClient`]. Each method is named after
//! the TypeScript call it replaces and blocks: the module calls it on a
//! worker, never on the core thread.

use std::sync::Arc;

/// `FOLDER_MIME`
pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
/// `MAX_READ_BYTES`: what the AI and attachments may download
pub const MAX_READ_BYTES: usize = 30 * 1024 * 1024;
/// `MAX_OPEN_BYTES`: what opening a file may download
pub const MAX_OPEN_BYTES: usize = 300 * 1024 * 1024;

/// `DriveFile`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    /// ISO time
    pub modified_time: String,
    /// bytes; none for Google's own documents and folders
    pub size: Option<u64>,
    /// content hash of a stored file; none for Google's own documents
    pub md5_checksum: Option<String>,
    pub parents: Vec<String>,
    /// the account may change the file's content
    pub can_edit: bool,
    /// a shortcut's target, when this entry is a shortcut
    pub shortcut_target: Option<ShortcutTarget>,
}

/// `DriveFile.shortcutTarget`
#[derive(Clone, Debug, PartialEq)]
pub struct ShortcutTarget {
    pub id: String,
    pub mime_type: String,
}

/// `DriveAccount`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DriveAccount {
    pub display_name: String,
    pub email_address: String,
}

/// `DriveError['kind']`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriveError {
    NotConnected,
    NotFound,
    Forbidden,
    TooLarge,
    RateLimit,
    Network,
}

impl DriveError {
    pub fn kind(self) -> &'static str {
        match self {
            DriveError::NotConnected => "not-connected",
            DriveError::NotFound => "not-found",
            DriveError::Forbidden => "forbidden",
            DriveError::TooLarge => "too-large",
            DriveError::RateLimit => "rate-limit",
            DriveError::Network => "network",
        }
    }
}

/// `DriveResult<T>`
pub type DriveResult<T> = Result<T, DriveError>;

/// `DriveListing`
#[derive(Clone, Debug, PartialEq)]
pub enum Listing {
    Recent,
    Search(String),
}

/// What `DriveApi.list` answers
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ListPage {
    pub files: Vec<DriveFile>,
    pub next_page_token: Option<String>,
}

/// `DriveApi.upload`'s first argument
#[derive(Clone, Debug, PartialEq)]
pub enum UploadTarget {
    /// replace this file's content, keeping its id
    Existing(String),
    /// make a new file, in `parent_id` when given
    New {
        name: String,
        parent_id: Option<String>,
    },
}

/// `OpenPlan`
#[derive(Clone, Debug, PartialEq)]
pub enum OpenPlan {
    Download { extension: String },
    Export { mime: String, extension: String },
    None,
}

/// `DriveConnectionState`
#[derive(Clone, Debug, PartialEq)]
pub enum ConnectionState {
    Unavailable,
    Disconnected {
        expired: bool,
    },
    Connected {
        account: Option<DriveAccount>,
        persisted: bool,
    },
}

/// `GoogleSignInFailure | 'unavailable'`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignInFailure {
    Cancelled,
    Timeout,
    Denied,
    Scope,
    Network,
    Unavailable,
}

/// The page the browser shows once it is back on this PC (`SignInPage`)
#[derive(Clone, Debug, PartialEq)]
pub struct SignInPage {
    pub lang: String,
    pub title: String,
    pub body: String,
}

/// `Pick<GoogleSignInOptions, 'openBrowser' | 'pages'>`
#[derive(Clone)]
pub struct BrowserRound {
    /// opens Google's page in the system browser; false when it could not
    /// (`openBrowser`). Safe to call from any thread.
    pub open_browser: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// `pages.done`
    pub done: SignInPage,
    /// `pages.failed`
    pub failed: SignInPage,
}

/// The Drive connection, its API and its formats
pub trait DriveClient: Send + Sync {
    /// `connection.state()`: in memory, never blocks
    fn state(&self) -> ConnectionState;
    /// `connection.connected()`: in memory, never blocks
    fn connected(&self) -> bool;
    /// `await connection.load()`: reads the kept token once
    fn load(&self);
    /// `connection.onChange(listener)`: `listener` runs on whichever thread
    /// changed the connection
    fn on_change(&self, listener: Arc<dyn Fn() + Send + Sync>);
    /// `connection.connect(options)`: the browser sign-in
    fn connect(&self, round: &BrowserRound) -> Result<(), SignInFailure>;
    /// `connection.pick(options, multiple)`: the ids of the picked files
    fn pick(&self, round: &BrowserRound, multiple: bool) -> Result<Vec<String>, SignInFailure>;
    /// `connection.cancelConnect()`: in memory, never blocks; the waiting
    /// `connect` or `pick` then fails `Cancelled`
    fn cancel_connect(&self);
    /// `await connection.disconnect()`: forget, clear the vault, revoke
    fn disconnect(&self);

    /// `connection.api.list(listing, { pageToken, pageSize })`
    fn list(
        &self,
        listing: &Listing,
        page_token: Option<&str>,
        page_size: Option<u32>,
    ) -> DriveResult<ListPage>;
    /// `connection.api.file(id)`
    fn file(&self, id: &str) -> DriveResult<DriveFile>;
    /// `connection.api.download(id, maxBytes)`
    fn download(&self, id: &str, max_bytes: usize) -> DriveResult<Vec<u8>>;
    /// `connection.api.export(id, mime, maxBytes)`
    fn export(&self, id: &str, mime: &str, max_bytes: usize) -> DriveResult<Vec<u8>>;
    /// `connection.api.upload(target, bytes, mime)`
    fn upload(&self, target: &UploadTarget, bytes: &[u8], mime: &str) -> DriveResult<DriveFile>;

    /// `openPlan({ name, mimeType })`
    fn open_plan(&self, name: &str, mime_type: &str) -> OpenPlan;
    /// `isGoogleNative(mimeType)`
    fn is_google_native(&self, mime_type: &str) -> bool;
    /// `localFileName(driveName, extension)`
    fn local_file_name(&self, drive_name: &str, extension: &str) -> String;
    /// `officeCopyName(driveName, extension)`
    fn office_copy_name(&self, drive_name: &str, extension: &str) -> String;
    /// `uploadMime(name)`
    fn upload_mime(&self, name: &str) -> String;
}

pub type DriveClientHost = Arc<dyn DriveClient>;
