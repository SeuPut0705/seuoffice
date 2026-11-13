//! The hosts of the MCP hub and its docs / sheets bridges
//! (`shell_ipc_a::mcp`): the network of a connection, what the shell entry
//! tells the hub, and the tabs the bridges open.

use std::sync::Arc;
use std::time::Duration;

use jscompat::JsonValue;
use main_core::packages::i18n::Lang;
use main_core::packages::mcp_sdk::client::OutputCheck;
use main_core::packages::mcp_sdk::client::net::{FetchError, FetchInit, Headers, Redirect};
use shell_contract::{Hosts, ViewId};
use shell_ipc_a::mcp::{
    McpNet, McpNetHost, McpShell, McpShellHost, McpTabs, McpTabsHost, NetBody, NetResponse,
};

use super::super::http;
use super::schema::OutputSchemas;
use super::{NOT_BUILT, Unbuilt, current_lang, unbuilt};
use crate::host::HostContext;

pub(super) fn install(hosts: &mut Hosts, cx: &HostContext) {
    let net: McpNetHost = Arc::new(ShellMcpNet::default());
    hosts.insert(net);
    let shell: McpShellHost = Arc::new(ShellMcpShell {
        version: cx.app.package_info().version.to_string(),
    });
    hosts.insert(shell);
    let tabs: McpTabsHost = Arc::new(Unbuilt);
    hosts.insert(tabs);
    hosts.insert(shell_ipc_a::mcp::hub_factory());
    hosts.insert(shell_ipc_a::mcp::bridges_factory());
}

/// `net.fetch` for a connection thread: the request is driven on the shell's
/// async runtime and waited for here, so it never runs on the core thread
#[derive(Default)]
struct ShellMcpNet {
    /// the validators of the tools' output schemas
    schemas: OutputSchemas,
}

/// A body read chunk by chunk, each read waited for on the caller's thread
struct ResponseBody(reqwest::Response);

impl NetBody for ResponseBody {
    fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError> {
        tauri::async_runtime::block_on(self.0.chunk())
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
            .map_err(|error| failure(&error))
    }
}

/// What a request that got no answer rejects with: Chromium's name of the
/// failure, as `net.fetch` throws it
fn failure(error: &reqwest::Error) -> FetchError {
    let mut text = error.to_string();
    let mut refused = false;
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = source {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            refused |= io.kind() == std::io::ErrorKind::ConnectionRefused;
        }
        text = current.to_string();
        source = current.source();
    }
    let name = if refused {
        "net::ERR_CONNECTION_REFUSED"
    } else if error.is_timeout() {
        "net::ERR_TIMED_OUT"
    } else if text.contains("dns error") || text.contains("failed to lookup address") {
        "net::ERR_NAME_NOT_RESOLVED"
    } else if error.is_redirect() {
        "net::ERR_TOO_MANY_REDIRECTS"
    } else {
        "net::ERR_FAILED"
    };
    FetchError::type_error(name)
}

/// Fetch: a null body for HEAD and the null-body statuses
fn has_body(method: &reqwest::Method, status: u16) -> bool {
    !(method == reqwest::Method::HEAD
        || method == reqwest::Method::CONNECT
        || matches!(status, 101 | 103 | 204 | 205 | 304))
}

impl McpNet for ShellMcpNet {
    fn fetch(
        &self,
        url: &str,
        init: &FetchInit,
        limit_ms: Option<f64>,
    ) -> Result<NetResponse, FetchError> {
        let redirect = init.redirect.unwrap_or(Redirect::Follow);
        let method = init.method.as_deref().unwrap_or("GET").to_uppercase();
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| FetchError::type_error("Failed to fetch"))?;
        let mut builder = http::client(url, redirect == Redirect::Follow).request(method.clone(), url);
        if let Some(headers) = &init.headers {
            for (name, value) in headers.entries() {
                builder = builder.header(name, value);
            }
        }
        if let Some(body) = &init.body {
            builder = builder.body(body.clone());
        }
        let sent = tauri::async_runtime::block_on(async {
            match limit_ms {
                Some(ms) => {
                    let limit = Duration::from_millis(ms.max(0.0) as u64);
                    match tokio::time::timeout(limit, builder.send()).await {
                        Ok(sent) => sent.map_err(|error| failure(&error)),
                        Err(_) => Err(FetchError::other(
                            "TimeoutError",
                            "The operation was aborted due to timeout",
                        )),
                    }
                }
                None => builder.send().await.map_err(|error| failure(&error)),
            }
        })?;
        let status = sent.status();
        if redirect == Redirect::Error && status.is_redirection() {
            return Err(FetchError::other(
                "Error",
                "Attempted to redirect, but redirect policy was 'error'",
            ));
        }
        let mut headers = Headers::new();
        for (name, value) in sent.headers() {
            headers.append(name.as_str(), &String::from_utf8_lossy(value.as_bytes()));
        }
        let answered = sent.url().to_string();
        let has_body = has_body(&method, status.as_u16());
        Ok(NetResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_owned(),
            headers,
            redirected: answered != url,
            url: answered,
            opaque_redirect: false,
            body: has_body.then(|| Box::new(ResponseBody(sent)) as Box<dyn NetBody>),
        })
    }

    fn compile_output_schema(&self, schema: &JsonValue) -> Result<u64, String> {
        self.schemas.compile(schema)
    }

    fn validate_output(&self, validator: u64, structured_content: &JsonValue) -> OutputCheck {
        self.schemas.check(validator, structured_content)
    }
}

/// What the shell entry tells the hub: the language and the app's version
struct ShellMcpShell {
    version: String,
}

impl McpShell for ShellMcpShell {
    fn lang(&self) -> Lang {
        current_lang()
    }

    fn app_version(&self) -> String {
        self.version.clone()
    }
}

impl McpTabs for Unbuilt {
    fn open_blank_docs_tab(&self) -> ViewId {
        unbuilt("McpTabs::open_blank_docs_tab");
        panic!("McpTabs::open_blank_docs_tab is {NOT_BUILT}")
    }

    fn authorize_docs_save(&self, _: ViewId, _: &str) {
        unbuilt("McpTabs::authorize_docs_save");
    }

    fn abandon_blank_docs_tab(&self, _: ViewId) {
        unbuilt("McpTabs::abandon_blank_docs_tab");
    }

    fn open_blank_sheets_tab(&self) -> Result<ViewId, String> {
        unbuilt("McpTabs::open_blank_sheets_tab");
        Err(NOT_BUILT.into())
    }

    fn authorize_sheets_save(&self, _: ViewId, _: &str) {
        unbuilt("McpTabs::authorize_sheets_save");
    }

    fn abandon_blank_sheets_tab(&self, _: ViewId) {
        unbuilt("McpTabs::abandon_blank_sheets_tab");
    }
}
