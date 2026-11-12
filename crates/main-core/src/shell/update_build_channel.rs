//! `apps/shell/src/main/update-build-channel.ts`.

use std::fs;

use jscompat::js_regex;
use jscompat::node_path::host::join;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildUpdateChannel {
    Latest,
    Stable,
}

impl BuildUpdateChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            BuildUpdateChannel::Latest => "latest",
            BuildUpdateChannel::Stable => "stable",
        }
    }
}

/// `buildChannelFromAppUpdateYml`
pub fn build_channel_from_app_update_yml(text: &str) -> BuildUpdateChannel {
    let channel = js_regex!(r#"^channel:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$"#, "m")
        .exec(text)
        .and_then(|m| m.get(1));
    if channel == Some("latest") {
        BuildUpdateChannel::Latest
    } else {
        BuildUpdateChannel::Stable
    }
}

/// `packagedUpdateChannel`; `resources_dir` is `process.resourcesPath`.
pub fn packaged_update_channel(resources_dir: &str) -> BuildUpdateChannel {
    match fs::read(join(&[resources_dir, "app-update.yml"])) {
        Ok(bytes) => build_channel_from_app_update_yml(&String::from_utf8_lossy(&bytes)),
        Err(_) => BuildUpdateChannel::Stable,
    }
}
