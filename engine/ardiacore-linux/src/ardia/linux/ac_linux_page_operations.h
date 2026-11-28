#ifndef ARDIA_LINUX_AC_LINUX_PAGE_OPERATIONS_H_
#define ARDIA_LINUX_AC_LINUX_PAGE_OPERATIONS_H_

#include <stddef.h>

#include <array>
#include <string_view>

namespace ardiacore {

enum class LinuxPageOperationArgs { kNone, kReplace, kLook, kPoint, kSelectors };

struct LinuxPageOperation {
  std::string_view name;
  size_t length;
  std::string_view sha256;
  LinuxPageOperationArgs args;
  std::string_view suffix;
};

inline constexpr int kLinuxReaderLookSizes = 5;
inline constexpr std::array<std::string_view, 2> kLinuxReaderLookFonts = {{"serif", "sans"}};

inline constexpr std::array<LinuxPageOperation, 16> kLinuxPageOperations = {{
    {"selectionContext", 1008, "62ba51dd7be1cd91d50b0589d3ed77c5f255976d926e396238962989cfe5bab6", LinuxPageOperationArgs::kNone, ""},
    {"hasSelection", 69, "9bb48919244a58886c424cbc69298a078e3d3958c320cb696c7ac697facdb811", LinuxPageOperationArgs::kNone, ""},
    {"jumpToSelection", 1751, "bac34cf89afc24d8bb87418864914717a177d14adeb141e91fdd111b0ecba730", LinuxPageOperationArgs::kNone, ""},
    {"replaceInField", 3685, "47debcd4188e773db97bd81d575c0b524ef0c4d1b444eb012a6f50a074cb9b2c", LinuxPageOperationArgs::kReplace, ")"},
    {"selectedText", 81, "e981a1488b91874e78f575240afb0c8fa7431ef388b18bb0c2338d0b31c77252", LinuxPageOperationArgs::kNone, ""},
    {"readerCheck", 17321, "99c3a530f4017937cdc7f88b251e80f0375d72bd7e35fa5c1be9096792650231", LinuxPageOperationArgs::kNone, ""},
    {"readerState", 16059, "8804b03bc48b17a566be0bfbca009e8b2e81fb532a51dd996d19951e300a15e2", LinuxPageOperationArgs::kNone, ""},
    {"readerHide", 16058, "48742461cede45bbb999671c5a4dccf32c3c0d02fcf3841d3ec9c5e0ce12f4b4", LinuxPageOperationArgs::kNone, ""},
    {"readerToggle", 48805, "b81f8ca01558e423e9dba155ae5e1457bc8b41d537c1d896abe2faae25480c81", LinuxPageOperationArgs::kLook, ")));"},
    {"readerOpen", 48803, "27c38da60f46cb93c6dda26052d50fdbb72a34c71175c005777e6a31154a3d2f", LinuxPageOperationArgs::kLook, ")));"},
    {"readerSetLook", 16056, "73ff30353564a1d77fd7fcd03018f3fa8e2fef0556bcbe984bb0e1c29ab8f129", LinuxPageOperationArgs::kLook, "])));"},
    {"elementPickerStart", 11786, "490ff1ba5b5599866acb2b045adb6df7d6c41a2bed4665f5b4750875cdc32c11", LinuxPageOperationArgs::kPoint, "])).then((v) => { window[Symbol.for(\"ardia.elementPicker\")].linuxPick = { value: v === undefined ? null : v }; }, () => { window[Symbol.for(\"ardia.elementPicker\")].linuxPick = { value: null }; });"},
    {"elementPickerTake", 324, "0f0eaa1b3b91b91af67550c35b0afcfe7d0310c9ef3a06855624985631327045", LinuxPageOperationArgs::kNone, ""},
    {"elementPickerCancel", 11868, "753ae055619b0735d973eb98340e7da0b14c957e5c5ad6b7ea53f80fcbc01225", LinuxPageOperationArgs::kNone, ""},
    {"elementPickerApply", 11786, "673cd7508f84bd165adbe2aa91717e83ae5c6a771cc6a2c21a3a191e2c6ccbc7", LinuxPageOperationArgs::kSelectors, "])).then((v) => post(\"result\", JSON.stringify(v)), () => post(\"result\", \"null\"));"},
    {"elementPickerUnhide", 11787, "04b291227d20ea59c29c854a143479dac0d672e1eddb538a8eca05f40b43ed7a", LinuxPageOperationArgs::kSelectors, "])).then((v) => post(\"result\", JSON.stringify(v)), () => post(\"result\", \"null\"));"},
}};

}

#endif
