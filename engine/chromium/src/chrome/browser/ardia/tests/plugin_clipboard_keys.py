#!/usr/bin/env python3
import argparse
import os
import re
import sys

EDITING_BEHAVIOR = "third_party/blink/renderer/core/editing/editing_behavior.cc"
KEYBOARD_CODES = "ui/events/keycodes/keyboard_codes_posix.h"
HEADER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ac_cli_plugin_clipboard_keys.h")
CLIPBOARD_COMMANDS = {"Copy", "Cut", "Paste", "PasteAndMatchStyle", "PasteGlobalSelection"}
CDP_MODIFIERS = {
    "kAltKey": [1], "kOptionKey": [1], "kCtrlKey": [2], "kMetaKey": [4], "kCommandKey": [4], "kShiftKey": [8],
    "OPTION_OR_CTRL_KEY": [1, 2], "0": [0],
}


def table(source, name):
    start = source.index(name)
    body = source[source.index("{", start) + 1:source.index("};", start)]
    return re.findall(r"\{\s*([^,{}]+?)\s*,\s*([^,{}]+?)\s*,\s*\"([A-Za-z]+)\"\s*\}", body)


def modifier_sets(text):
    sets = [0]
    for part in [p.strip() for p in text.split("|")]:
        if part not in CDP_MODIFIERS:
            raise ValueError(f"unknown modifier {part}")
        sets = [s | bit for s in sets for bit in CDP_MODIFIERS[part]]
    return sets


def key_code(text, codes):
    if re.fullmatch(r"'.'", text):
        return ord(text[1])
    if text in codes:
        return codes[text]
    raise ValueError(f"unknown key {text}")


def entries(chromium_src):
    source = open(os.path.join(chromium_src, EDITING_BEHAVIOR)).read()
    codes = {name: int(value, 0) for name, value in
             re.findall(r"^\s*(VKEY_\w+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)", open(os.path.join(chromium_src, KEYBOARD_CODES)).read(), re.M)}
    found = set()
    for name in ("kKeyboardCodeKeyDownEntries", "kKeyboardCodeKeyPressEntries"):
        for key, modifiers, command in table(source, name):
            if command in CLIPBOARD_COMMANDS:
                for bits in modifier_sets(modifiers):
                    found.add((key_code(key, codes), bits, ""))
    for key, modifiers, command in table(source, "kDomKeyKeyDownEntries"):
        if command in CLIPBOARD_COMMANDS:
            for bits in modifier_sets(modifiers):
                found.add((0, bits, key.strip('"')))
    return sorted(found)


def header_text(rows):
    lines = [
        "// Copyright 2026 Ardia. Apache-2.0.",
        "",
        "#ifndef CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_CLIPBOARD_KEYS_H_",
        "#define CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_CLIPBOARD_KEYS_H_",
        "",
        "namespace ardia {",
        "",
        "struct PluginClipboardKey {",
        "  int windows_key_code;",
        "  int modifiers;",
        "  const char* dom_key;",
        "};",
        "",
        "inline constexpr PluginClipboardKey kPluginClipboardKeys[] = {",
    ]
    for code, bits, dom_key in rows:
        lines.append(f'    {{{code}, {bits}, "{dom_key}"}},')
    lines += ["};", "", "}", "", "#endif", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=(
        "Derives the key events Blink's editing behavior maps to cut, copy or paste on any platform "
        "(third_party/blink/renderer/core/editing/editing_behavior.cc) and writes ac_cli_plugin_clipboard_keys.h, "
        "the table the token policy refuses for plugin sessions. --check compares instead of writing."))
    parser.add_argument("--chromium-src", default=os.environ.get("CHROMIUM_SRC", os.path.expanduser("~/chromium-build/chromium_git/chromium/src")))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = header_text(entries(args.chromium_src))
    if args.check:
        same = os.path.exists(HEADER) and open(HEADER).read() == text
        print("up to date" if same else f"{HEADER} differs from {EDITING_BEHAVIOR}; run without --check")
        return 0 if same else 1
    open(HEADER, "w").write(text)
    print(f"wrote {HEADER}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
