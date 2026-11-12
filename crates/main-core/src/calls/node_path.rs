//! The functions of group `node_path` (tools/main-diff/groups/node-path.ts):
//! `path.posix.<fn>` and `path.win32.<fn>` over `jscompat::node_path`.
//!
//! The functions that read `process.cwd()` take it as their first argument;
//! the win32 ones take the per-drive variables next, as an object from
//! `"C:"` to the value of `process.env["=C:"]` (or null).
//!
//! A `resolve` argument that is not a string is refused with Node's error,
//! naming the highest index; that is Node's answer as long as no string
//! after it is absolute (Node stops looking at an absolute one), which the
//! specs keep to.

use super::{Answer, CallError, Context, arg};
use jscompat::node_path::{ParsedPath, posix, win32};
use serde_json::{Map, Value};

/// `ERR_INVALID_ARG_TYPE` of `validateString` / `validateObject`.
fn invalid(name: &str, kind: &str, v: Option<&Value>) -> CallError {
    let received = match v {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Array(_)) => "an instance of Array".to_string(),
        Some(Value::Object(_)) => "an instance of Object".to_string(),
        Some(Value::Bool(b)) => format!("type boolean ({b})"),
        Some(Value::Number(n)) => {
            format!(
                "type number ({})",
                jscompat::number_to_string(n.as_f64().unwrap_or(f64::NAN))
            )
        }
        Some(Value::String(s)) => format!("type string ('{s}')"),
    };
    CallError {
        code: Some("ERR_INVALID_ARG_TYPE".to_string()),
        message: format!("The \"{name}\" argument must be of type {kind}. Received {received}"),
    }
}

fn string<'a>(name: &str, v: Option<&'a Value>) -> Result<&'a str, CallError> {
    match v {
        Some(Value::String(s)) => Ok(s),
        _ => Err(invalid(name, "string", v)),
    }
}

fn text(s: String) -> Answer {
    Ok(Some(Value::String(s)))
}

/// `resolve`'s arguments: the highest-index non-string is the error.
fn paths(args: &[Value]) -> Result<Vec<&str>, CallError> {
    if let Some(i) = args.iter().rposition(|v| !v.is_string()) {
        return Err(invalid(&format!("paths[{i}]"), "string", args.get(i)));
    }
    Ok(args.iter().filter_map(Value::as_str).collect())
}

fn parsed(p: ParsedPath) -> Answer {
    let mut m = Map::new();
    m.insert("root".into(), Value::String(p.root));
    m.insert("dir".into(), Value::String(p.dir));
    m.insert("base".into(), Value::String(p.base));
    m.insert("ext".into(), Value::String(p.ext));
    m.insert("name".into(), Value::String(p.name));
    Ok(Some(Value::Object(m)))
}

/// A field of the object given to `format`: `""` where it is falsy.
fn field(o: &Map<String, Value>, key: &str) -> String {
    let v = o.get(key);
    if jscompat::value_truthy(v) {
        jscompat::value_to_string(v)
    } else {
        String::new()
    }
}

fn path_object(v: Option<&Value>) -> Result<ParsedPath, CallError> {
    match v {
        Some(Value::Object(o)) => Ok(ParsedPath {
            root: field(o, "root"),
            dir: field(o, "dir"),
            base: field(o, "base"),
            ext: field(o, "ext"),
            name: field(o, "name"),
        }),
        _ => Err(invalid("pathObject", "object", v)),
    }
}

/// `process.env["=C:"]` from the spec's object.
fn drive_env(env: Option<&Value>) -> impl Fn(char) -> Option<String> + '_ {
    move |letter| {
        env.and_then(Value::as_object)
            .and_then(|o| o.get(&format!("{letter}:")))
            .and_then(Value::as_str)
            .map(str::to_string)
    }
}

pub(super) fn call(name: &str, args: &[Value], _cx: &mut Context) -> Option<Answer> {
    let rest = name.strip_prefix("path.")?;
    if let Some(f) = rest.strip_prefix("posix.") {
        return posix_call(f, args);
    }
    win32_call(rest.strip_prefix("win32.")?, args)
}

fn posix_call(f: &str, args: &[Value]) -> Option<Answer> {
    use posix::*;
    Some(match f {
        "sep" => text(SEP.to_string()),
        "delimiter" => text(DELIMITER.to_string()),
        "resolve" => (|| {
            let cwd = string("cwd", arg(args, 0))?;
            Ok(Some(Value::String(resolve_from(
                cwd,
                &paths(args.get(1..).unwrap_or(&[]))?,
            ))))
        })(),
        "normalize" => string("path", arg(args, 0)).and_then(|p| text(normalize(p))),
        "isAbsolute" => string("path", arg(args, 0)).map(|p| Some(Value::Bool(is_absolute(p)))),
        "join" => (|| {
            let mut parts = Vec::new();
            for a in args {
                parts.push(string("path", Some(a))?);
            }
            text(join(&parts))
        })(),
        "relative" => (|| {
            let cwd = string("cwd", arg(args, 0))?;
            let from = string("from", arg(args, 1))?;
            let to = string("to", arg(args, 2))?;
            text(relative_from(cwd, from, to))
        })(),
        "toNamespacedPath" => Ok(arg(args, 0).cloned()),
        "dirname" => string("path", arg(args, 0)).and_then(|p| text(dirname(p))),
        "basename" => (|| {
            let ext = match arg(args, 1) {
                None => None,
                v => Some(string("suffix", v)?),
            };
            let path = string("path", arg(args, 0))?;
            text(basename(path, ext))
        })(),
        "extname" => string("path", arg(args, 0)).and_then(|p| text(extname(p))),
        "parse" => string("path", arg(args, 0)).and_then(|p| parsed(parse(p))),
        "format" => path_object(arg(args, 0)).and_then(|o| text(format(&o))),
        _ => return None,
    })
}

fn win32_call(f: &str, args: &[Value]) -> Option<Answer> {
    use win32::*;
    Some(match f {
        "sep" => text(SEP.to_string()),
        "delimiter" => text(DELIMITER.to_string()),
        "resolve" => (|| {
            let cwd = string("cwd", arg(args, 0))?;
            let env = drive_env(arg(args, 1));
            let parts = paths(args.get(2..).unwrap_or(&[]))?;
            text(resolve_from_env(cwd, &env, &parts))
        })(),
        "normalize" => string("path", arg(args, 0)).and_then(|p| text(normalize(p))),
        "isAbsolute" => string("path", arg(args, 0)).map(|p| Some(Value::Bool(is_absolute(p)))),
        "join" => (|| {
            let mut parts = Vec::new();
            for a in args {
                parts.push(string("path", Some(a))?);
            }
            text(join(&parts))
        })(),
        "relative" => (|| {
            let cwd = string("cwd", arg(args, 0))?;
            let env = drive_env(arg(args, 1));
            let from = string("from", arg(args, 2))?;
            let to = string("to", arg(args, 3))?;
            text(relative_from_env(cwd, &env, from, to))
        })(),
        "toNamespacedPath" => (|| {
            let cwd = string("cwd", arg(args, 0))?;
            let env = drive_env(arg(args, 1));
            match arg(args, 2) {
                Some(Value::String(p)) => text(to_namespaced_path_from_env(cwd, &env, p)),
                other => Ok(other.cloned()),
            }
        })(),
        "dirname" => string("path", arg(args, 0)).and_then(|p| text(dirname(p))),
        "basename" => (|| {
            let ext = match arg(args, 1) {
                None => None,
                v => Some(string("suffix", v)?),
            };
            let path = string("path", arg(args, 0))?;
            text(basename(path, ext))
        })(),
        "extname" => string("path", arg(args, 0)).and_then(|p| text(extname(p))),
        "parse" => string("path", arg(args, 0)).and_then(|p| parsed(parse(p))),
        "format" => path_object(arg(args, 0)).and_then(|o| text(format(&o))),
        _ => return None,
    })
}
