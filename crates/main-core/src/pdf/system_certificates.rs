//! `apps/pdf/src/main/system-certificates.ts`: certificates that live in the
//! operating system's own stores (the NSS database Chrome and Firefox use on
//! Linux, the Windows personal store). A chosen identity is exported through
//! the platform's own tool into a PKCS#12 protected by a random one-time
//! password and kept in memory only, or (Windows) signs in place.
//!
//! What the TypeScript takes from Node and from other modules is the caller's
//! here:
//!
//! - the command runner (`Runner`) is a closure; [`run_command`] is the one
//!   the product uses;
//! - `new X509Certificate(...)` and `describeCertificate` (`pdf-signatures.ts`)
//!   are a [`CertificateReader`];
//! - `env.now()` is a closure of milliseconds;
//! - an in-place signer (`ExternalSigner`) is an [`InPlaceSigner`] the caller
//!   asks to sign with the same environment.

use super::child::{Ended, capture};
use super::font_locate::{Platform, read_names};
use super::node_io::{
    base64url_encode, random_bytes, read_file_bytes, rm_recursive_force, tmpdir, write_file_mode,
};
use crate::node_fs::NodeError;
use icu_collator::Collator;
use icu_collator::options::CollatorOptions;
use jscompat::node_path::host;
use jscompat::{JsonSyntaxError, JsonValue, date_parse, js_regex, json_parse, trim, try_js_regex};
use std::fs;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SystemCertificateRef {
    Nss { dir: String, nickname: String },
    Windows { thumbprint: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct SystemCertificate {
    pub reference: SystemCertificateRef,
    pub label: String,
    pub common_name: String,
    pub issuer_common_name: String,
    /// ISO 8601
    pub valid_to: String,
    pub expired: bool,
}

/// Why part of a store could not be read, so the UI can say what to do about it
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemStoreIssue {
    NssToolsMissing,
    StoreLocked,
    PlatformUnsupported,
}

impl SystemStoreIssue {
    pub fn as_str(self) -> &'static str {
        match self {
            SystemStoreIssue::NssToolsMissing => "nss-tools-missing",
            SystemStoreIssue::StoreLocked => "store-locked",
            SystemStoreIssue::PlatformUnsupported => "platform-unsupported",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SystemCertificateListing {
    pub certs: Vec<SystemCertificate>,
    pub issues: Vec<SystemStoreIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportedIdentity {
    pub p12: Vec<u8>,
    pub password: String,
}

/// `class SystemStoreError extends Error`: `message` and `code` are the code
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemStoreError {
    pub code: String,
}

impl SystemStoreError {
    pub fn new(code: &str) -> Self {
        SystemStoreError {
            code: code.to_owned(),
        }
    }
}

/// What the functions throw
#[derive(Debug, Clone, PartialEq)]
pub enum Thrown {
    Store(SystemStoreError),
    Node(NodeError),
    /// `JSON.parse` of the tool's output: the V8 message
    JsonSyntax(String),
    /// a regular expression search past the backtrack bound (V8: `RangeError`)
    RegexLimit,
}

impl From<SystemStoreError> for Thrown {
    fn from(e: SystemStoreError) -> Self {
        Thrown::Store(e)
    }
}

impl From<NodeError> for Thrown {
    fn from(e: NodeError) -> Self {
        Thrown::Node(e)
    }
}

/// `RunResult`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// The executable does not exist on this machine
    pub missing: bool,
}

/// `Runner`: `file`, `args`, and the variables added to the environment
pub type Runner<'a> = &'a dyn Fn(&str, &[String], Option<&[(String, String)]>) -> RunResult;

const COMMAND_TIMEOUT_MS: u64 = 60_000;

/// execFile only: arguments never pass through a shell
pub fn run_command(file: &str, args: &[String], env: Option<&[(String, String)]>) -> RunResult {
    let run = capture(
        file,
        args,
        env.unwrap_or(&[]),
        None,
        Duration::from_millis(COMMAND_TIMEOUT_MS),
        16 * 1024 * 1024,
    );
    let code = match run.ended {
        Ended::Exited(Some(code)) => code,
        Ended::Exited(None) | Ended::TimedOut | Ended::OutputTooLong | Ended::SpawnFailed => 1,
        Ended::NotFound => 1,
    };
    RunResult {
        code,
        stdout: String::from_utf8_lossy(&run.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&run.stderr).into_owned(),
        missing: run.ended == Ended::NotFound,
    }
}

/// What `new X509Certificate(input)` and `describeCertificate(cert)` give, as
/// far as this module reads it
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertSummary {
    pub common_name: String,
    pub issuer_common_name: String,
    /// ISO 8601
    pub valid_to: String,
    /// `cert.publicKey.asymmetricKeyType === 'rsa'`
    pub is_rsa: bool,
}

pub trait CertificateReader {
    /// PEM text (NSS) or DER (Windows); `None` is a certificate that does not
    /// parse or does not describe (the TypeScript throws)
    fn read(&self, input: &[u8]) -> Option<CertSummary>;
}

pub struct SystemStoreEnv<'a> {
    pub platform: Platform,
    pub home: &'a str,
    pub run: Runner<'a>,
    /// `now()`, in milliseconds since the epoch
    pub now: &'a dyn Fn() -> f64,
    pub certificates: &'a dyn CertificateReader,
}

/// What a chosen system identity signs with: an exported PKCS#12, or the OS store itself
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SystemIdentity {
    P12(ExportedIdentity),
    InPlace(InPlaceSigner),
}

/// `ExternalSigner` of the Windows store
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InPlaceSigner {
    pub chain_der: Vec<Vec<u8>>,
    thumbprint: String,
}

/// Scratch directory readable by this user only, removed when `work` settles
fn with_private_dir<T>(work: impl FnOnce(&str) -> Result<T, Thrown>) -> Result<T, Thrown> {
    let dir = crate::node_fs::mkdtemp_random(&host::join(&[&tmpdir(), "seuoffice-cert-"]))?;
    let result = work(&dir);
    rm_recursive_force(&dir)?;
    result
}

fn new_password() -> String {
    base64url_encode(&random_bytes(18))
}

fn to_listed(
    reference: SystemCertificateRef,
    label: &str,
    summary: &CertSummary,
    now: f64,
) -> SystemCertificate {
    SystemCertificate {
        reference,
        label: label.to_owned(),
        common_name: summary.common_name.clone(),
        issuer_common_name: summary.issuer_common_name.clone(),
        valid_to: summary.valid_to.clone(),
        expired: date_parse(&summary.valid_to) < now,
    }
}

// ---- Linux: NSS -------------------------------------------------------------

/// Databases worth looking at: the shared one Chrome uses, plus Firefox profiles
pub fn nss_database_dirs(home: &str) -> Vec<String> {
    let mut dirs = vec![host::join(&[home, ".pki", "nssdb"])];
    let profile_roots = [
        host::join(&[home, ".mozilla", "firefox"]),
        host::join(&[home, "snap", "firefox", "common", ".mozilla", "firefox"]),
        host::join(&[
            home,
            ".var",
            "app",
            "org.mozilla.firefox",
            ".mozilla",
            "firefox",
        ]),
    ];
    for root in &profile_roots {
        // the browser is not installed that way
        let Some(names) = read_names(root) else {
            continue;
        };
        for name in names {
            let full = host::join(&[root, &name]);
            if fs::symlink_metadata(&full).is_ok_and(|m| m.is_dir()) {
                dirs.push(full);
            }
        }
    }
    dirs.into_iter()
        .filter(|dir| fs::metadata(host::join(&[dir, "cert9.db"])).is_ok())
        .collect()
}

/// `certutil -K` lines: `< 0> rsa  <key id>  <nickname>`; only RSA keys can sign here
pub fn parse_nss_key_list(output: &str) -> Result<Vec<String>, Thrown> {
    let re = try_js_regex!(r"^<\s*\d+>\s+(\S+)\s+[0-9a-fA-F]{8,}\s+(.+?)\s*$");
    let mut nicknames = Vec::new();
    for line in output.split('\n') {
        let found = re.try_exec(line).map_err(|_| Thrown::RegexLimit)?;
        if let Some(m) = found
            && m.get(1) == Some("rsa")
        {
            nicknames.push(m.get(2).unwrap_or_default().to_owned());
        }
    }
    Ok(nicknames)
}

fn looks_locked(stderr: &str) -> bool {
    js_regex!(
        r"password|login|authentication|SEC_ERROR_BAD_PASSWORD|token",
        "i"
    )
    .test(stderr)
}

fn list_nss(
    env: &SystemStoreEnv<'_>,
    store_password: Option<&str>,
) -> Result<SystemCertificateListing, Thrown> {
    let mut out = SystemCertificateListing {
        certs: Vec::new(),
        issues: Vec::new(),
    };
    let dirs = nss_database_dirs(env.home);
    if dirs.is_empty() {
        return Ok(out);
    }
    with_private_dir(|scratch| {
        let mut pw_args: Vec<String> = Vec::new();
        if let Some(password) = store_password.filter(|p| !p.is_empty()) {
            let file = host::join(&[scratch, "store-pw"]);
            write_file_mode(&file, &format!("{password}\n"), 0o600)?;
            pw_args.push("-f".to_owned());
            pw_args.push(file);
        }
        for dir in &dirs {
            let db = format!("sql:{dir}");
            let mut key_args = vec!["-K".to_owned(), "-d".to_owned(), db.clone()];
            key_args.extend(pw_args.iter().cloned());
            let keys = (env.run)("certutil", &key_args, None);
            if keys.missing {
                out.issues.push(SystemStoreIssue::NssToolsMissing);
                return Ok(());
            }
            if keys.code != 0 {
                if looks_locked(&keys.stderr) {
                    out.issues.push(SystemStoreIssue::StoreLocked);
                }
                continue;
            }
            for nickname in parse_nss_key_list(&keys.stdout)? {
                let mut list_args = vec![
                    "-L".to_owned(),
                    "-d".to_owned(),
                    db.clone(),
                    "-n".to_owned(),
                    nickname.clone(),
                    "-a".to_owned(),
                ];
                list_args.extend(pw_args.iter().cloned());
                let pem = (env.run)("certutil", &list_args, None);
                if pem.code != 0 {
                    continue;
                }
                // a nickname that is not an X.509 certificate is not a signing identity
                if let Some(summary) = env.certificates.read(pem.stdout.as_bytes()) {
                    out.certs.push(to_listed(
                        SystemCertificateRef::Nss {
                            dir: dir.clone(),
                            nickname: nickname.clone(),
                        },
                        &nickname,
                        &summary,
                        (env.now)(),
                    ));
                }
            }
        }
        Ok(())
    })?;
    Ok(out)
}

fn export_nss(
    env: &SystemStoreEnv<'_>,
    dir: &str,
    nickname: &str,
    store_password: Option<&str>,
) -> Result<ExportedIdentity, Thrown> {
    let password = new_password();
    with_private_dir(|scratch| {
        let out = host::join(&[scratch, "identity.p12"]);
        let export_pw = host::join(&[scratch, "export-pw"]);
        write_file_mode(&export_pw, &format!("{password}\n"), 0o600)?;
        let mut args: Vec<String> = vec![
            "-o".to_owned(),
            out.clone(),
            "-d".to_owned(),
            format!("sql:{dir}"),
            "-n".to_owned(),
            nickname.to_owned(),
            "-w".to_owned(),
            export_pw,
        ];
        if let Some(store_password) = store_password.filter(|p| !p.is_empty()) {
            let store_pw = host::join(&[scratch, "store-pw"]);
            write_file_mode(&store_pw, &format!("{store_password}\n"), 0o600)?;
            args.push("-k".to_owned());
            args.push(store_pw);
        }
        let result = (env.run)("pk12util", &args, None);
        if result.missing {
            return Err(SystemStoreError::new("cert-store-tool-missing").into());
        }
        if result.code != 0 {
            return Err(SystemStoreError::new(if looks_locked(&result.stderr) {
                "cert-store-locked"
            } else {
                "cert-not-exportable"
            })
            .into());
        }
        Ok(ExportedIdentity {
            p12: read_file_bytes(&out)?,
            password: password.clone(),
        })
    })
}

// ---- Windows: personal store --------------------------------------------------

pub const WINDOWS_LIST_SCRIPT: &str = concat!(
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ",
    "@(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.HasPrivateKey } | ForEach-Object { [pscustomobject]@{ ",
    "Thumbprint = $_.Thumbprint; Subject = $_.Subject; Der = ([Convert]::ToBase64String($_.RawData)) } }) | ConvertTo-Json -Compress"
);

/// Signer first, then the rest of the chain Windows can build; no revocation lookups
pub const WINDOWS_CHAIN_SCRIPT: &str = concat!(
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ",
    "$ErrorActionPreference = 'Stop'; ",
    "$c = Get-Item ('Cert:\\CurrentUser\\My\\' + $env:SEUOFFICE_THUMBPRINT); ",
    "$chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain; ",
    "$chain.ChainPolicy.RevocationMode = 'NoCheck'; [void]$chain.Build($c); ",
    "$certs = @($c) + @($chain.ChainElements | ForEach-Object { $_.Certificate } | Select-Object -Skip 1); ",
    "@($certs | ForEach-Object { [Convert]::ToBase64String($_.RawData) }) | ConvertTo-Json -Compress"
);

/// The private key stays in the store: Windows signs the digest and returns only the signature
pub const WINDOWS_SIGN_SCRIPT: &str = concat!(
    "$ErrorActionPreference = 'Stop'; ",
    "$c = Get-Item ('Cert:\\CurrentUser\\My\\' + $env:SEUOFFICE_THUMBPRINT); ",
    "$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c); ",
    "if (-not $rsa) { throw 'no RSA private key' } ",
    "$hex = $env:SEUOFFICE_DIGEST; ",
    "$hash = [byte[]]::new($hex.Length / 2); ",
    "for ($i = 0; $i -lt $hash.Length; $i++) { $hash[$i] = [Convert]::ToByte($hex.Substring(2 * $i, 2), 16) } ",
    "[Convert]::ToBase64String($rsa.SignHash($hash, ",
    "[System.Security.Cryptography.HashAlgorithmName]::SHA256, ",
    "[System.Security.Cryptography.RSASignaturePadding]::Pkcs1))"
);

fn is_thumbprint(text: &str) -> bool {
    js_regex!(r"^[0-9A-Fa-f]{40}$").test(text)
}

/// `Array.isArray(parsed) ? parsed : [parsed]`
fn rows_of(parsed: JsonValue) -> Vec<JsonValue> {
    match parsed {
        JsonValue::Array(rows) => rows,
        other => vec![other],
    }
}

/// `json.replace(/^\uFEFF/, '').trim()`
fn json_text(json: &str) -> &str {
    trim(json.strip_prefix('\u{feff}').unwrap_or(json))
}

/// `{ thumbprint, der }`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsCertificate {
    pub thumbprint: String,
    pub der: Vec<u8>,
}

fn json_syntax(error: &JsonSyntaxError) -> Thrown {
    Thrown::JsonSyntax(error.message().to_owned())
}

pub fn parse_windows_certificates(json: &str) -> Result<Vec<WindowsCertificate>, Thrown> {
    let text = json_text(json);
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let parsed = json_parse(text).map_err(|error| json_syntax(&error))?;
    let mut out = Vec::new();
    for row in rows_of(parsed) {
        let thumbprint = row.get("Thumbprint");
        let der = row.get("Der");
        if let (Some(JsonValue::String(thumbprint)), Some(JsonValue::String(der))) =
            (thumbprint.as_deref(), der.as_deref())
            && is_thumbprint(thumbprint)
        {
            out.push(WindowsCertificate {
                thumbprint: thumbprint.to_uppercase(),
                der: jscompat::buffer_from_base64(der),
            });
        }
    }
    Ok(out)
}

fn list_windows(env: &SystemStoreEnv<'_>) -> Result<SystemCertificateListing, Thrown> {
    let mut out = SystemCertificateListing {
        certs: Vec::new(),
        issues: Vec::new(),
    };
    let args = [
        "-NoProfile".to_owned(),
        "-NonInteractive".to_owned(),
        "-Command".to_owned(),
        WINDOWS_LIST_SCRIPT.to_owned(),
    ];
    let result = (env.run)("powershell.exe", &args, None);
    if result.code != 0 {
        return Ok(out);
    }
    for row in parse_windows_certificates(&result.stdout)? {
        // skip entries that are not plain X.509
        let Some(summary) = env.certificates.read(&row.der) else {
            continue;
        };
        if !summary.is_rsa {
            continue;
        }
        out.certs.push(to_listed(
            SystemCertificateRef::Windows {
                thumbprint: row.thumbprint,
            },
            &summary.common_name,
            &summary,
            (env.now)(),
        ));
    }
    Ok(out)
}

pub fn parse_windows_chain(json: &str) -> Result<Vec<Vec<u8>>, Thrown> {
    let text = json_text(json);
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let parsed = json_parse(text).map_err(|error| json_syntax(&error))?;
    Ok(rows_of(parsed)
        .into_iter()
        .filter_map(|row| match row {
            JsonValue::String(b64) => Some(jscompat::buffer_from_base64(&b64)),
            _ => None,
        })
        .collect())
}

fn powershell_args(script: &str) -> [String; 4] {
    [
        "-NoProfile".to_owned(),
        "-NonInteractive".to_owned(),
        "-Command".to_owned(),
        script.to_owned(),
    ]
}

fn open_windows_signer(
    env: &SystemStoreEnv<'_>,
    thumbprint: &str,
) -> Result<SystemIdentity, SystemStoreError> {
    if !is_thumbprint(thumbprint) {
        return Err(SystemStoreError::new("cert-invalid"));
    }
    let thumbprint_env = [("SEUOFFICE_THUMBPRINT".to_owned(), thumbprint.to_owned())];
    let result = (env.run)(
        "powershell.exe",
        &powershell_args(WINDOWS_CHAIN_SCRIPT),
        Some(&thumbprint_env),
    );
    if result.missing {
        return Err(SystemStoreError::new("cert-store-tool-missing"));
    }
    if result.code != 0 {
        return Err(SystemStoreError::new("cert-invalid"));
    }
    let chain_der =
        parse_windows_chain(&result.stdout).map_err(|_| SystemStoreError::new("cert-invalid"))?;
    if chain_der.is_empty() {
        return Err(SystemStoreError::new("cert-invalid"));
    }
    Ok(SystemIdentity::InPlace(InPlaceSigner {
        chain_der,
        thumbprint: thumbprint.to_owned(),
    }))
}

impl InPlaceSigner {
    /// `signer.signDigest(digest)`
    pub fn sign_digest(
        &self,
        env: &SystemStoreEnv<'_>,
        digest: &[u8],
    ) -> Result<Vec<u8>, SystemStoreError> {
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        let signed_env = [
            ("SEUOFFICE_THUMBPRINT".to_owned(), self.thumbprint.clone()),
            ("SEUOFFICE_DIGEST".to_owned(), hex),
        ];
        let signed = (env.run)(
            "powershell.exe",
            &powershell_args(WINDOWS_SIGN_SCRIPT),
            Some(&signed_env),
        );
        if signed.missing {
            return Err(SystemStoreError::new("cert-store-tool-missing"));
        }
        let signature = jscompat::buffer_from_base64(trim(&signed.stdout));
        if signed.code != 0 || signature.is_empty() {
            return Err(SystemStoreError::new("cert-not-exportable"));
        }
        Ok(signature)
    }
}

// ---- entry points -------------------------------------------------------------

pub fn list_system_certificates(
    store_password: Option<&str>,
    env: &SystemStoreEnv<'_>,
) -> Result<SystemCertificateListing, Thrown> {
    if env.platform == Platform::Darwin {
        return Ok(SystemCertificateListing {
            certs: Vec::new(),
            issues: vec![SystemStoreIssue::PlatformUnsupported],
        });
    }
    let mut listing = if env.platform == Platform::Win32 {
        list_windows(env)?
    } else {
        list_nss(env, store_password)?
    };
    // `a.label.localeCompare(b.label)` under the root collation
    let collator = Collator::try_new(Default::default(), CollatorOptions::default())
        .expect("the compiled root collation");
    listing.certs.sort_by(|a, b| {
        u8::from(a.expired)
            .cmp(&u8::from(b.expired))
            .then_with(|| collator.compare(&a.label, &b.label))
    });
    Ok(listing)
}

pub fn open_system_signer(
    reference: &SystemCertificateRef,
    store_password: Option<&str>,
    env: &SystemStoreEnv<'_>,
) -> Result<SystemIdentity, Thrown> {
    if env.platform == Platform::Darwin {
        return Err(SystemStoreError::new("cert-store-unsupported").into());
    }
    match reference {
        SystemCertificateRef::Nss { dir, nickname } => {
            export_nss(env, dir, nickname, store_password).map(SystemIdentity::P12)
        }
        SystemCertificateRef::Windows { thumbprint } => {
            open_windows_signer(env, thumbprint).map_err(Thrown::from)
        }
    }
}
