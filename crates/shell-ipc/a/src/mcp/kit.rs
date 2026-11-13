//! The host of the MCP runtime kit (`runtimes.ts`): the permission a person
//! gave to download a runtime, the download itself, uv.
//!
//! One implementation serves both places the kit runs: on the core thread for
//! the hub's `plannedLaunch` (which only looks, never downloads) and on a
//! connection's thread or a worker for a launch that may download.

use std::process::{Command, Stdio};

use jscompat::JsObject;
use main_core::node_fs::NodeError;
use main_core::packages::mcp_sdk::client::net::{FetchInit, Redirect};
use main_core::shell::mcp_client::hub::SharedStore;
use main_core::shell::mcp_client::hub_app::{is_runtime_allowed, record_runtime_allowed};
use main_core::shell::mcp_client::local_launch::McpRuntimeId;
use main_core::shell::mcp_client::runtime_archive::{RuntimeFetch, RuntimeResponse};
use main_core::shell::mcp_client::runtimes::{
    RuntimeDownloadQuestion, RuntimeKitHost, UvRunResult, rename_path,
};

use super::actor::CoreLink;
use super::net::{McpNetHost, NetBody};

/// Where `runtimes[id].allowed` lives: the store of the hub
trait Allowed {
    fn is_allowed(&self, id: McpRuntimeId) -> Result<bool, String>;
    fn record(&self, id: McpRuntimeId) -> Result<(), String>;
}

/// the store, on the core thread
struct Direct(SharedStore<'static>);

impl Allowed for Direct {
    fn is_allowed(&self, id: McpRuntimeId) -> Result<bool, String> {
        Ok(is_runtime_allowed(&self.0, id))
    }

    fn record(&self, id: McpRuntimeId) -> Result<(), String> {
        record_runtime_allowed(&self.0, id).map_err(|e| e.message)
    }
}

/// the store, asked of the core thread
struct Asked(CoreLink);

impl Allowed for Asked {
    fn is_allowed(&self, id: McpRuntimeId) -> Result<bool, String> {
        self.0
            .ask(move |hub| hub.runtime_allowed(id))
            .ok_or_else(|| "the app is closing".to_owned())
    }

    fn record(&self, id: McpRuntimeId) -> Result<(), String> {
        self.0
            .ask(move |hub| hub.record_runtime_allowed(id))
            .unwrap_or_else(|| Err("the app is closing".to_owned()))
    }
}

pub struct KitHost {
    net: McpNetHost,
    allowed: Box<dyn Allowed>,
}

impl KitHost {
    /// for a thread that is not the core thread
    pub fn worker(net: McpNetHost, link: CoreLink) -> KitHost {
        KitHost {
            net,
            allowed: Box::new(Asked(link)),
        }
    }

    /// for the core thread
    pub fn core(net: McpNetHost, store: SharedStore<'static>) -> KitHost {
        KitHost {
            net,
            allowed: Box::new(Direct(store)),
        }
    }
}

struct Chunks {
    body: Box<dyn NetBody>,
    over: bool,
}

impl Iterator for Chunks {
    type Item = Result<Vec<u8>, String>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.over {
            return None;
        }
        match self.body.next_chunk() {
            Ok(Some(chunk)) => Some(Ok(chunk)),
            Ok(None) => {
                self.over = true;
                None
            }
            Err(error) => {
                self.over = true;
                Some(Err(error.message))
            }
        }
    }
}

impl RuntimeFetch for KitHost {
    fn fetch(&self, url: &str) -> Result<RuntimeResponse, String> {
        let init = FetchInit {
            redirect: Some(Redirect::Follow),
            ..FetchInit::default()
        };
        let response = self
            .net
            .fetch(url, &init, None)
            .map_err(|error| error.message)?;
        Ok(RuntimeResponse {
            ok: (200..300).contains(&response.status),
            status: response.status,
            body: response.body.map(|body| {
                Box::new(Chunks { body, over: false })
                    as Box<dyn Iterator<Item = Result<Vec<u8>, String>>>
            }),
        })
    }
}

impl RuntimeKitHost for KitHost {
    fn is_runtime_allowed(&self, id: McpRuntimeId) -> Result<bool, String> {
        self.allowed.is_allowed(id)
    }

    fn record_runtime_allowed(&self, id: McpRuntimeId) -> Result<(), String> {
        self.allowed.record(id)
    }

    /// `askDownload: async () => false`: the question is asked in Settings
    fn ask_download(&self, _question: &RuntimeDownloadQuestion) -> Result<bool, String> {
        Ok(false)
    }

    fn fetcher(&self) -> &dyn RuntimeFetch {
        self
    }

    fn run_uv(
        &self,
        uv: &str,
        args: &[String],
        env: &JsObject<String>,
        cwd: &str,
    ) -> Result<UvRunResult, String> {
        let output = Command::new(uv)
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(env.entries())
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|error| error.to_string())?;
        Ok(UvRunResult {
            code: output.status.code().map_or(-1.0, f64::from),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        })
    }

    fn sleep(&self, ms: f64) {
        std::thread::sleep(std::time::Duration::from_secs_f64(ms.max(0.0) / 1000.0));
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), NodeError> {
        rename_path(from, to)
    }

    fn random_hex4(&self) -> String {
        let mut bytes = [0u8; 4];
        let _ = getrandom::fill(&mut bytes);
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}
