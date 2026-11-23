#ifndef ARDIA_DESKTOP_AC_DESKTOP_WINDOW_COMMANDS_H_
#define ARDIA_DESKTOP_AC_DESKTOP_WINDOW_COMMANDS_H_

#include <optional>
#include <string_view>

namespace ardia::desktop_commands {

inline constexpr char kToggleFullScreenCall[] = "ArdiaShell.toggleFullScreen";
inline constexpr char kEditCapability[] = "tab.edit";
inline constexpr char kEditCommand[] = "edit";
inline constexpr char kReadTextCall[] = "ArdiaShell.readText";
inline constexpr const char* kWindowCommandCapabilities[] = {"ArdiaShell.toggleFullScreen", "tab.edit",
                                                             "ArdiaShell.readText"};

enum class EditAction { kUndo, kRedo, kCut, kCopy, kPaste, kPasteAndMatchStyle, kSelectAll };

struct EditName {
  std::string_view name;
  EditAction action;
};

inline constexpr EditName kEditActions[] = {
    {"undo", EditAction::kUndo},
    {"redo", EditAction::kRedo},
    {"cut", EditAction::kCut},
    {"copy", EditAction::kCopy},
    {"paste", EditAction::kPaste},
    {"pasteAndMatchStyle", EditAction::kPasteAndMatchStyle},
    {"selectAll", EditAction::kSelectAll},
};

constexpr std::optional<EditAction> ParseEditAction(std::string_view name) {
  for (const EditName& known : kEditActions) {
    if (known.name == name) return known.action;
  }
  return std::nullopt;
}

constexpr bool FullScreenAfterToggle(bool window_full_screen) {
  return !window_full_screen;
}

}

#endif
