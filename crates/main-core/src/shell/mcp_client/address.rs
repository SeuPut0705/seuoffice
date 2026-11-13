//! `apps/shell/src/main/mcp-client/address.ts`: which addresses a remote MCP
//! server may have (user MCP spec 4.3). `https` passes. Plain `http` passes
//! only to this PC and to private ranges, and the person is warned that keys
//! and document text travel unencrypted. Judged when registering and again
//! when connecting, then by the addresses the name really resolves to, so a
//! private-looking name that resolves to a public address is refused.
//!
//! `node:dns` is the [`HostResolver`] the host supplies (`systemResolver`
//! there is `dns.lookup(host, { all: true, verbatim: true })`); `isIP` is
//! `safe_remote_url::is_ip`, and the `BlockList` of plain-http addresses is
//! written out below with the matching `node:net` does: an IPv4-mapped IPv6
//! address is matched against the IPv4 rules and a zone id (`%eth0`) is
//! ignored.

use jscompat::{JsonValue, Radix, js_regex, parse_int, to_int32, to_number, to_string_radix16};

use crate::packages::electron_utils::safe_remote_url::is_ip;
use crate::shell::mcp_servers_api::{strip_brackets, url_protocol_and_hostname};

/// `AddressProblem`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressProblem {
    /// not a URL
    Invalid,
    /// neither https nor http
    Scheme,
    /// http to an address outside this PC and the private ranges
    PublicHttp,
    /// an http host name that does not resolve
    Unresolved,
}

impl AddressProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            AddressProblem::Invalid => "invalid",
            AddressProblem::Scheme => "scheme",
            AddressProblem::PublicHttp => "public-http",
            AddressProblem::Unresolved => "unresolved",
        }
    }
}

/// `AddressCheck`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressCheck {
    Allowed {
        /// http: show the unencrypted warning and ask for confirmation
        plain: bool,
        /// an http host name; only `check_resolved_server_address` can clear it
        must_resolve: bool,
    },
    Refused(AddressProblem),
}

impl AddressCheck {
    /// The object the TypeScript returns
    pub fn to_json(self) -> JsonValue {
        let mut object = jscompat::JsObject::new();
        match self {
            AddressCheck::Allowed {
                plain,
                must_resolve,
            } => {
                object.set("ok", JsonValue::Bool(true));
                object.set("plain", JsonValue::Bool(plain));
                object.set("mustResolve", JsonValue::Bool(must_resolve));
            }
            AddressCheck::Refused(problem) => {
                object.set("ok", JsonValue::Bool(false));
                object.set("problem", JsonValue::String(problem.as_str().to_owned()));
            }
        }
        JsonValue::Object(object)
    }
}

/// The subnets and addresses of `PLAIN_HTTP_ALLOWED`: 127/8, 10/8, 172.16/12,
/// 192.168/16
const ALLOWED_V4: [([u8; 4], u32); 4] = [
    ([127, 0, 0, 0], 8),
    ([10, 0, 0, 0], 8),
    ([172, 16, 0, 0], 12),
    ([192, 168, 0, 0], 16),
];

/// `::1`, fc00::/7 and fe80::/10
const ALLOWED_V6: [([u8; 16], u32); 3] = [
    ([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128),
    ([0xfc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 7),
    ([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10),
];

/// The first `bits` bits of `a` and `b` agree.
fn prefix_matches(a: &[u8], b: &[u8], bits: u32) -> bool {
    (0..bits as usize).all(|i| {
        let mask = 0x80u8 >> (i & 7);
        a[i >> 3] & mask == b[i >> 3] & mask
    })
}

fn allowed_v4(address: &[u8; 4]) -> bool {
    ALLOWED_V4
        .iter()
        .any(|(network, bits)| prefix_matches(address, network, *bits))
}

/// The four bytes of text `is_ip` took for IPv4
fn parse_v4(text: &str) -> Option<[u8; 4]> {
    let mut out = [0u8; 4];
    let mut parts = text.split('.');
    for slot in out.iter_mut() {
        *slot = parts.next()?.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// The groups of a side of `::` (an IPv4 tail counts two)
fn v6_groups(side: &str) -> Option<Vec<u16>> {
    if side.is_empty() {
        return Some(Vec::new());
    }
    let mut groups = Vec::new();
    for part in side.split(':') {
        if part.contains('.') {
            let [a, b, c, d] = parse_v4(part)?;
            groups.push((u16::from(a) << 8) | u16::from(b));
            groups.push((u16::from(c) << 8) | u16::from(d));
        } else {
            groups.push(u16::from_str_radix(part, 16).ok()?);
        }
    }
    Some(groups)
}

/// The 16 bytes of an address `is_ip` took for IPv6; a zone is ignored, as
/// libuv ignores an interface it does not know
fn parse_v6(text: &str) -> Option<[u8; 16]> {
    let bare = text.split('%').next()?;
    let (head, tail, gap) = match bare.find("::") {
        Some(at) => (&bare[..at], &bare[at + 2..], true),
        None => (bare, "", false),
    };
    let mut groups = v6_groups(head)?;
    let tail = v6_groups(tail)?;
    if gap {
        let fill = 8usize.checked_sub(groups.len() + tail.len())?;
        groups.extend(std::iter::repeat_n(0, fill));
    }
    groups.extend(tail);
    if groups.len() != 8 {
        return None;
    }
    let mut bytes = [0u8; 16];
    for (i, group) in groups.iter().enumerate() {
        bytes[2 * i..2 * i + 2].copy_from_slice(&group.to_be_bytes());
    }
    Some(bytes)
}

/// `PLAIN_HTTP_ALLOWED.check(address, 'ipv6')`: an address that maps an IPv4
/// one is matched against the IPv4 rules
fn allowed_v6(address: &[u8; 16]) -> bool {
    let mapped =
        address[..10].iter().all(|b| *b == 0) && address[10] == 0xff && address[11] == 0xff;
    if mapped {
        return allowed_v4(&[address[12], address[13], address[14], address[15]]);
    }
    ALLOWED_V6
        .iter()
        .any(|(network, bits)| prefix_matches(address, network, *bits))
}

/// The eight 16-bit groups of an IPv6 address, or `None`
fn ipv6_groups(ip: &str) -> Option<[f64; 8]> {
    let mut text = ip.to_owned();
    if let Some(dotted) = js_regex!(r"(\d+\.\d+\.\d+\.\d+)$").exec(ip) {
        let quad = dotted.as_str();
        let parts: Vec<f64> = quad.split('.').map(to_number).collect();
        let high = (to_int32(parts[0]) << 8) | to_int32(parts[1]);
        let low = (to_int32(parts[2]) << 8) | to_int32(parts[3]);
        text = format!(
            "{}{}:{}",
            &ip[..ip.len() - quad.len()],
            to_string_radix16(f64::from(high)),
            to_string_radix16(f64::from(low))
        );
    }
    let halves: Vec<&str> = text.split("::").collect();
    if halves.len() > 2 {
        return None;
    }
    let head: Vec<&str> = if halves[0].is_empty() {
        Vec::new()
    } else {
        halves[0].split(':').collect()
    };
    let tail: Vec<&str> = if halves.len() == 2 && !halves[1].is_empty() {
        halves[1].split(':').collect()
    } else {
        Vec::new()
    };
    let fill: i64 = if halves.len() == 2 {
        8 - head.len() as i64 - tail.len() as i64
    } else {
        0
    };
    let mut groups: Vec<&str> = head;
    groups.extend(std::iter::repeat_n("0", fill.max(0) as usize));
    groups.extend(tail);
    if groups.len() != 8 {
        return None;
    }
    let mut values = [0.0; 8];
    for (value, group) in values.iter_mut().zip(groups) {
        let parsed = parse_int(group, Radix::Sixteen);
        if parsed.is_nan() || !(0.0..=65535.0).contains(&parsed) {
            return None;
        }
        *value = parsed;
    }
    Some(values)
}

/// `::ffff:a.b.c.d` (in any spelling) as the IPv4 address it carries
fn unmap_ipv4(ip: &str) -> Option<[u8; 4]> {
    let g = ipv6_groups(ip)?;
    if g[..5].iter().any(|v| *v != 0.0) || g[5] != 65535.0 {
        return None;
    }
    let (high, low) = (g[6] as u32, g[7] as u32);
    Some([
        (high >> 8) as u8,
        (high & 0xff) as u8,
        (low >> 8) as u8,
        (low & 0xff) as u8,
    ])
}

/// Whether plain http may reach this literal address: loopback or a private range
pub fn plain_http_allowed_ip(ip: &str) -> bool {
    let bare = strip_brackets(ip);
    match is_ip(&bare) {
        Ok(4) => parse_v4(&bare).is_some_and(|address| allowed_v4(&address)),
        Ok(6) => {
            if let Some(mapped) = unmap_ipv4(&bare) {
                return allowed_v4(&mapped);
            }
            parse_v6(&bare).is_some_and(|address| allowed_v6(&address))
        }
        _ => false,
    }
}

/// `Parsed`: the host of an http(s) URL with its brackets off, or the problem
enum Parsed {
    Url { https: bool, host: String },
    Problem(AddressProblem),
}

fn parse(raw: &str) -> Parsed {
    let Some((protocol, hostname)) = url_protocol_and_hostname(raw) else {
        return Parsed::Problem(AddressProblem::Invalid);
    };
    if protocol != "https:" && protocol != "http:" {
        return Parsed::Problem(AddressProblem::Scheme);
    }
    if hostname.is_empty() {
        return Parsed::Problem(AddressProblem::Invalid);
    }
    Parsed::Url {
        https: protocol == "https:",
        host: strip_brackets(&hostname),
    }
}

/// The check at registration, without looking anything up
pub fn check_server_address(raw: &str) -> AddressCheck {
    let (https, host) = match parse(raw) {
        Parsed::Problem(problem) => return AddressCheck::Refused(problem),
        Parsed::Url { https, host } => (https, host),
    };
    if https {
        return AddressCheck::Allowed {
            plain: false,
            must_resolve: false,
        };
    }
    if is_ip(&host) != Ok(0) {
        return if plain_http_allowed_ip(&host) {
            AddressCheck::Allowed {
                plain: true,
                must_resolve: false,
            }
        } else {
            AddressCheck::Refused(AddressProblem::PublicHttp)
        };
    }
    if host.to_lowercase() == "localhost" {
        return AddressCheck::Allowed {
            plain: true,
            must_resolve: false,
        };
    }
    AddressCheck::Allowed {
        plain: true,
        must_resolve: true,
    }
}

/// What `resolve` rejects with: the host name does not resolve
#[derive(Debug, Clone, PartialEq)]
pub struct ResolveFailed(pub String);

/// `HostResolver`: every address a host name resolves to; an `Err` when it
/// does not resolve
pub trait HostResolver {
    fn resolve(&self, host: &str) -> Result<Vec<String>, ResolveFailed>;
}

/// The check when connecting: an http host name (localhost included) passes
/// only when every address it resolves to is allowed for plain http.
pub fn check_resolved_server_address(raw: &str, resolver: &dyn HostResolver) -> AddressCheck {
    let first = check_server_address(raw);
    if !matches!(first, AddressCheck::Allowed { plain: true, .. }) {
        return first;
    }
    let host = match parse(raw) {
        Parsed::Url { host, .. } if is_ip(&host) == Ok(0) => host,
        _ => {
            return AddressCheck::Allowed {
                plain: true,
                must_resolve: false,
            };
        }
    };
    let Ok(addresses) = resolver.resolve(&host) else {
        return AddressCheck::Refused(AddressProblem::Unresolved);
    };
    if addresses.is_empty() {
        return AddressCheck::Refused(AddressProblem::Unresolved);
    }
    if !addresses.iter().all(|a| plain_http_allowed_ip(a)) {
        return AddressCheck::Refused(AddressProblem::PublicHttp);
    }
    AddressCheck::Allowed {
        plain: true,
        must_resolve: false,
    }
}
