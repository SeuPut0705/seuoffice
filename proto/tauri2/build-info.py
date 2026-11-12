#!/usr/bin/env python3
"""Writes build-info.json (proto/README.md): build-info.py <mac|win> <exe relative path> <out file> <build seconds>"""
import json
import platform
import subprocess
import sys
import tomllib
from pathlib import Path

os_name, exe, out, seconds = sys.argv[1:5]
lock = tomllib.loads((Path(__file__).parent / "src-tauri" / "Cargo.lock").read_text())
crate = {p["name"]: p["version"] for p in lock["package"]}
versions = {name: crate[name] for name in ("tauri", "tauri-runtime-wry", "wry", "tauri-plugin-dialog") if name in crate}
versions["tauri-cli"] = subprocess.run(["tauri", "--version"], capture_output=True, text=True, shell=(os_name == "win")).stdout.strip()
versions["rustc"] = subprocess.run(["rustc", "--version"], capture_output=True, text=True).stdout.strip()
if os_name == "mac":
    versions["macOS"] = platform.mac_ver()[0]
    versions["webview"] = "WKWebView (system)"
    versions.update({k: crate[k] for k in ("objc2", "objc2-web-kit", "objc2-app-kit") if k in crate})
else:
    reg = subprocess.run(
        ["reg", "query", r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}", "/v", "pv"],
        capture_output=True, text=True,
    ).stdout.split()
    versions["webview2Runtime"] = reg[-1] if reg else "unknown"
    versions["windows"] = platform.platform()
    versions.update({k: crate[k] for k in ("webview2-com", "windows") if k in crate})
info = {"shell": "tauri2", "os": os_name, "exe": exe, "versions": versions, "buildSeconds": int(seconds)}
Path(out).write_text(json.dumps(info, indent=2) + "\n")
print(json.dumps(info, indent=2))
