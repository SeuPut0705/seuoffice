# Drives Hancom Hangul 2024 through its official automation interface (HWPFrame.HwpObject)
# and records what Hangul reads from each file.
#
#   python hancom.py look --out <dir> <file-or-folder>... [--match REGEX] [--marks a,b]
#                         [--timeout SECONDS] [--no-hwpml] [--fresh] [--new]
#
# For every file: opened, pages, control counts by id (tbl = table, gso = picture/shape,
# %clk = click-here form field, secd = section, fn = footnote, head/foot = header/footer),
# the plain text (UNICODE), the page setup of the first section, the char/para shape at the top, and for
# every mark given with --marks the char/para shape of the first match. The whole document as
# Hangul's own XML (HWPML 2.x, binary data stripped) goes to <out>/hwpml/<name>.xml: tables
# with their row/column/cell counts, page setup per section, header/footer and footnote text,
# form fields. Results merge into <out>/look.json (keyed by file name), so a long run can be
# resumed; --fresh starts the file over, --new reads only files not in it yet.
#
# Only one Hangul process is driven at a time. A file that takes longer than --timeout seconds
# gets the Hangul process this script started killed (never any other Hangul window), and the
# run continues with a fresh instance.
import argparse
import json
import os
import re
import subprocess
import threading
import time

import win32com.client as win32

# Answer every message box with its default / "no" so nothing blocks the automation.
BOX = 0x1 | 0x20 | 0x100 | 0x2000 | 0x20000 | 0x200000
FILE_RX = r"\.(hwp|hwpx|odt|docx)$"
state = {}


def hwp_pids():
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq Hwp.exe", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, encoding="cp949", errors="replace",
    ).stdout
    return {int(m.group(1)) for m in re.finditer(r'"Hwp\.exe","(\d+)"', out)}


def start():
    before = hwp_pids()
    hwp = win32.gencache.EnsureDispatch("HWPFrame.HwpObject")
    state["ours"] = hwp_pids() - before
    hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
    hwp.SetMessageBoxMode(BOX)
    state["hwp"] = hwp


def kill_ours():
    """Kills only the Hangul processes this script started."""
    for pid in state.get("ours", ()):
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
    state["ours"] = set()


def stop():
    try:
        state["hwp"].Clear(1)
        state["hwp"].Quit()
    except Exception:
        pass
    time.sleep(0.5)
    left = state.get("ours", set()) & hwp_pids()
    if left:
        kill_ours()


def page_setup(hwp):
    try:
        act = hwp.CreateAction("PageSetup")
        pset = act.CreateSet()
        act.GetDefault(pset)
        page = pset.Item("PageDef")
        keys = ["PaperWidth", "PaperHeight", "LeftMargin", "RightMargin", "TopMargin",
                "BottomMargin", "HeaderLen", "FooterLen", "Landscape"]
        return {k: int(page.Item(k)) for k in keys}
    except Exception as thrown:
        return {"error": str(thrown)[:120]}


def find(hwp, text):
    """Selects the first match of text in the document body (tables included)."""
    hwp.MovePos(2)
    pset = hwp.HParameterSet.HFindReplace
    hwp.HAction.GetDefault("RepeatFind", pset.HSet)
    pset.FindString = text
    pset.Direction = 2  # the whole document
    pset.IgnoreMessage = 1
    pset.FindType = 1
    return bool(hwp.HAction.Execute("RepeatFind", pset.HSet))


def shape_here(hwp):
    return {
        "bold": int(hwp.CharShape.Item("Bold")),
        "height": int(hwp.CharShape.Item("Height")),
        "color": int(hwp.CharShape.Item("TextColor")),
        "align": int(hwp.ParaShape.Item("AlignType")),
    }


def hwpml(hwp):
    """The document as HWPML 2.x without the embedded binary data."""
    xml = hwp.GetTextFile("HWPML2X", "") or ""
    xml = re.sub(r"<BINDATASTORAGE[\s\S]*?</BINDATASTORAGE>", "", xml)
    return xml.replace('encoding="UTF-16"', 'encoding="UTF-8"', 1)


def look(path, opts):
    hwp = state["hwp"]
    hwp.Clear(1)
    began = time.time()
    row = {"opened": bool(hwp.Open(path, "", "forceopen:true"))}
    if not row["opened"]:
        return row
    row["openSeconds"] = round(time.time() - began, 2)
    row["pages"] = int(hwp.PageCount)
    ctrls = {}
    ctrl = hwp.HeadCtrl
    while ctrl:
        ctrls[ctrl.CtrlID] = ctrls.get(ctrl.CtrlID, 0) + 1
        ctrl = ctrl.Next
    row["ctrls"] = ctrls
    row["tables"] = ctrls.get("tbl", 0)
    row["text"] = hwp.GetTextFile("UNICODE", "") or ""
    row["page"] = page_setup(hwp)
    hwp.MovePos(2)
    try:
        row["char0"] = {k: int(hwp.CharShape.Item(k)) for k in ("Height", "Bold", "TextColor")}
        row["para0"] = {k: int(hwp.ParaShape.Item(k)) for k in ("AlignType", "LineSpacing")}
    except Exception:
        pass
    marks = {}
    for mark in opts.marks:
        try:
            marks[mark] = shape_here(hwp) if find(hwp, mark) else None
        except Exception as thrown:
            marks[mark] = {"error": str(thrown)[:120]}
    if marks:
        row["marks"] = marks
    if opts.hwpml:
        name = os.path.basename(path)
        with open(os.path.join(opts.out, "hwpml", name + ".xml"), "w", encoding="utf-8") as f:
            f.write(hwpml(hwp))
    row["seconds"] = round(time.time() - began, 2)
    return row


def listing(items, pattern):
    rx = re.compile(pattern, re.I)
    paths = []
    for item in items:
        item = os.path.abspath(item)
        if os.path.isdir(item):
            paths += [os.path.join(item, n) for n in sorted(os.listdir(item)) if rx.search(n)]
        else:
            paths.append(item)
    return paths


def run(paths, opts):
    out_file = os.path.join(opts.out, "look.json")
    results = {}
    if os.path.exists(out_file) and not opts.fresh:
        with open(out_file, encoding="utf-8") as f:
            results = json.load(f)
    start()
    try:
        for path in paths:
            name = os.path.basename(path)
            if opts.new and results.get(name, {}).get("opened"):
                continue
            timed_out = {"hit": False}

            def expire():
                timed_out["hit"] = True
                kill_ours()

            timer = threading.Timer(opts.timeout, expire)
            timer.start()
            failed = False
            try:
                results[name] = look(path, opts)
            except Exception as thrown:
                results[name] = {"opened": False, "error": str(thrown)[:200]}
                failed = True
            finally:
                timer.cancel()
            if timed_out["hit"]:
                results[name] = {"opened": False, "error": "timeout after %ds" % opts.timeout}
            if failed or timed_out["hit"]:
                kill_ours()
                start()
            row = results[name]
            print(name, row.get("opened"), row.get("pages"), row.get("tables"),
                  len(row.get("text", "")), row.get("seconds", ""), row.get("error", ""), flush=True)
            with open(out_file, "w", encoding="utf-8") as f:
                json.dump(results, f, ensure_ascii=False, indent=1)
    finally:
        stop()


def main():
    parser = argparse.ArgumentParser(description="What Hancom Hangul reads from documents")
    sub = parser.add_subparsers(dest="cmd", required=True)
    lk = sub.add_parser("look")
    lk.add_argument("items", nargs="+", help="files or folders")
    lk.add_argument("--out", required=True, help="folder for look.json and hwpml/")
    lk.add_argument("--match", default=FILE_RX, help="file name regex inside folders")
    lk.add_argument("--marks", default="", help="comma-separated texts to find")
    lk.add_argument("--timeout", type=int, default=180)
    lk.add_argument("--no-hwpml", dest="hwpml", action="store_false")
    lk.add_argument("--fresh", action="store_true", help="ignore an existing look.json")
    lk.add_argument("--new", action="store_true", help="skip files look.json already has")
    opts = parser.parse_args()
    opts.out = os.path.abspath(opts.out)
    opts.marks = [m for m in opts.marks.split(",") if m]
    os.makedirs(os.path.join(opts.out, "hwpml"), exist_ok=True)
    run(listing(opts.items, opts.match), opts)


main()
