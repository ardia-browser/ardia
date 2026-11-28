#!/usr/bin/env python3
"""Usage: generate-baseline-profile.py [--serial SERIAL] [--apk APK] [--runs N] [--input RAW_DUMP] [--output PATH] [--self-test]

Captures a startup ART profile from a connected Android device running an unobfuscated (--no-r8) build
and writes exact hot/startup (H/S) HRF rules to apps/phone/android/app/src/main/baseline-prof.txt.
Excludes androidx.* (which merges its own AAR baseline profiles) and compiler-generated synthetic lambdas.
Pass --input <dump.txt> to filter an existing `cmd package dump-profiles` output offline.
"""
import argparse
import pathlib
import re
import subprocess
import sys
import time
from collections import defaultdict

PRIMS = {
    "void": "V", "boolean": "Z", "byte": "B", "char": "C",
    "short": "S", "int": "I", "long": "J", "float": "F", "double": "D",
}
METH_RE = re.compile(r"^([^\s]+)\s+([^\s(]+)\.([^.(]+)\(([^)]*)\)")
DEFAULT_PREFIXES = ("com.ardia.", "com.facebook.react.", "expo.", "com.swmansion.", "com.horcrux.")
DEFAULT_PACKAGE = "com.ardia.browser.android.dev"
DEFAULT_URL = "https://en.wikipedia.org/wiki/Android_%28operating_system%29"


def to_descriptor(type_name):
    type_name = type_name.strip()
    arrays = ""
    while type_name.endswith("[]"):
        arrays += "["
        type_name = type_name[:-2]
    if type_name in PRIMS:
        return arrays + PRIMS[type_name]
    return arrays + "L" + type_name.replace(".", "/") + ";"


def parse_profile_dump(text, prefixes=DEFAULT_PREFIXES):
    methods = defaultdict(set)
    classes = set()
    section = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line == "hot methods:":
            section = "H"
            continue
        if line == "startup methods:":
            section = "S"
            continue
        if line == "post startup methods:":
            section = "P"
            continue
        if line == "classes:":
            section = "C"
            continue
        if line.startswith("base.apk") or line.startswith("===") or not line:
            if line.startswith("base.apk") or line.startswith("==="):
                section = None
            continue
        if section not in ("H", "S"):
            continue
        match = METH_RE.match(line)
        if not match:
            continue
        ret, cls, name, args = match.groups()
        if "$$ExternalSynthetic" in cls or "$$Lambda" in cls or "[" in cls or "]" in cls:
            continue
        if not cls.startswith(prefixes):
            continue
        arg_desc = "".join(to_descriptor(arg) for arg in args.split(",") if arg.strip())
        cls_desc = f"L{cls.replace('.', '/')};"
        sig = f"{cls_desc}->{name}({arg_desc}){to_descriptor(ret)}"
        methods[sig].add(section)
        classes.add(cls_desc)
    out = sorted(classes) + [
        f"{''.join(flag for flag in ('H', 'S') if flag in methods[sig])}{sig}"
        for sig in sorted(methods)
    ]
    return out, len(classes), len(methods)


def adb_cmd(serial, *args):
    base = ["adb"]
    if serial:
        base += ["-s", serial]
    return base + list(args)


def wait_for(deadline, predicate, step=0.25):
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return False


def capture_from_device(serial, pkg, apk, runs, url):
    if apk:
        subprocess.run(adb_cmd(serial, "install", "-r", apk), check=True)
    subprocess.run(adb_cmd(serial, "shell", "cmd", "package", "compile", "--reset", pkg), check=False)
    for _ in range(runs):
        subprocess.run(adb_cmd(serial, "shell", "am", "force-stop", pkg), check=True)
        wait_for(time.monotonic() + 5.0, lambda: not subprocess.run(adb_cmd(serial, "shell", "pidof", pkg), capture_output=True, text=True).stdout.strip())
        subprocess.run(
            adb_cmd(serial, "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", url, pkg),
            check=True,
            stdout=subprocess.DEVNULL,
        )
        wait_for(time.monotonic() + 4.0, lambda: False, step=0.5)
    pid = subprocess.run(adb_cmd(serial, "shell", "pidof", pkg), capture_output=True, text=True).stdout.strip()
    if pid:
        subprocess.run(adb_cmd(serial, "shell", "kill", "-USR1", pid), check=False)
        wait_for(time.monotonic() + 2.0, lambda: False, step=0.5)
    subprocess.run(adb_cmd(serial, "shell", "cmd", "package", "dump-profiles", pkg), check=True)
    dump = subprocess.run(
        adb_cmd(serial, "shell", "cat", f"/data/misc/profman/{pkg}-primary.prof.txt"),
        capture_output=True,
        text=True,
        check=True,
    )
    return dump.stdout


def self_test():
    sample = "\n".join([
        "base.apk [index=0]",
        "\thot methods:",
        "\t\tvoid com.ardia.phone.MainActivity.onCreate(android.os.Bundle)[],",
        "\t\tvoid com.ardia.phone.MainActivity$$ExternalSyntheticLambda0.run()[],",
        "\t\tvoid androidx.compose.ui.Node.draw()[],",
        "\tstartup methods:",
        "\t\tvoid com.ardia.phone.MainActivity.onCreate(android.os.Bundle)[],",
        "\t\tint com.facebook.react.bridge.Catalyst.init(java.lang.String[], boolean)[],",
        "\tpost startup methods:",
        "\t\tvoid com.ardia.phone.Rare.later()[],",
    ])
    lines, cls_count, meth_count = parse_profile_dump(sample)
    assert cls_count == 2, lines
    assert meth_count == 2, lines
    assert "HSLcom/ardia/phone/MainActivity;->onCreate(Landroid/os/Bundle;)V" in lines, lines
    assert "SLcom/facebook/react/bridge/Catalyst;->init([Ljava/lang/String;Z)I" in lines, lines
    assert not any("ExternalSynthetic" in line or "androidx" in line or "Rare" in line for line in lines), lines
    print("self-test passed")


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("-h", "--help", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--serial", default=None)
    parser.add_argument("--package", default=DEFAULT_PACKAGE)
    parser.add_argument("--apk", default=None)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--input", default=None)
    parser.add_argument(
        "--output",
        default=str(pathlib.Path(__file__).resolve().parents[1] / "android/app/src/main/baseline-prof.txt"),
    )
    args = parser.parse_args()
    if args.help:
        print(__doc__.strip())
        sys.exit(0)
    if args.self_test:
        self_test()
        sys.exit(0)
    raw = pathlib.Path(args.input).read_text() if args.input else capture_from_device(args.serial, args.package, args.apk, args.runs, args.url)
    lines, cls_count, meth_count = parse_profile_dump(raw)
    out_path = pathlib.Path(args.output)
    out_path.write_text("\n".join(lines) + "\n")
    print(f"wrote {out_path}: {cls_count} classes, {meth_count} exact H/S methods ({len(lines)} lines)")


if __name__ == "__main__":
    main()
