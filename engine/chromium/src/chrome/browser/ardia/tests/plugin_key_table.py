#!/usr/bin/env python3
import argparse
import os
import re
import sys

KEYCODES = "ui/events/keycodes"
HEADER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ac_cli_plugin_key_table.h")


def read(chromium_src, rel):
    return open(os.path.join(chromium_src, KEYCODES, rel)).read()


def unescape_char(text):
    body = text[1:-1]
    if body.startswith("\\"):
        return {"\\\\": "\\", "\\'": "'", '\\"': '"', "\\t": "\t", "\\n": "\n"}.get(body, body[1:])
    return body


def table(source, name):
    start = source.index(name)
    return source[source.index("{", start) + 1:source.index("};", start)]


def rows(chromium_src):
    codes = dict((enum, string) for string, enum in
                 re.findall(r'DOM_CODE\(\s*0x[0-9a-fA-F]+\s*,[^"]*"([^"]*)"\s*,\s*(\w+)\s*\)', read(chromium_src, "dom/dom_code_data.inc")))
    keys = dict((enum, string) for string, enum in
                re.findall(r'DOM_KEY_(?:MAP|UNI)\(\s*"([^"]*)"\s*,\s*(\w+)\s*,', read(chromium_src, "dom/dom_key_data.inc")))
    vkeys = {name: int(value, 0) for name, value in
             re.findall(r"^\s*(VKEY_\w+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)", read(chromium_src, "keyboard_codes_posix.h"), re.M)}
    layout = read(chromium_src, "dom_us_layout_data.h")
    printable = {}
    for enum, base, shifted in re.findall(r"\{\s*DomCode::(\w+)\s*,\s*\{\s*('(?:\\.|[^'])')\s*,\s*('(?:\\.|[^'])')\s*\}\s*\}",
                                          table(layout, "kPrintableCodeMap[] = {")):
        printable[enum] = (unescape_char(base), unescape_char(shifted))
    named = {enum: keys[key] for enum, key in
             re.findall(r"\{\s*DomCode::(\w+)\s*,\s*DomKey::(\w+)\s*\}", table(layout, "kNonPrintableCodeMap[] = {"))
             if key in keys}
    virtual = {}
    for name in ("kDomCodeToKeyboardCodeMap[] = {", "kFallbackKeyboardCodeToDomCodeMap[] = {"):
        for enum, vkey in re.findall(r"\{\s*DomCode::(\w+)\s*,\s*(VKEY_\w+)\s*\}", table(layout, name)):
            if vkey in vkeys and enum in codes:
                virtual.setdefault(enum, set()).add(vkeys[vkey])
    found = set()
    for enum, vks in virtual.items():
        base, shifted = printable.get(enum, ("", ""))
        key = named.get(enum, "")
        if not (base or shifted or key):
            continue
        for vk in vks:
            if 0 <= vk <= 255:
                found.add((codes[enum], vk, base, shifted, key))
    return sorted(found)


def literal(text):
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def header_text(entries):
    lines = [
        "// Copyright 2026 Ardia. Apache-2.0.",
        "",
        "#ifndef CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_KEY_TABLE_H_",
        "#define CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_KEY_TABLE_H_",
        "",
        "namespace ardia {",
        "",
        "struct PluginKeyRow {",
        "  const char* code;",
        "  int windows_key_code;",
        "  const char* base;",
        "  const char* shifted;",
        "  const char* named;",
        "};",
        "",
        "inline constexpr PluginKeyRow kPluginKeyRows[] = {",
    ]
    for code, vk, base, shifted, named in entries:
        lines.append(f"    {{{literal(code)}, {vk}, {literal(base)}, {literal(shifted)}, {literal(named)}}},")
    lines += ["};", "", "}", "", "#endif", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=(
        "Derives which key, code and windowsVirtualKeyCode belong together from Chromium's own tables in "
        "ui/events/keycodes (DomCode, DomKey, the US printable and non-printable maps and the DomCode to KeyboardCode "
        "maps) and writes ac_cli_plugin_key_table.h, which the plugin key policy checks agreement against. "
        "--check compares instead of writing."))
    parser.add_argument("--chromium-src", default=os.environ.get("CHROMIUM_SRC", os.path.expanduser("~/chromium-build/chromium_git/chromium/src")))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = header_text(rows(args.chromium_src))
    if args.check:
        same = os.path.exists(HEADER) and open(HEADER).read() == text
        print("up to date" if same else f"{HEADER} differs from {KEYCODES}; run without --check")
        return 0 if same else 1
    open(HEADER, "w").write(text)
    print(f"wrote {HEADER}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
