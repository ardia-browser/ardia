#ifndef ARDIA_WIN_WEBUI_WEBUI_POLICY_H_
#define ARDIA_WIN_WEBUI_WEBUI_POLICY_H_

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace ardia_win {

inline constexpr wchar_t kReactNativeShell[] = L"rnw";
inline constexpr wchar_t kWebUIShell[] = L"webui";

inline constexpr bool WebUIShellSelected(std::wstring_view process_type,
                                         std::wstring_view shell,
                                         bool headless,
                                         bool react_native_app_present) {
  return process_type.empty() && shell != kReactNativeShell &&
         (shell == kWebUIShell || (!headless && !react_native_app_present));
}

inline constexpr char kMigrateFromRnwSwitch[] = "ardia-migrate-from-rnw";
inline constexpr char kNoMigrateSwitch[] = "ardia-no-migrate";
inline constexpr char kMigrateRnwDataSwitch[] = "ardia-migrate-rnw-data";
inline constexpr wchar_t kMigratorBinaryName[] = L"ardia-webui-migrate.exe";
inline constexpr unsigned long kStartupMigrationTimeoutMs = 60000;
inline constexpr int kStartupMigrationIncompleteExitCode = 75;

inline constexpr size_t kMigratorDocumentNameLimit = 200;
inline constexpr size_t kMigratorDocumentLimit = 64 * 1024 * 1024;
inline constexpr size_t kWindowsDocumentNameLimit = kMigratorDocumentNameLimit;
inline constexpr size_t kWindowsDocumentReadLimit = kMigratorDocumentLimit;
inline constexpr size_t kWindowsDocumentDefaultLimit = 8 * 1024 * 1024;
inline constexpr char kWindowsSyncStateDocument[] = "sync-state.nns";
inline constexpr size_t kWindowsSyncStateDocumentLimit = 48 * 1024 * 1024;
inline constexpr size_t kBootstrapDocumentMaxCount = 128;
inline constexpr size_t kBootstrapDocumentMaxBytes = 8 * 1024 * 1024;

inline constexpr const char* kReservedWindowsDocumentNames[] = {
    "session.json",       "live.json",
    "live.canonical.json", "rnw-migration.json",
    "rnw-migration.lock", "launch-starts.txt",
    "launch-starts.txt.tmp", "window-placement.txt",
};

inline constexpr char AsciiLower(char c) {
  return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
}

inline constexpr wchar_t WideAsciiLower(wchar_t c) {
  return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c;
}

inline constexpr bool AsciiEqualsIgnoreCase(std::string_view a,
                                            std::string_view b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    if (AsciiLower(a[i]) != AsciiLower(b[i])) {
      return false;
    }
  }
  return true;
}

inline constexpr bool AsciiEndsWithIgnoreCase(std::string_view text,
                                              std::string_view suffix) {
  if (text.size() < suffix.size()) {
    return false;
  }
  return AsciiEqualsIgnoreCase(text.substr(text.size() - suffix.size()), suffix);
}

inline constexpr bool IsWindowsSyncStateDocument(std::string_view name) {
  return AsciiEqualsIgnoreCase(name, kWindowsSyncStateDocument);
}

inline constexpr size_t WindowsDocumentLimit(std::string_view name) {
  return IsWindowsSyncStateDocument(name) ? kWindowsSyncStateDocumentLimit
                                          : kWindowsDocumentDefaultLimit;
}

inline constexpr bool WideAsciiEqualsIgnoreCase(std::wstring_view a,
                                                std::wstring_view b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    if (WideAsciiLower(a[i]) != WideAsciiLower(b[i])) {
      return false;
    }
  }
  return true;
}

inline constexpr bool IsWindowsReservedDeviceName(std::string_view name) {
  const size_t dot = name.find('.');
  std::string_view stem =
      dot == std::string_view::npos ? name : name.substr(0, dot);
  while (!stem.empty() && stem.back() == ' ') {
    stem.remove_suffix(1);
  }
  if (AsciiEqualsIgnoreCase(stem, "con") ||
      AsciiEqualsIgnoreCase(stem, "prn") ||
      AsciiEqualsIgnoreCase(stem, "aux") ||
      AsciiEqualsIgnoreCase(stem, "nul") ||
      AsciiEqualsIgnoreCase(stem, "conin$") ||
      AsciiEqualsIgnoreCase(stem, "conout$")) {
    return true;
  }
  if (stem.size() == 4 &&
      (AsciiEqualsIgnoreCase(stem.substr(0, 3), "com") ||
       AsciiEqualsIgnoreCase(stem.substr(0, 3), "lpt"))) {
    const char digit = stem[3];
    return digit >= '0' && digit <= '9';
  }
  return false;
}

inline constexpr bool ValidWindowsDocumentName(std::string_view name) {
  if (name.empty() || name.size() > kWindowsDocumentNameLimit ||
      name.front() == '.' || name.back() == '.' || name.front() == ' ' ||
      name.back() == ' ') {
    return false;
  }
  if (name.find("..") != std::string_view::npos) {
    return false;
  }
  for (const char c : name) {
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.')) {
      return false;
    }
  }
  return !IsWindowsReservedDeviceName(name);
}

inline constexpr bool ReservedWindowsDocumentName(std::string_view name) {
  for (const char* reserved : kReservedWindowsDocumentNames) {
    if (AsciiEqualsIgnoreCase(name, reserved)) {
      return true;
    }
  }
  return false;
}

inline constexpr const char* kEngineOwnedWindowsDocumentNames[] = {
    "launch-guard.json",
    "shell-recovery.json",
    "shell-recovery-previous.json",
};

inline constexpr bool EngineOwnedWindowsDocumentName(std::string_view name) {
  for (const char* owned : kEngineOwnedWindowsDocumentNames) {
    if (AsciiEqualsIgnoreCase(name, owned)) {
      return true;
    }
  }
  return false;
}

inline constexpr bool WritableWindowsDocumentName(std::string_view name) {
  return ValidWindowsDocumentName(name) && !ReservedWindowsDocumentName(name) &&
         !EngineOwnedWindowsDocumentName(name);
}

inline constexpr bool BootstrapDocumentEligible(std::string_view name) {
  return ValidWindowsDocumentName(name) && !ReservedWindowsDocumentName(name) &&
         !IsWindowsSyncStateDocument(name) &&
         !AsciiEndsWithIgnoreCase(name, ".tmp") &&
         !AsciiEndsWithIgnoreCase(name, ".partial") &&
         WindowsDocumentLimit(name) <= kBootstrapDocumentMaxBytes;
}

inline constexpr bool BootstrapDocumentFits(size_t count,
                                            size_t used_bytes,
                                            size_t file_bytes) {
  return count < kBootstrapDocumentMaxCount &&
         used_bytes <= kBootstrapDocumentMaxBytes &&
         file_bytes <= kBootstrapDocumentMaxBytes - used_bytes;
}

inline std::string JsonStringLiteral(std::string_view utf8) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(utf8.size() + 2);
  out.push_back('"');
  for (size_t i = 0; i < utf8.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(utf8[i]);
    if (c == '"' || c == '\\') {
      out.push_back('\\');
      out.push_back(static_cast<char>(c));
    } else if (c == '<') {
      out.append("\\u003c");
    } else if (c < 0x20 || c == 0x7f) {
      out.append("\\u00");
      out.push_back(kHex[c >> 4]);
      out.push_back(kHex[c & 0xf]);
    } else if (c == 0xe2 && i + 2 < utf8.size() &&
               static_cast<unsigned char>(utf8[i + 1]) == 0x80 &&
               (static_cast<unsigned char>(utf8[i + 2]) == 0xa8 ||
                static_cast<unsigned char>(utf8[i + 2]) == 0xa9)) {
      out.append(static_cast<unsigned char>(utf8[i + 2]) == 0xa8 ? "\\u2028"
                                                                 : "\\u2029");
      i += 2;
    } else {
      out.push_back(static_cast<char>(c));
    }
  }
  out.push_back('"');
  return out;
}

inline std::string BootstrapAssignmentScript(std::string_view bootstrap_json) {
  return "globalThis.__ardiaBootstrap=JSON.parse(" +
         JsonStringLiteral(bootstrap_json) + ");";
}

inline constexpr std::string_view DownloadCommandForRoute(
    std::string_view route) {
  if (route == "downloads.cancel") {
    return "cancel";
  }
  if (route == "downloads.pause") {
    return "pause";
  }
  if (route == "downloads.resume") {
    return "resume";
  }
  if (route == "downloads.keep") {
    return "keep";
  }
  return {};
}

inline constexpr bool ValidWindowsAssetPath(std::string_view path) {
  if (path.empty() || path.size() > 1024 || path.front() == '/' ||
      path.back() == '/') {
    return false;
  }
  while (!path.empty()) {
    const size_t slash = path.find('/');
    const std::string_view component = path.substr(0, slash);
    if (!ValidWindowsDocumentName(component)) {
      return false;
    }
    if (slash == std::string_view::npos) {
      return true;
    }
    path.remove_prefix(slash + 1);
  }
  return false;
}

inline constexpr bool IsAsciiDriveLetter(wchar_t c) {
  return (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z');
}

inline bool ValidWinRelativeBody(std::wstring_view body) {
  if (body.empty()) {
    return true;
  }
  size_t pos = 0;
  while (pos < body.size()) {
    const size_t slash = body.find(L'\\', pos);
    const std::wstring_view segment =
        slash == std::wstring_view::npos ? body.substr(pos)
                                         : body.substr(pos, slash - pos);
    if (segment.empty() || segment == L"." || segment == L"..") {
      return false;
    }
    if (slash == std::wstring_view::npos) {
      return true;
    }
    pos = slash + 1;
  }
  return false;
}

inline std::optional<std::wstring> NormalizeWinFinalPath(std::wstring_view raw) {
  if (raw.empty() || raw.find(L'\0') != std::wstring_view::npos) {
    return std::nullopt;
  }
  std::wstring path(raw);
  std::replace(path.begin(), path.end(), L'/', L'\\');
  if (path.starts_with(L"\\\\.\\")) {
    return std::nullopt;
  }
  if (path.starts_with(L"\\\\?\\")) {
    const std::wstring_view rest = std::wstring_view(path).substr(4);
    if (rest.size() >= 4 && WideAsciiEqualsIgnoreCase(rest.substr(0, 4), L"UNC\\")) {
      path = L"\\\\" + std::wstring(rest.substr(4));
    } else if (rest.size() >= 7 &&
               WideAsciiEqualsIgnoreCase(rest.substr(0, 7), L"Volume{")) {
      const size_t close = rest.find(L'}');
      if (close == std::wstring_view::npos || close + 1 >= rest.size() ||
          rest[close + 1] != L'\\') {
        return std::nullopt;
      }
      const size_t root_len = 4 + close + 2;
      while (path.size() > root_len && path.back() == L'\\') {
        path.pop_back();
      }
      const std::wstring_view tail = std::wstring_view(path).substr(root_len);
      if (!ValidWinRelativeBody(tail)) {
        return std::nullopt;
      }
      return path;
    } else if (rest.size() >= 3 && IsAsciiDriveLetter(rest[0]) &&
               rest[1] == L':' && rest[2] == L'\\') {
      path = std::wstring(rest);
    } else {
      return std::nullopt;
    }
  }
  if (path.starts_with(L"\\\\")) {
    const std::wstring_view rest = std::wstring_view(path).substr(2);
    const size_t server_end = rest.find(L'\\');
    if (server_end == 0 || server_end == std::wstring_view::npos) {
      return std::nullopt;
    }
    const std::wstring_view server = rest.substr(0, server_end);
    if (server == L"." || server == L".." || server == L"?") {
      return std::nullopt;
    }
    const std::wstring_view after_server = rest.substr(server_end + 1);
    const size_t share_end = after_server.find(L'\\');
    const std::wstring_view share = share_end == std::wstring_view::npos
                                        ? after_server
                                        : after_server.substr(0, share_end);
    if (share.empty() || share == L"." || share == L"..") {
      return std::nullopt;
    }
    const size_t root_len = 2 + server.size() + 1 + share.size();
    while (path.size() > root_len && path.back() == L'\\') {
      path.pop_back();
    }
    if (path.size() > root_len) {
      if (path[root_len] != L'\\') {
        return std::nullopt;
      }
      if (!ValidWinRelativeBody(std::wstring_view(path).substr(root_len + 1))) {
        return std::nullopt;
      }
    }
    return path;
  }
  if (path.size() >= 3 && IsAsciiDriveLetter(path[0]) && path[1] == L':' &&
      path[2] == L'\\') {
    while (path.size() > 3 && path.back() == L'\\') {
      path.pop_back();
    }
    if (!ValidWinRelativeBody(std::wstring_view(path).substr(3))) {
      return std::nullopt;
    }
    return path;
  }
  return std::nullopt;
}

inline size_t WinFinalPathRootLength(std::wstring_view path) {
  if (path.size() >= 2 && IsAsciiDriveLetter(path[0]) && path[1] == L':') {
    return 2;
  }
  if (path.starts_with(L"\\\\?\\")) {
    const size_t close = path.find(L'}');
    return close == std::wstring_view::npos ? path.size() : close + 1;
  }
  if (path.starts_with(L"\\\\")) {
    const size_t server_end = path.find(L'\\', 2);
    if (server_end == std::wstring_view::npos) {
      return path.size();
    }
    const size_t share_end = path.find(L'\\', server_end + 1);
    return share_end == std::wstring_view::npos ? path.size() : share_end;
  }
  return 0;
}

inline bool WinFinalPathStartsWith(std::wstring_view candidate,
                                   std::wstring_view root) {
  if (candidate.size() < root.size()) {
    return false;
  }
  const size_t folded = std::min(WinFinalPathRootLength(root), root.size());
  return WideAsciiEqualsIgnoreCase(candidate.substr(0, folded),
                                   root.substr(0, folded)) &&
         candidate.substr(folded, root.size() - folded) ==
             root.substr(folded);
}

inline bool IsStrictlyWithinWinDirectory(std::wstring_view raw_root,
                                         std::wstring_view raw_candidate) {
  const std::optional<std::wstring> root = NormalizeWinFinalPath(raw_root);
  const std::optional<std::wstring> candidate =
      NormalizeWinFinalPath(raw_candidate);
  if (!root || !candidate) {
    return false;
  }
  if (root->back() == L'\\') {
    return candidate->size() > root->size() &&
           WinFinalPathStartsWith(*candidate, *root);
  }
  if (candidate->size() <= root->size() + 1) {
    return false;
  }
  return (*candidate)[root->size()] == L'\\' &&
         WinFinalPathStartsWith(*candidate, *root);
}

inline bool IsDirectChildOfWinDirectory(std::wstring_view raw_root,
                                        std::wstring_view raw_candidate) {
  const std::optional<std::wstring> root = NormalizeWinFinalPath(raw_root);
  const std::optional<std::wstring> candidate =
      NormalizeWinFinalPath(raw_candidate);
  if (!root || !candidate) {
    return false;
  }
  size_t leaf_offset = 0;
  if (root->back() == L'\\') {
    if (candidate->size() <= root->size() ||
        !WinFinalPathStartsWith(*candidate, *root)) {
      return false;
    }
    leaf_offset = root->size();
  } else {
    if (candidate->size() <= root->size() + 1 ||
        (*candidate)[root->size()] != L'\\' ||
        !WinFinalPathStartsWith(*candidate, *root)) {
      return false;
    }
    leaf_offset = root->size() + 1;
  }
  const std::wstring_view leaf = std::wstring_view(*candidate).substr(leaf_offset);
  return !leaf.empty() && leaf.find(L'\\') == std::wstring_view::npos;
}

struct StartupMigrationPolicyInput {
  bool has_migrate_switch = false;
  bool has_no_migrate_switch = false;
  bool has_custom_data_dir = false;
  bool has_migrate_rnw_data = false;
};

inline constexpr bool ShouldRunStartupMigration(
    const StartupMigrationPolicyInput& input) {
  if (input.has_no_migrate_switch) {
    return false;
  }
  if (input.has_custom_data_dir) {
    return input.has_migrate_switch && input.has_migrate_rnw_data;
  }
  return true;
}

enum class StartupMigrationOutcome {
  kNotRequested,
  kMigratorAbsent,
  kMigratorUnsafe,
  kLookupFailed,
  kIncompleteArguments,
  kLaunchFailed,
  kExited,
  kTimedOut,
  kWaitFailed,
};

struct StartupMigrationResult {
  StartupMigrationOutcome outcome = StartupMigrationOutcome::kNotRequested;
  unsigned long exit_code = 0;
};

inline constexpr bool StartupMigrationAllowsShell(
    const StartupMigrationResult& result) {
  switch (result.outcome) {
    case StartupMigrationOutcome::kNotRequested:
    case StartupMigrationOutcome::kMigratorAbsent:
      return true;
    case StartupMigrationOutcome::kExited:
      return result.exit_code == 0;
    case StartupMigrationOutcome::kMigratorUnsafe:
    case StartupMigrationOutcome::kLookupFailed:
    case StartupMigrationOutcome::kIncompleteArguments:
    case StartupMigrationOutcome::kLaunchFailed:
    case StartupMigrationOutcome::kTimedOut:
    case StartupMigrationOutcome::kWaitFailed:
      return false;
  }
  return false;
}

inline constexpr const char* StartupMigrationOutcomeName(
    StartupMigrationOutcome outcome) {
  switch (outcome) {
    case StartupMigrationOutcome::kNotRequested:
      return "not_requested";
    case StartupMigrationOutcome::kMigratorAbsent:
      return "migrator_absent";
    case StartupMigrationOutcome::kMigratorUnsafe:
      return "migrator_unsafe";
    case StartupMigrationOutcome::kLookupFailed:
      return "lookup_failed";
    case StartupMigrationOutcome::kIncompleteArguments:
      return "incomplete_arguments";
    case StartupMigrationOutcome::kLaunchFailed:
      return "launch_failed";
    case StartupMigrationOutcome::kExited:
      return "exited";
    case StartupMigrationOutcome::kTimedOut:
      return "timed_out";
    case StartupMigrationOutcome::kWaitFailed:
      return "wait_failed";
  }
  return "unknown";
}

inline constexpr bool StartupMigrationRequestIncomplete(
    const StartupMigrationPolicyInput& input) {
  return !input.has_no_migrate_switch && input.has_custom_data_dir &&
         input.has_migrate_switch && !input.has_migrate_rnw_data;
}

inline std::optional<std::vector<std::wstring>> BuildStartupMigrationArguments(
    bool has_custom_data_dir,
    const std::wstring& rnw_data_dir,
    const std::wstring& webui_data_dir,
    bool test_instance) {
  const bool has_rnw = !rnw_data_dir.empty();
  const bool has_webui = !webui_data_dir.empty();
  if (has_custom_data_dir && (!has_rnw || !has_webui)) {
    return std::nullopt;
  }
  if (has_rnw != has_webui) {
    return std::nullopt;
  }
  std::vector<std::wstring> args;
  args.push_back(L"--from-rnw");
  if (has_rnw) {
    args.push_back(L"--rnw-data");
    args.push_back(rnw_data_dir);
    args.push_back(L"--webui-data");
    args.push_back(webui_data_dir);
  }
  if (test_instance) {
    args.push_back(L"--test-instance");
  }
  return args;
}

inline constexpr bool ValidWinRenameLeafName(std::wstring_view name) {
  if (name.empty() || name.size() > kWindowsDocumentNameLimit ||
      name == L"." || name == L"..") {
    return false;
  }
  for (const wchar_t c : name) {
    if (c == L'\\' || c == L'/' || c == L':' || c == L'\0') {
      return false;
    }
  }
  return true;
}

inline constexpr size_t WinFileRenameInfoBufferBytes(size_t header_offset,
                                                     size_t struct_size,
                                                     size_t name_utf16_units) {
  const size_t required = header_offset + name_utf16_units * 2;
  return required > struct_size ? required : struct_size;
}

inline std::wstring QuoteWinCommandArg(std::wstring_view arg) {
  const bool needs_quotes =
      arg.empty() || arg.find_first_of(L" \t\n\v\"") != std::wstring_view::npos;
  if (!needs_quotes) {
    return std::wstring(arg);
  }
  std::wstring out;
  out.push_back(L'"');
  size_t slashes = 0;
  for (const wchar_t c : arg) {
    if (c == L'\\') {
      ++slashes;
      continue;
    }
    if (c == L'"') {
      out.append(slashes * 2 + 1, L'\\');
      out.push_back(L'"');
    } else {
      out.append(slashes, L'\\');
      out.push_back(c);
    }
    slashes = 0;
  }
  out.append(slashes * 2, L'\\');
  out.push_back(L'"');
  return out;
}

inline std::wstring BuildWinCommandLine(const std::wstring& program,
                                        const std::vector<std::wstring>& args) {
  std::wstring command = QuoteWinCommandArg(program);
  for (const std::wstring& arg : args) {
    command.push_back(L' ');
    command.append(QuoteWinCommandArg(arg));
  }
  return command;
}

inline constexpr uint32_t kMaximizeClickLimitMs = 5000;

constexpr bool MaximizeClickCompletes(bool was_pressed,
                                      bool released_on_max_button,
                                      uint32_t held_ms) {
  return was_pressed && released_on_max_button &&
         held_ms <= kMaximizeClickLimitMs;
}

struct MaximizeButtonVisualState {
  bool hovered = false;
  bool pressed = false;

  friend constexpr bool operator==(const MaximizeButtonVisualState&,
                                   const MaximizeButtonVisualState&) = default;
};

class MaximizeButtonStateMachine {
 public:
  constexpr MaximizeButtonVisualState state() const { return state_; }

  constexpr bool OnPointerChecked(bool on_max_button,
                                  bool primary_button_down) {
    return Apply(MaximizeButtonVisualState{
        .hovered = on_max_button,
        .pressed = on_max_button && primary_button_down && state_.pressed,
    });
  }

  constexpr bool OnNcMouseLeave() {
    return Apply(MaximizeButtonVisualState{});
  }

  constexpr bool OnNcLeftButtonDown(bool on_max_button) {
    return Apply(MaximizeButtonVisualState{
        .hovered = on_max_button,
        .pressed = on_max_button,
    });
  }

  constexpr bool OnNcLeftButtonUp(bool on_max_button) {
    return Apply(MaximizeButtonVisualState{
        .hovered = on_max_button,
        .pressed = false,
    });
  }

  constexpr bool OnPressCancelled(bool pointer_on_max_button) {
    return Apply(MaximizeButtonVisualState{
        .hovered = pointer_on_max_button,
        .pressed = false,
    });
  }

  constexpr bool Reset() {
    return Apply(MaximizeButtonVisualState{});
  }

 private:
  constexpr bool Apply(MaximizeButtonVisualState next) {
    if (next == state_) {
      return false;
    }
    state_ = next;
    return true;
  }

  MaximizeButtonVisualState state_;
};

}

#endif
