//! `apps/shell/src/main/drive/drive-vault.ts`: whether the operating system's
//! encryption really protects the Drive token here. (`createDriveVault`, the
//! file store, is not on the MCP modules' path and is not ported here.)

use crate::shell::ai_secrets::{SafeStorageLike, linux_keyring_seals};

/// `driveTokenSeals(storage, platform)`: whether safeStorage really protects
/// the Drive token here. Windows (DPAPI) and macOS (the keychain) do. On
/// Linux without a keyring Chromium reports encryption as available but uses
/// `basic_text`, a key built into the program, so the token would only look
/// sealed: that counts as no encryption. `platform` is `process.platform`.
pub fn drive_token_seals(storage: &dyn SafeStorageLike, platform: &str) -> bool {
    if !storage.is_encryption_available() {
        return false;
    }
    if platform == "linux" {
        return linux_keyring_seals(storage);
    }
    true
}
