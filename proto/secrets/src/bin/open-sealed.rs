//! open-sealed --user-data <dir> --json <file>   decrypt every `sealed:v1:` string value
//! open-sealed --user-data <dir> --blob <base64> decrypt one bare blob
//! open-sealed --user-data <dir> --json <file> --inspect   print blob shapes only
//! open-sealed --probe [--service S --account A]  read one keychain item (macOS), print its length only
//!
//! stdout: one JSON object `{key: plaintext}` (or the probe/inspect result).
//! Any failure: nothing on stdout, one JSON line on stderr with the stage and the
//! OS code, exit code 1. Bad usage: exit 2.

use seuoffice_secrets::{blob_of, describe_blob, probe_keychain_item, OpenError, Opener, Options, SEALED_PREFIX};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::process::ExitCode;

#[derive(Default)]
struct Args {
    user_data: Option<String>,
    json: Option<String>,
    blob: Option<String>,
    inspect: bool,
    probe: bool,
    allow_interaction: bool,
    service: Option<String>,
    account: Option<String>,
}

fn parse() -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match flag.as_str() {
            "--user-data" => a.user_data = Some(value("--user-data")?),
            "--json" => a.json = Some(value("--json")?),
            "--blob" => a.blob = Some(value("--blob")?),
            "--service" => a.service = Some(value("--service")?),
            "--account" => a.account = Some(value("--account")?),
            "--inspect" => a.inspect = true,
            "--probe" => a.probe = true,
            "--allow-interaction" => a.allow_interaction = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(a)
}

fn collect(prefix: &str, v: &Value, out: &mut Vec<(String, String)>) {
    match v {
        Value::String(s) if s.starts_with(SEALED_PREFIX) => out.push((prefix.to_string(), s.clone())),
        Value::Array(items) => items.iter().enumerate().for_each(|(i, x)| collect(&format!("{prefix}[{i}]"), x, out)),
        Value::Object(map) => map.iter().for_each(|(k, x)| {
            let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
            collect(&path, x, out)
        }),
        _ => {}
    }
}

fn fail(key: Option<&str>, e: &OpenError) -> ExitCode {
    eprintln!(
        "{}",
        json!({ "error": e.message, "stage": e.stage, "osCode": e.os_code, "key": key })
    );
    ExitCode::from(1)
}

fn usage(msg: &str) -> ExitCode {
    eprintln!("open-sealed: {msg}");
    ExitCode::from(2)
}

fn emit(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
}

fn main() -> ExitCode {
    let args = match parse() {
        Ok(a) => a,
        Err(m) => return usage(&m),
    };
    let mut options = Options { allow_interaction: args.allow_interaction, ..Options::default() };
    if let Some(s) = &args.service {
        options.keychain_service = s.clone();
    }
    if let Some(a) = &args.account {
        options.keychain_account = a.clone();
    }

    if args.probe {
        return match probe_keychain_item(&options.keychain_service, &options.keychain_account, options.allow_interaction) {
            Ok(len) => {
                emit(&json!({ "service": options.keychain_service, "account": options.keychain_account, "passwordBytes": len }));
                ExitCode::SUCCESS
            }
            Err(e) => fail(None, &e),
        };
    }

    let mut items: Vec<(String, String)> = Vec::new();
    if let Some(blob) = &args.blob {
        items.push(("blob".into(), blob.clone()));
    }
    if let Some(path) = &args.json {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => return fail(None, &OpenError::os("read", format!("{path}: {e}"), e.raw_os_error().unwrap_or(0))),
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(v) => collect("", &v, &mut items),
            Err(e) => return fail(None, &OpenError::new("json", format!("{path}: {e}"))),
        }
    }
    if items.is_empty() {
        return usage("no sealed values: give --json <file> and/or --blob <base64>");
    }

    if args.inspect {
        let mut shapes = Map::new();
        for (key, sealed) in &items {
            match blob_of(sealed) {
                Ok(b) => shapes.insert(key.clone(), Value::String(describe_blob(&b))),
                Err(e) => return fail(Some(key), &e),
            };
        }
        emit(&Value::Object(shapes));
        return ExitCode::SUCCESS;
    }

    let Some(user_data) = args.user_data else { return usage("--user-data <dir> is required") };
    let opener = Opener::new(user_data, options);
    let mut plain = Map::new();
    for (key, sealed) in &items {
        match opener.open(sealed) {
            Ok(p) => {
                plain.insert(key.clone(), Value::String(p));
            }
            Err(e) => return fail(Some(key), &e),
        }
    }
    emit(&Value::Object(plain));
    ExitCode::SUCCESS
}
