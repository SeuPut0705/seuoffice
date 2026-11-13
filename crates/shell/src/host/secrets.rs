//! Batch A's hosts (host/secrets.rs): Electron's `safeStorage` through the
//! keychain item and DPAPI key the Electron build made (decision 0033), and
//! the AI settings' codec over it.
//!
//! The key belongs to the name Electron had before ready: `seuoffice` for the
//! installed app (decision 0019); an unpackaged Electron run took the
//! product name of apps/shell/package.json, `SeuOffice`.

use std::sync::Arc;

use shell_contract::Hosts;
use shell_contract::runtime::{AppPaths, PathName};
use shell_ipc_a::secrets::{
    KeyPlace, OsSafeStorage, SafeStorageHost, SecretCodecHost, ShellSecretCodec,
};

use super::HostContext;
use crate::paths::ShellPaths;

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
    hosts.insert(storage);
    hosts.insert(codec);
}
