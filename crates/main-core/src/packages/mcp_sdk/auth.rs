//! `@modelcontextprotocol/sdk` 1.32.1 `client/auth.js`, the pieces
//! `mcp-client/oauth.ts` and `remote.ts` call, with `shared/auth.js` (the zod
//! schemas of the OAuth documents), `shared/auth-utils.js`, `server/auth/errors.js`
//! and the `pkce-challenge` package.
//!
//! Every function is a plain call over [`AuthHost`]: the network is
//! [`FetchHost::fetch`] (the TypeScript's `fetchFn`) and the randomness of the
//! PKCE verifier is [`AuthHost::random_bytes`]. A document a server sends is
//! read as `JsonValue` and parsed by the schemas as zod parses it, so what
//! comes back has the keys of the schema in its order and drops what the
//! schema does not name where zod does.
//!
//! Left out because `oauth.ts` never reaches it: the `OAuthClientProvider`
//! flow (`auth()`, `fetchToken`), the deprecated `discoverOAuthMetadata`,
//! `extractResourceMetadataUrl`, `isHttpsUrl` and `selectResourceURL`.

use jscompat::{JsObject, JsonValue, js_regex, json_stringify};
use sha2::{Digest, Sha256};
use url::Url;

use super::client::net::{
    FetchError, FetchHost, FetchInit, FetchResponse, Headers, cancel_body, fetch_within_origin,
    read_json, read_text, unfollowed_redirect,
};
use super::types::LATEST_PROTOCOL_VERSION;
use super::types::schema::{self, Issue, Schema};

/// What an authorization call needs from the world.
pub trait AuthHost: FetchHost {
    /// `crypto.getRandomValues(new Uint8Array(len))`
    fn random_bytes(&mut self, len: usize) -> Vec<u8>;
}

/// An error of `server/auth/errors.js`: the class (`name`), its
/// `errorCode`, the message and the `errorUri`.
#[derive(Debug, Clone, PartialEq)]
pub struct OAuthError {
    pub name: &'static str,
    pub error_code: &'static str,
    pub message: String,
    pub error_uri: Option<String>,
}

/// `OAUTH_ERRORS`: class name and error code
const OAUTH_ERRORS: [(&str, &str); 17] = [
    ("InvalidRequestError", "invalid_request"),
    ("InvalidClientError", "invalid_client"),
    ("InvalidGrantError", "invalid_grant"),
    ("UnauthorizedClientError", "unauthorized_client"),
    ("UnsupportedGrantTypeError", "unsupported_grant_type"),
    ("InvalidScopeError", "invalid_scope"),
    ("AccessDeniedError", "access_denied"),
    ("ServerError", "server_error"),
    ("TemporarilyUnavailableError", "temporarily_unavailable"),
    ("UnsupportedResponseTypeError", "unsupported_response_type"),
    ("UnsupportedTokenTypeError", "unsupported_token_type"),
    ("InvalidTokenError", "invalid_token"),
    ("MethodNotAllowedError", "method_not_allowed"),
    ("TooManyRequestsError", "too_many_requests"),
    ("InvalidClientMetadataError", "invalid_client_metadata"),
    ("InsufficientScopeError", "insufficient_scope"),
    ("InvalidTargetError", "invalid_target"),
];

impl OAuthError {
    /// `new ServerError(message)`
    pub fn server_error(message: &str) -> OAuthError {
        OAuthError {
            name: "ServerError",
            error_code: "server_error",
            message: message.to_owned(),
            error_uri: None,
        }
    }

    /// `error.toResponseObject()`
    pub fn to_response_object(&self) -> JsonValue {
        let mut out = JsObject::new();
        out.set("error", JsonValue::String(self.error_code.to_owned()));
        out.set("error_description", JsonValue::String(self.message.clone()));
        if let Some(uri) = self.error_uri.as_deref().filter(|uri| !uri.is_empty()) {
            out.set("error_uri", JsonValue::String(uri.to_owned()));
        }
        JsonValue::Object(out)
    }
}

/// What the functions of this module throw.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthError {
    OAuth(OAuthError),
    /// `ZodError`
    Zod(Vec<Issue>),
    /// `SyntaxError` of `JSON.parse`
    Syntax(String),
    /// what the host's `fetch` rejected with
    Fetch(FetchError),
    /// an `Error` (a `TypeError` for a URL that does not parse, a `DOMException`
    /// for `btoa`) by name and message
    Error {
        name: String,
        message: String,
    },
    /// a value that is not an error, thrown
    Thrown(String),
}

impl AuthError {
    fn plain(message: &str) -> AuthError {
        AuthError::Error {
            name: "Error".to_owned(),
            message: message.to_owned(),
        }
    }

    fn invalid_url() -> AuthError {
        AuthError::Error {
            name: "TypeError".to_owned(),
            message: "Invalid URL".to_owned(),
        }
    }

    /// `error.name`
    pub fn name(&self) -> String {
        match self {
            AuthError::OAuth(error) => error.name.to_owned(),
            AuthError::Zod(_) => "ZodError".to_owned(),
            AuthError::Syntax(_) => "SyntaxError".to_owned(),
            AuthError::Fetch(error) => error.name.clone(),
            AuthError::Error { name, .. } => name.clone(),
            AuthError::Thrown(_) => String::new(),
        }
    }

    /// `error.message`
    pub fn message(&self) -> String {
        match self {
            AuthError::OAuth(error) => error.message.clone(),
            AuthError::Zod(issues) => schema::error_message(issues),
            AuthError::Syntax(message) => message.clone(),
            AuthError::Fetch(error) => error.message.clone(),
            AuthError::Error { message, .. } => message.clone(),
            AuthError::Thrown(text) => text.clone(),
        }
    }

    /// `String(error)`
    pub fn to_js_string(&self) -> String {
        match self {
            AuthError::Thrown(text) => return text.clone(),
            AuthError::Zod(_) => return self.message(),
            _ => {}
        }
        let name = self.name();
        let message = self.message();
        if message.is_empty() {
            name
        } else if name.is_empty() {
            message
        } else {
            format!("{name}: {message}")
        }
    }

    /// `error instanceof OAuthError`: its `errorCode`
    pub fn oauth_error_code(&self) -> Option<&'static str> {
        match self {
            AuthError::OAuth(error) => Some(error.error_code),
            _ => None,
        }
    }
}

fn text(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

fn s(key: &str, value: Schema) -> (String, Schema) {
    (key.to_owned(), value)
}

fn strings() -> Schema {
    schema::array(schema::string()).optional()
}

fn parse_url(value: &str) -> Result<Url, AuthError> {
    Url::parse(value).map_err(|_| AuthError::invalid_url())
}

// ---- the schemas of shared/auth.js ----

/// `OAuthProtectedResourceMetadataSchema`
pub fn oauth_protected_resource_metadata_schema() -> Schema {
    schema::loose_object(vec![
        s("resource", schema::url()),
        s(
            "authorization_servers",
            schema::array(schema::safe_url()).optional(),
        ),
        s("jwks_uri", schema::url().optional()),
        s("scopes_supported", strings()),
        s("bearer_methods_supported", strings()),
        s("resource_signing_alg_values_supported", strings()),
        s("resource_name", schema::string().optional()),
        s("resource_documentation", schema::string().optional()),
        s("resource_policy_uri", schema::url().optional()),
        s("resource_tos_uri", schema::url().optional()),
        s(
            "tls_client_certificate_bound_access_tokens",
            schema::boolean().optional(),
        ),
        s("authorization_details_types_supported", strings()),
        s("dpop_signing_alg_values_supported", strings()),
        s(
            "dpop_bound_access_tokens_required",
            schema::boolean().optional(),
        ),
    ])
}

/// `OAuthMetadataSchema`
pub fn oauth_metadata_schema() -> Schema {
    schema::loose_object(vec![
        s("issuer", schema::string()),
        s("authorization_endpoint", schema::safe_url()),
        s("token_endpoint", schema::safe_url()),
        s("registration_endpoint", schema::safe_url().optional()),
        s("scopes_supported", strings()),
        s("response_types_supported", schema::array(schema::string())),
        s("response_modes_supported", strings()),
        s("grant_types_supported", strings()),
        s("token_endpoint_auth_methods_supported", strings()),
        s(
            "token_endpoint_auth_signing_alg_values_supported",
            strings(),
        ),
        s("service_documentation", schema::safe_url().optional()),
        s("revocation_endpoint", schema::safe_url().optional()),
        s("revocation_endpoint_auth_methods_supported", strings()),
        s(
            "revocation_endpoint_auth_signing_alg_values_supported",
            strings(),
        ),
        s("introspection_endpoint", schema::string().optional()),
        s("introspection_endpoint_auth_methods_supported", strings()),
        s(
            "introspection_endpoint_auth_signing_alg_values_supported",
            strings(),
        ),
        s("code_challenge_methods_supported", strings()),
        s(
            "client_id_metadata_document_supported",
            schema::boolean().optional(),
        ),
    ])
}

/// `OpenIdProviderDiscoveryMetadataSchema`: `z.object`, so keys it does not name are dropped
pub fn openid_provider_discovery_metadata_schema() -> Schema {
    schema::object(vec![
        s("issuer", schema::string()),
        s("authorization_endpoint", schema::safe_url()),
        s("token_endpoint", schema::safe_url()),
        s("userinfo_endpoint", schema::safe_url().optional()),
        s("jwks_uri", schema::safe_url()),
        s("registration_endpoint", schema::safe_url().optional()),
        s("scopes_supported", strings()),
        s("response_types_supported", schema::array(schema::string())),
        s("response_modes_supported", strings()),
        s("grant_types_supported", strings()),
        s("acr_values_supported", strings()),
        s("subject_types_supported", schema::array(schema::string())),
        s(
            "id_token_signing_alg_values_supported",
            schema::array(schema::string()),
        ),
        s("id_token_encryption_alg_values_supported", strings()),
        s("id_token_encryption_enc_values_supported", strings()),
        s("userinfo_signing_alg_values_supported", strings()),
        s("userinfo_encryption_alg_values_supported", strings()),
        s("userinfo_encryption_enc_values_supported", strings()),
        s("request_object_signing_alg_values_supported", strings()),
        s("request_object_encryption_alg_values_supported", strings()),
        s("request_object_encryption_enc_values_supported", strings()),
        s("token_endpoint_auth_methods_supported", strings()),
        s(
            "token_endpoint_auth_signing_alg_values_supported",
            strings(),
        ),
        s("display_values_supported", strings()),
        s("claim_types_supported", strings()),
        s("claims_supported", strings()),
        s("service_documentation", schema::string().optional()),
        s("claims_locales_supported", strings()),
        s("ui_locales_supported", strings()),
        s("claims_parameter_supported", schema::boolean().optional()),
        s("request_parameter_supported", schema::boolean().optional()),
        s(
            "request_uri_parameter_supported",
            schema::boolean().optional(),
        ),
        s(
            "require_request_uri_registration",
            schema::boolean().optional(),
        ),
        s("op_policy_uri", schema::safe_url().optional()),
        s("op_tos_uri", schema::safe_url().optional()),
        s(
            "client_id_metadata_document_supported",
            schema::boolean().optional(),
        ),
        s("code_challenge_methods_supported", strings()),
    ])
}

/// `OAuthTokensSchema.omit({ issuer: true })`, the token response
pub fn token_response_schema() -> Schema {
    schema::object(vec![
        s("access_token", schema::string()),
        s("id_token", schema::string().optional()),
        s("token_type", schema::string()),
        s("expires_in", schema::coerce_number().optional()),
        s("scope", schema::string().optional()),
        s("refresh_token", schema::string().optional()),
    ])
}

/// `OAuthErrorResponseSchema`
pub fn oauth_error_response_schema() -> Schema {
    schema::object(vec![
        s("error", schema::string()),
        s("error_description", schema::string().optional()),
        s("error_uri", schema::string().optional()),
    ])
}

fn optional_safe_url() -> Schema {
    schema::union(vec![
        schema::safe_url().optional(),
        schema::empty_to_undefined(),
    ])
}

/// `OAuthClientInformationFullSchema.omit({ issuer: true })`, the registration response
pub fn registration_response_schema() -> Schema {
    schema::object(vec![
        s("redirect_uris", schema::array(schema::safe_url())),
        s("token_endpoint_auth_method", schema::string().optional()),
        s("grant_types", strings()),
        s("response_types", strings()),
        s("client_name", schema::string().optional()),
        s("client_uri", schema::safe_url().optional()),
        s("logo_uri", optional_safe_url()),
        s("scope", schema::string().optional()),
        s("contacts", strings()),
        s("tos_uri", optional_safe_url()),
        s("policy_uri", schema::string().optional()),
        s("jwks_uri", schema::safe_url().optional()),
        s("jwks", schema::unknown().optional()),
        s("software_id", schema::string().optional()),
        s("software_version", schema::string().optional()),
        s("software_statement", schema::string().optional()),
        s("client_id", schema::string()),
        s("client_secret", schema::string().optional()),
        s("client_id_issued_at", schema::number().optional()),
        s("client_secret_expires_at", schema::number().optional()),
    ])
}

// ---- errors ----

/// `parseErrorResponse(input)` of a body that was not a `Response`
pub fn parse_error_response_text(body: &str) -> AuthError {
    parse_error(None, None, body)
}

/// `parseErrorResponse(response)`: the error to throw; `Fetch` when the body could not be read
pub fn parse_error_response(host: &mut dyn FetchHost, response: &FetchResponse) -> AuthError {
    let body = match read_text(host, &response.body) {
        Ok(body) => body,
        Err(error) => return AuthError::Fetch(error),
    };
    let redirect = unfollowed_redirect(response, &response.url);
    parse_error(Some(response.status), redirect, &body)
}

/// the names `OAUTH_ERRORS[error]` finds on `Object.prototype`
const INHERITED: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

fn parse_error(status: Option<u16>, redirect: Option<String>, body: &str) -> AuthError {
    let attempt: Result<AuthError, AuthError> = (|| {
        let value = jscompat::json_parse(body)
            .map_err(|error| AuthError::Syntax(error.message().to_owned()))?;
        let parsed =
            schema::safe_parse(&oauth_error_response_schema(), &value).map_err(AuthError::Zod)?;
        let get = |key: &str| match parsed.get(key).as_deref() {
            Some(JsonValue::String(value)) => Some(value.clone()),
            _ => None,
        };
        let code = get("error").unwrap_or_default();
        let description = get("error_description").unwrap_or_default();
        let uri = get("error_uri");
        if let Some(&(name, error_code)) = OAUTH_ERRORS.iter().find(|(_, c)| *c == code) {
            return Ok(AuthError::OAuth(OAuthError {
                name,
                error_code,
                message: description,
                error_uri: uri,
            }));
        }
        if code == "constructor" {
            // `new Object(description, uri)` is a String object
            return Ok(AuthError::Thrown(description));
        }
        if INHERITED.contains(&code.as_str()) {
            return Err(AuthError::Error {
                name: "TypeError".to_owned(),
                message: "errorClass is not a constructor".to_owned(),
            });
        }
        Ok(AuthError::OAuth(OAuthError {
            name: "ServerError",
            error_code: "server_error",
            message: description,
            error_uri: uri,
        }))
    })();
    match attempt {
        Ok(error) => error,
        Err(error) => {
            let prefix = status.map_or(String::new(), |status| format!("HTTP {status}: "));
            let detail = redirect.unwrap_or_else(|| {
                format!(
                    "Invalid OAuth error response: {}. Raw body: {body}",
                    error.to_js_string()
                )
            });
            AuthError::OAuth(OAuthError::server_error(&format!("{prefix}{detail}")))
        }
    }
}

// ---- urls ----

/// `URLSearchParams`: the pairs of a query in order
#[derive(Debug, Clone, Default)]
struct SearchParams {
    pairs: Vec<(String, String)>,
}

impl SearchParams {
    fn of(url: &Url) -> SearchParams {
        SearchParams {
            pairs: url
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect(),
        }
    }

    fn from_pairs(pairs: &[(&str, &str)]) -> SearchParams {
        SearchParams {
            pairs: pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        }
    }

    /// `params.set(name, value)`
    fn set(&mut self, name: &str, value: &str) {
        match self.pairs.iter().position(|(k, _)| k == name) {
            Some(first) => {
                self.pairs[first].1 = value.to_owned();
                let mut index = 0;
                self.pairs.retain(|(k, _)| {
                    let keep = index <= first || k != name;
                    index += 1;
                    keep
                });
            }
            None => self.pairs.push((name.to_owned(), value.to_owned())),
        }
    }

    fn append(&mut self, name: &str, value: &str) {
        self.pairs.push((name.to_owned(), value.to_owned()));
    }

    /// `params.toString()`
    fn serialize(&self) -> String {
        url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(self.pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .finish()
    }

    /// the URL's query after `url.searchParams` changed
    fn apply(&self, url: &mut Url) {
        if self.pairs.is_empty() {
            url.set_query(None);
        } else {
            url.set_query(Some(&self.serialize()));
        }
    }
}

/// `resourceUrlFromServerUrl(url)`: the URL without its fragment
pub fn resource_url_from_server_url(url: &str) -> Result<String, AuthError> {
    let mut resource = parse_url(url)?;
    resource.set_fragment(None);
    Ok(resource.as_str().to_owned())
}

/// `checkResourceAllowed({ requestedResource, configuredResource })`
pub fn check_resource_allowed(
    requested_resource: &str,
    configured_resource: &str,
) -> Result<bool, AuthError> {
    let requested = parse_url(requested_resource)?;
    let configured = parse_url(configured_resource)?;
    if requested.origin().ascii_serialization() != configured.origin().ascii_serialization() {
        return Ok(false);
    }
    if requested.path().encode_utf16().count() < configured.path().encode_utf16().count() {
        return Ok(false);
    }
    let with_slash = |path: &str| {
        if path.ends_with('/') {
            path.to_owned()
        } else {
            format!("{path}/")
        }
    };
    Ok(with_slash(requested.path()).starts_with(&with_slash(configured.path())))
}

/// What `extractWWWAuthenticateParams` finds in a `WWW-Authenticate` header.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WwwAuthenticateParams {
    /// `resourceMetadataUrl`, as `URL.href`
    pub resource_metadata_url: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
}

/// `extractFieldFromWwwAuth(response, fieldName)` followed by `|| undefined`
fn www_auth_field(header: &str, name: &str) -> Option<String> {
    let found = match name {
        "resource_metadata" => {
            js_regex!(r#"resource_metadata=(?:"([^"]+)"|([^\s,]+))"#).exec(header)
        }
        "scope" => js_regex!(r#"scope=(?:"([^"]+)"|([^\s,]+))"#).exec(header),
        _ => js_regex!(r#"error=(?:"([^"]+)"|([^\s,]+))"#).exec(header),
    }?;
    let value = found
        .get(1)
        .filter(|v| !v.is_empty())
        .or_else(|| found.get(2))?;
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}

/// `extractWWWAuthenticateParams(response)`, from the headers of the response
pub fn extract_www_authenticate_params(headers: &Headers) -> WwwAuthenticateParams {
    let Some(header) = headers.get("WWW-Authenticate").filter(|h| !h.is_empty()) else {
        return WwwAuthenticateParams::default();
    };
    let mut parts = header.split(' ');
    let kind = parts.next().unwrap_or("");
    let scheme = parts.next().unwrap_or("");
    if kind.to_lowercase() != "bearer" || scheme.is_empty() {
        return WwwAuthenticateParams::default();
    }
    let resource_metadata_url = www_auth_field(header, "resource_metadata")
        .and_then(|value| Url::parse(&value).ok())
        .map(|url| url.as_str().to_owned());
    WwwAuthenticateParams {
        resource_metadata_url,
        scope: www_auth_field(header, "scope"),
        error: www_auth_field(header, "error"),
    }
}

// ---- discovery ----

/// `buildWellKnownPath(prefix, pathname)`
fn build_well_known_path(prefix: &str, pathname: &str) -> String {
    let pathname = pathname.strip_suffix('/').unwrap_or(pathname);
    format!("/.well-known/{prefix}{pathname}")
}

/// `fetchWithCorsRetry(url, headers, fetchFn)`: `None` is `undefined`
fn fetch_with_cors_retry(
    host: &mut dyn FetchHost,
    url: &str,
    headers: Option<Headers>,
) -> Result<Option<FetchResponse>, AuthError> {
    let init = FetchInit {
        method: None,
        headers: headers.clone(),
        body: None,
        redirect: None,
    };
    match fetch_within_origin(host, url, &init) {
        Ok(response) => Ok(Some(response)),
        Err(error) if error.is_type_error => {
            if headers.is_some() {
                fetch_with_cors_retry(host, url, None)
            } else {
                Ok(None)
            }
        }
        Err(error) => Err(AuthError::Fetch(error)),
    }
}

/// `tryMetadataDiscovery(url, protocolVersion, fetchFn)`
fn try_metadata_discovery(
    host: &mut dyn FetchHost,
    url: &str,
    protocol_version: &str,
) -> Result<Option<FetchResponse>, AuthError> {
    let headers = Headers::from_pairs(&[("MCP-Protocol-Version", protocol_version)]);
    fetch_with_cors_retry(host, url, Some(headers))
}

/// `discoverMetadataWithFallback(serverUrl, 'oauth-protected-resource', ...)`
fn discover_protected_resource_response(
    host: &mut dyn FetchHost,
    server_url: &str,
    metadata_url: Option<&str>,
) -> Result<Option<FetchResponse>, AuthError> {
    let issuer = parse_url(server_url)?;
    let protocol_version = LATEST_PROTOCOL_VERSION;
    let wk_type = "oauth-protected-resource";
    let url = match metadata_url.filter(|u| !u.is_empty()) {
        Some(explicit) => parse_url(explicit)?,
        None => {
            let path = build_well_known_path(wk_type, issuer.path());
            let mut url = issuer.join(&path).map_err(|_| AuthError::invalid_url())?;
            url.set_query(issuer.query());
            url
        }
    };
    let mut response = try_metadata_discovery(host, url.as_str(), protocol_version)?;
    let fallback = metadata_url.is_none_or(str::is_empty)
        && match &response {
            None => true,
            Some(r) => !r.ok() && r.status < 500 && issuer.path() != "/",
        };
    if fallback {
        let root = issuer
            .join(&format!("/.well-known/{wk_type}"))
            .map_err(|_| AuthError::invalid_url())?;
        response = try_metadata_discovery(host, root.as_str(), protocol_version)?;
    }
    Ok(response)
}

/// `discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl }, fetchFn)`
pub fn discover_oauth_protected_resource_metadata(
    host: &mut dyn FetchHost,
    server_url: &str,
    resource_metadata_url: Option<&str>,
) -> Result<JsonValue, AuthError> {
    let response = discover_protected_resource_response(host, server_url, resource_metadata_url)?;
    let response = match response {
        Some(response) if response.status != 404 => response,
        other => {
            if let Some(response) = other {
                cancel_body(host, &response.body);
            }
            return Err(AuthError::plain(
                "Resource server does not implement OAuth 2.0 Protected Resource Metadata.",
            ));
        }
    };
    if !response.ok() {
        cancel_body(host, &response.body);
        return Err(AuthError::plain(&format!(
            "HTTP {} trying to load well-known OAuth protected resource metadata.",
            response.status
        )));
    }
    let value = read_json(host, &response.body).map_err(json_error)?;
    schema::safe_parse(&oauth_protected_resource_metadata_schema(), &value).map_err(AuthError::Zod)
}

fn json_error(error: super::client::net::JsonReadError) -> AuthError {
    match error {
        super::client::net::JsonReadError::Fetch(error) => AuthError::Fetch(error),
        super::client::net::JsonReadError::Syntax(message) => AuthError::Syntax(message),
    }
}

/// which metadata document a discovery URL asks for
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataKind {
    Oauth,
    Oidc,
}

/// `buildDiscoveryUrls(authorizationServerUrl)`
pub fn build_discovery_urls(
    authorization_server_url: &str,
) -> Result<Vec<(String, MetadataKind)>, AuthError> {
    let url = parse_url(authorization_server_url)?;
    let origin = url.origin().ascii_serialization();
    let base = parse_url(&origin)?;
    let at = |path: &str| -> Result<String, AuthError> {
        base.join(path)
            .map(|joined| joined.as_str().to_owned())
            .map_err(|_| AuthError::invalid_url())
    };
    if url.path() == "/" {
        return Ok(vec![
            (
                at("/.well-known/oauth-authorization-server")?,
                MetadataKind::Oauth,
            ),
            (at("/.well-known/openid-configuration")?, MetadataKind::Oidc),
        ]);
    }
    let pathname = url.path().strip_suffix('/').unwrap_or(url.path());
    Ok(vec![
        (
            at(&format!(
                "/.well-known/oauth-authorization-server{pathname}"
            ))?,
            MetadataKind::Oauth,
        ),
        (
            at(&format!("/.well-known/openid-configuration{pathname}"))?,
            MetadataKind::Oidc,
        ),
        (
            at(&format!("{pathname}/.well-known/openid-configuration"))?,
            MetadataKind::Oidc,
        ),
    ])
}

/// `discoverAuthorizationServerMetadata(authorizationServerUrl, { fetchFn })`:
/// `Ok(None)` is `undefined`
pub fn discover_authorization_server_metadata(
    host: &mut dyn FetchHost,
    authorization_server_url: &str,
) -> Result<Option<JsonValue>, AuthError> {
    for (endpoint, kind) in build_discovery_urls(authorization_server_url)? {
        let headers = Headers::from_pairs(&[
            ("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION),
            ("Accept", "application/json"),
        ]);
        let Some(response) = fetch_with_cors_retry(host, &endpoint, Some(headers))? else {
            continue;
        };
        if !response.ok() {
            cancel_body(host, &response.body);
            if response.status < 500 {
                continue;
            }
            let label = if kind == MetadataKind::Oauth {
                "OAuth"
            } else {
                "OpenID provider"
            };
            return Err(AuthError::plain(&format!(
                "HTTP {} trying to load {label} metadata from {endpoint}",
                response.status
            )));
        }
        let value = read_json(host, &response.body).map_err(json_error)?;
        let parsed = if kind == MetadataKind::Oauth {
            schema::safe_parse(&oauth_metadata_schema(), &value)
        } else {
            schema::safe_parse(&openid_provider_discovery_metadata_schema(), &value)
        };
        return parsed.map(Some).map_err(AuthError::Zod);
    }
    Ok(None)
}

/// What `discoverOAuthServerInfo` finds.
#[derive(Debug, Clone, PartialEq)]
pub struct OAuthServerInfo {
    pub authorization_server_url: String,
    pub authorization_server_metadata: Option<JsonValue>,
    pub resource_metadata: Option<JsonValue>,
}

/// `discoverOAuthServerInfo(serverUrl, { resourceMetadataUrl, fetchFn })`
pub fn discover_oauth_server_info(
    host: &mut dyn FetchHost,
    server_url: &str,
    resource_metadata_url: Option<&str>,
) -> Result<OAuthServerInfo, AuthError> {
    let mut resource_metadata: Option<JsonValue> = None;
    let mut authorization_server_url: Option<String> = None;
    if let Ok(found) =
        discover_oauth_protected_resource_metadata(host, server_url, resource_metadata_url)
    {
        if let Some(JsonValue::Array(servers)) = found.get("authorization_servers").as_deref()
            && let Some(JsonValue::String(first)) = servers.first()
        {
            authorization_server_url = Some(first.clone());
        }
        resource_metadata = Some(found);
    }
    let authorization_server_url = match authorization_server_url.filter(|u| !u.is_empty()) {
        Some(url) => url,
        None => parse_url(server_url)?
            .join("/")
            .map_err(|_| AuthError::invalid_url())?
            .as_str()
            .to_owned(),
    };
    let authorization_server_metadata =
        discover_authorization_server_metadata(host, &authorization_server_url)?;
    Ok(OAuthServerInfo {
        authorization_server_url,
        authorization_server_metadata,
        resource_metadata,
    })
}

// ---- PKCE ----

const PKCE_MASK: &[u8; 66] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";

/// `pkceChallenge()`: (code verifier, code challenge)
fn pkce_challenge(host: &mut dyn AuthHost) -> (String, String) {
    let size = 43usize;
    let cutoff = 256 - 256 % PKCE_MASK.len();
    let mut verifier = String::new();
    while verifier.len() < size {
        for byte in host.random_bytes(size - verifier.len()) {
            if usize::from(byte) < cutoff {
                verifier.push(char::from(PKCE_MASK[usize::from(byte) % PKCE_MASK.len()]));
            }
        }
    }
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = jscompat::base64(&digest)
        .replace('/', "_")
        .replace('+', "-")
        .replace('=', "");
    (verifier, challenge)
}

/// Where the user is sent and what the verifier is.
#[derive(Debug, Clone, PartialEq)]
pub struct Authorization {
    /// `authorizationUrl.href`
    pub authorization_url: String,
    pub code_verifier: String,
}

/// the options of `startAuthorization`
#[derive(Debug, Clone, Default)]
pub struct StartAuthorizationOptions<'a> {
    pub metadata: Option<&'a JsonValue>,
    /// `clientInformation.client_id`
    pub client_id: &'a str,
    pub redirect_url: &'a str,
    pub scope: Option<&'a str>,
    pub state: Option<&'a str>,
    /// the resource indicator as sent: the string, or `URL.href`
    pub resource: Option<&'a str>,
}

fn includes(list: Option<&JsonValue>, wanted: &str) -> bool {
    match list {
        Some(JsonValue::Array(items)) => items
            .iter()
            .any(|item| matches!(item, JsonValue::String(s) if s == wanted)),
        _ => false,
    }
}

/// `startAuthorization(authorizationServerUrl, options)`
pub fn start_authorization(
    host: &mut dyn AuthHost,
    authorization_server_url: &str,
    options: &StartAuthorizationOptions,
) -> Result<Authorization, AuthError> {
    let mut authorization_url = match options.metadata {
        Some(metadata) => {
            let endpoint = match metadata.get("authorization_endpoint").as_deref() {
                Some(JsonValue::String(endpoint)) => endpoint.clone(),
                _ => String::from("undefined"),
            };
            let url = parse_url(&endpoint)?;
            let response_types = metadata.get("response_types_supported");
            let Some(response_types) = response_types.as_deref() else {
                return Err(AuthError::Error {
                    name: "TypeError".to_owned(),
                    message: "Cannot read properties of undefined (reading 'includes')".to_owned(),
                });
            };
            if !includes(Some(response_types), "code") {
                return Err(AuthError::plain(
                    "Incompatible auth server: does not support response type code",
                ));
            }
            if let Some(methods) = metadata.get("code_challenge_methods_supported")
                && methods.truthy()
                && !includes(Some(&methods), "S256")
            {
                return Err(AuthError::plain(
                    "Incompatible auth server: does not support code challenge method S256",
                ));
            }
            url
        }
        None => parse_url(authorization_server_url)?
            .join("/authorize")
            .map_err(|_| AuthError::invalid_url())?,
    };
    let (code_verifier, code_challenge) = pkce_challenge(host);
    let mut params = SearchParams::of(&authorization_url);
    params.set("response_type", "code");
    params.set("client_id", options.client_id);
    params.set("code_challenge", &code_challenge);
    params.set("code_challenge_method", "S256");
    params.set("redirect_uri", options.redirect_url);
    if let Some(state) = options.state.filter(|s| !s.is_empty()) {
        params.set("state", state);
    }
    if let Some(scope) = options.scope.filter(|s| !s.is_empty()) {
        params.set("scope", scope);
    }
    if options
        .scope
        .is_some_and(|scope| scope.contains("offline_access"))
    {
        params.append("prompt", "consent");
    }
    if let Some(resource) = options.resource.filter(|r| !r.is_empty()) {
        params.set("resource", resource);
    }
    params.apply(&mut authorization_url);
    Ok(Authorization {
        authorization_url: authorization_url.as_str().to_owned(),
        code_verifier,
    })
}

// ---- tokens ----

/// `selectClientAuthMethod(clientInformation, supportedMethods)`
pub fn select_client_auth_method(
    client_information: &JsonValue,
    supported_methods: &[String],
) -> &'static str {
    let has_client_secret = client_information.get("client_secret").is_some();
    if let Some(JsonValue::String(method)) = client_information
        .get("token_endpoint_auth_method")
        .as_deref()
    {
        let known = ["client_secret_basic", "client_secret_post", "none"]
            .iter()
            .copied()
            .find(|candidate| *candidate == method.as_str());
        if let Some(known) = known
            && (supported_methods.is_empty() || supported_methods.iter().any(|m| m == known))
        {
            return known;
        }
    }
    if supported_methods.is_empty() {
        return if has_client_secret {
            "client_secret_basic"
        } else {
            "none"
        };
    }
    let supports = |method: &str| supported_methods.iter().any(|m| m == method);
    if has_client_secret && supports("client_secret_basic") {
        return "client_secret_basic";
    }
    if has_client_secret && supports("client_secret_post") {
        return "client_secret_post";
    }
    if supports("none") {
        return "none";
    }
    if has_client_secret {
        "client_secret_post"
    } else {
        "none"
    }
}

/// `btoa(text)`: the Latin-1 bytes of the text in base64
fn btoa(value: &str) -> Result<String, AuthError> {
    let mut bytes = Vec::with_capacity(value.len());
    for c in value.chars() {
        match u8::try_from(u32::from(c)) {
            Ok(byte) => bytes.push(byte),
            Err(_) => {
                return Err(AuthError::Error {
                    name: "InvalidCharacterError".to_owned(),
                    message: "Invalid character".to_owned(),
                });
            }
        }
    }
    Ok(jscompat::base64(&bytes))
}

fn string_field(value: &JsonValue, key: &str) -> Option<String> {
    match value.get(key).as_deref() {
        Some(JsonValue::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// `executeTokenRequest(authorizationServerUrl, ...)`
fn execute_token_request(
    host: &mut dyn FetchHost,
    authorization_server_url: &str,
    metadata: Option<&JsonValue>,
    mut params: SearchParams,
    client_information: Option<&JsonValue>,
    resource: Option<&str>,
) -> Result<JsonValue, AuthError> {
    let token_endpoint = metadata
        .and_then(|m| string_field(m, "token_endpoint"))
        .filter(|endpoint| !endpoint.is_empty());
    let token_url = match token_endpoint {
        Some(endpoint) => parse_url(&endpoint)?,
        None => parse_url(authorization_server_url)?
            .join("/token")
            .map_err(|_| AuthError::invalid_url())?,
    };
    let mut headers = Headers::from_pairs(&[
        ("Content-Type", "application/x-www-form-urlencoded"),
        ("Accept", "application/json"),
    ]);
    if let Some(resource) = resource.filter(|r| !r.is_empty()) {
        params.set("resource", resource);
    }
    if let Some(client) = client_information {
        let supported: Vec<String> = match metadata
            .and_then(|m| m.get("token_endpoint_auth_methods_supported"))
            .as_deref()
        {
            Some(JsonValue::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    JsonValue::String(s) => Some(s.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let method = select_client_auth_method(client, &supported);
        let client_id = string_field(client, "client_id").unwrap_or_default();
        let client_secret = string_field(client, "client_secret");
        match method {
            "client_secret_basic" => {
                let Some(secret) = client_secret.filter(|s| !s.is_empty()) else {
                    return Err(AuthError::plain(
                        "client_secret_basic authentication requires a client_secret",
                    ));
                };
                let credentials = btoa(&format!("{client_id}:{secret}"))?;
                headers.set("Authorization", &format!("Basic {credentials}"));
            }
            "client_secret_post" => {
                params.set("client_id", &client_id);
                if let Some(secret) = client_secret.filter(|s| !s.is_empty()) {
                    params.set("client_secret", &secret);
                }
            }
            _ => params.set("client_id", &client_id),
        }
    }
    let init = FetchInit {
        method: Some("POST".to_owned()),
        headers: Some(headers),
        body: Some(params.serialize()),
        redirect: None,
    };
    let response =
        fetch_within_origin(host, token_url.as_str(), &init).map_err(AuthError::Fetch)?;
    if !response.ok() {
        return Err(parse_error_response(host, &response));
    }
    let value = read_json(host, &response.body).map_err(json_error)?;
    schema::safe_parse(&token_response_schema(), &value).map_err(AuthError::Zod)
}

/// the options of `exchangeAuthorization`
#[derive(Debug, Clone)]
pub struct ExchangeAuthorizationOptions<'a> {
    pub metadata: Option<&'a JsonValue>,
    pub client_information: &'a JsonValue,
    pub authorization_code: &'a str,
    pub code_verifier: &'a str,
    pub redirect_uri: &'a str,
    pub resource: Option<&'a str>,
}

/// `exchangeAuthorization(authorizationServerUrl, options)`
pub fn exchange_authorization(
    host: &mut dyn FetchHost,
    authorization_server_url: &str,
    options: &ExchangeAuthorizationOptions,
) -> Result<JsonValue, AuthError> {
    let params = SearchParams::from_pairs(&[
        ("grant_type", "authorization_code"),
        ("code", options.authorization_code),
        ("code_verifier", options.code_verifier),
        ("redirect_uri", options.redirect_uri),
    ]);
    execute_token_request(
        host,
        authorization_server_url,
        options.metadata,
        params,
        Some(options.client_information),
        options.resource,
    )
}

/// the options of `refreshAuthorization`
#[derive(Debug, Clone)]
pub struct RefreshAuthorizationOptions<'a> {
    pub metadata: Option<&'a JsonValue>,
    pub client_information: &'a JsonValue,
    pub refresh_token: &'a str,
    pub resource: Option<&'a str>,
}

/// `refreshAuthorization(authorizationServerUrl, options)`: the tokens, the
/// refresh token kept when the server sent no new one
pub fn refresh_authorization(
    host: &mut dyn FetchHost,
    authorization_server_url: &str,
    options: &RefreshAuthorizationOptions,
) -> Result<JsonValue, AuthError> {
    let params = SearchParams::from_pairs(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", options.refresh_token),
    ]);
    let tokens = execute_token_request(
        host,
        authorization_server_url,
        options.metadata,
        params,
        Some(options.client_information),
        options.resource,
    )?;
    let mut out = JsObject::new();
    out.set("refresh_token", text(options.refresh_token));
    if let JsonValue::Object(found) = &tokens {
        for (key, value) in found.entries() {
            out.set(key, value.clone());
        }
    }
    Ok(JsonValue::Object(out))
}

// ---- registration ----

/// `registerClient(authorizationServerUrl, { metadata, clientMetadata, scope })`
pub fn register_client(
    host: &mut dyn FetchHost,
    authorization_server_url: &str,
    metadata: Option<&JsonValue>,
    client_metadata: &JsonValue,
    scope: Option<&str>,
) -> Result<JsonValue, AuthError> {
    let registration_url = match metadata {
        Some(metadata) => {
            let endpoint =
                string_field(metadata, "registration_endpoint").filter(|e| !e.is_empty());
            let Some(endpoint) = endpoint else {
                return Err(AuthError::plain(
                    "Incompatible auth server: does not support dynamic client registration",
                ));
            };
            parse_url(&endpoint)?
        }
        None => parse_url(authorization_server_url)?
            .join("/register")
            .map_err(|_| AuthError::invalid_url())?,
    };
    let mut body = JsObject::new();
    if let JsonValue::Object(given) = client_metadata {
        for (key, value) in given.entries() {
            body.set(key, value.clone());
        }
    }
    if let Some(scope) = scope {
        body.set("scope", text(scope));
    }
    let init = FetchInit {
        method: Some("POST".to_owned()),
        headers: Some(Headers::from_pairs(&[("Content-Type", "application/json")])),
        body: Some(json_stringify(&JsonValue::Object(body))),
        redirect: None,
    };
    let response =
        fetch_within_origin(host, registration_url.as_str(), &init).map_err(AuthError::Fetch)?;
    if !response.ok() {
        return Err(parse_error_response(host, &response));
    }
    let value = read_json(host, &response.body).map_err(json_error)?;
    schema::safe_parse(&registration_response_schema(), &value).map_err(AuthError::Zod)
}
