//! Batch A's hosts (host/secrets.rs): Electron's `safeStorage` through the
//! keychain item and DPAPI key the Electron build made (decision 0033), and
//! the AI settings' codec over it.
//!
//! The key belongs to the name Electron had before ready: `seuoffice` for the
//! installed app (decision 0019); an unpackaged Electron run took the
//! product name of apps/shell/package.json, `SeuOffice`.

use std::sync::{Arc, OnceLock};

use shell_contract::Hosts;
use shell_contract::runtime::{AppPaths, PathName};
use shell_ipc_a::secrets::{
    KeyPlace, OsSafeStorage, SafeStorageHost, SecretCodecHost, ShellSecretCodec,
};

use super::HostContext;
use crate::paths::ShellPaths;

/// The codec, for the shell's own stand-ins that hand it out (the home
/// screen's settings in `unbuilt.rs`), which are installed before this file
pub(super) static CODEC: OnceLock<SecretCodecHost> = OnceLock::new();

/// `app.getName()` when Electron fixed the keychain item
const KEY_APP_NAME: &str = if cfg!(debug_assertions) {
    "SeuOffice"
} else {
    "seuoffice"
};

pub fn install(hosts: &mut Hosts, _cx: &HostContext) {
    let storage: SafeStorageHost = Arc::new(OsSafeStorage::new(KeyPlace {
        app_name: KEY_APP_NAME.to_owned(),
        user_data: ShellPaths::new().path(PathName::UserData),
    }));
    let codec: SecretCodecHost = Arc::new(ShellSecretCodec::new(storage.clone()));
    let _ = CODEC.set(codec.clone());
    hosts.insert(storage);
    hosts.insert(codec);
}

// The shell's tests build batch A with its probe fakes: the storage the shell
// makes in a test has no key, so no test reads the person's keychain item
#[cfg(test)]
const _: () = assert!(!shell_ipc_a::secrets::OS_KEY_STORE);
