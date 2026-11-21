// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_CLIPBOARD_KEYS_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_CLIPBOARD_KEYS_H_

namespace ardia {

struct PluginClipboardKey {
  int windows_key_code;
  int modifiers;
  const char* dom_key;
};

inline constexpr PluginClipboardKey kPluginClipboardKeys[] = {
    {0, 0, "Copy"},
    {0, 0, "Cut"},
    {0, 0, "Paste"},
    {45, 2, ""},
    {45, 8, ""},
    {46, 8, ""},
    {67, 2, ""},
    {86, 2, ""},
    {86, 10, ""},
    {88, 2, ""},
};

}

#endif
