//! packages/file-parse/src/opc.ts.

use jscompat::{decode_uri_component, js_regex};

pub fn resolve_target(base_part: &str, target: &str) -> String {
    if js_regex!(r"^[A-Za-z][A-Za-z0-9+.-]*:").test(target) {
        return String::new();
    }
    let Ok(decoded) = decode_uri_component(target) else {
        return String::new();
    };
    let normalized = decoded.replace('\\', "/");
    let mut parts: Vec<&str> = if normalized.starts_with('/') {
        Vec::new()
    } else {
        base_part
            .rsplit_once('/')
            .map_or("", |(dir, _)| dir)
            .split('/')
            .filter(|part| !part.is_empty())
            .collect()
    };
    for segment in normalized.split('/') {
        match segment {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(segment),
        }
    }
    parts.join("/")
}
