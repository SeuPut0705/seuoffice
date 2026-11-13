//! Quick Look's home-side settings: `quick-look:get-settings` and
//! `quick-look:set-settings` (`apps/shell/src/main/quick-look/quick-look-window.ts`
//! `registerIpc`, wired in `apps/shell/src/main/index.ts` `configureQuickLookWindow`).

use std::sync::Arc;

use jscompat::{JsObject, JsonValue};
use main_core::shell::app_settings::{read_app_settings, write_app_setting};
use shell_contract::ipc::{ChannelKind, RegisterError, Registry};
use shell_contract::runtime::{PathName, Services};
use shell_contract::{Batch, IpcValue};

use crate::convert::{field, node_error};
use crate::handle;

/// What the Windows Explorer hook and the tray do when the settings change
/// (`syncQuickLookRuntime`); nothing on macOS
pub trait QuickLookRuntime: Send + Sync {
    fn sync(&self, settings: &QuickLookSettings);
}

pub type QuickLookHost = Arc<dyn QuickLookRuntime>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuickLookSettings {
    pub explorer_space_preview: bool,
    pub keep_in_tray: bool,
}

/// `DEFAULT_QUICK_LOOK_SETTINGS`
const DEFAULT: QuickLookSettings = QuickLookSettings {
    explorer_space_preview: true,
    keep_in_tray: false,
};

impl QuickLookSettings {
    fn to_ipc(self) -> IpcValue {
        IpcValue::Object(vec![
            (
                "explorerSpacePreview".into(),
                IpcValue::Bool(self.explorer_space_preview),
            ),
            ("keepInTray".into(), IpcValue::Bool(self.keep_in_tray)),
        ])
    }

    fn to_json(self) -> JsonValue {
        let mut o = JsObject::default();
        o.set(
            "explorerSpacePreview",
            JsonValue::Bool(self.explorer_space_preview),
        );
        o.set("keepInTray", JsonValue::Bool(self.keep_in_tray));
        JsonValue::Object(o)
    }
}

/// `normalizeQuickLookSettings(raw)` of the saved value
fn normalize(raw: Option<&JsonValue>) -> QuickLookSettings {
    let Some(JsonValue::Object(o)) = raw else {
        return DEFAULT;
    };
    let flag = |key: &str, default: bool| match o.get(key) {
        Some(JsonValue::Bool(b)) => *b,
        _ => default,
    };
    QuickLookSettings {
        explorer_space_preview: flag("explorerSpacePreview", DEFAULT.explorer_space_preview),
        keep_in_tray: flag("keepInTray", DEFAULT.keep_in_tray),
    }
}

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let runtime: QuickLookHost = services.hosts.need(Batch::W)?;
    let settings_path = services
        .paths
        .path(PathName::UserData)
        .join("app-settings.json")
        .to_string_lossy()
        .into_owned();

    let path = settings_path.clone();
    let read = move || normalize(read_app_settings(&path).get("quickLook"));

    let get = read.clone();
    handle(
        registry,
        "quick-look:get-settings",
        ChannelKind::Invoke,
        move |_, _| Ok(get().to_ipc()),
    )?;

    handle(
        registry,
        "quick-look:set-settings",
        ChannelKind::Invoke,
        move |_, args| {
            let current = read();
            // `partial && typeof partial === 'object'`: an array passes, null does not
            let partial = args.first().filter(|p| {
                matches!(
                    p,
                    IpcValue::Object(_)
                        | IpcValue::Array(_)
                        | IpcValue::Bytes(..)
                        | IpcValue::Date(_)
                )
            });
            let flag = |key: &str, current: bool| match partial.and_then(|p| field(p, key)) {
                Some(IpcValue::Bool(b)) => *b,
                _ => current,
            };
            let next = QuickLookSettings {
                explorer_space_preview: flag(
                    "explorerSpacePreview",
                    current.explorer_space_preview,
                ),
                keep_in_tray: flag("keepInTray", current.keep_in_tray),
            };
            write_app_setting(&settings_path, "quickLook", Some(next.to_json()))
                .map_err(node_error)?;
            runtime.sync(&next);
            Ok(next.to_ipc())
        },
    )
}

/// The Explorer hook and the tray are Windows-only; the comparison runs
/// where `syncQuickLookRuntime` does nothing
#[cfg(feature = "probe")]
struct NoRuntime;

#[cfg(feature = "probe")]
impl QuickLookRuntime for NoRuntime {
    fn sync(&self, _: &QuickLookSettings) {}
}

#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, _case: &serde_json::Value) {
    let runtime: QuickLookHost = Arc::new(NoRuntime);
    hosts.insert(runtime);
}
