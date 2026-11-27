#ifndef ARDIA_MAC_AC_MAC_SHARED_FOLDERS_POLICY_H_
#define ARDIA_MAC_AC_MAC_SHARED_FOLDERS_POLICY_H_

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace ardia_mac::shared_folders_policy {

inline constexpr std::string_view kManifestName = ".ardia-folder.json";
inline constexpr std::string_view kLinkExtension = "webloc";
inline constexpr std::string_view kPlaceholderSuffix = ".icloud";
inline constexpr std::string_view kSharedParentName = "Ardia Shared";
inline constexpr std::string_view kDefaultFolderName = "Shared Folder";
inline constexpr std::string_view kICloudDriveSuffix = "Library/Mobile Documents/com~apple~CloudDocs";
inline constexpr std::string_view kRefusedCode = "ERR_SHARED_FOLDER_REFUSED";
inline constexpr std::string_view kFailureCode = "ERR_SHARED_FOLDER";
inline constexpr int kMaxDepth = 8;
inline constexpr std::size_t kMaxParts = 32;
inline constexpr std::size_t kMaxLinkBytes = 64 * 1024;
inline constexpr std::size_t kMaxManifestBytes = 1024 * 1024;
inline constexpr std::size_t kMaxEntries = 20000;
inline constexpr std::size_t kMaxScanBytes = 32 * 1024 * 1024;
inline constexpr std::size_t kMaxFolderNameBytes = 200;
inline constexpr std::size_t kMaxPathBytes = 4096;
inline constexpr std::size_t kMaxNameBytes = 255;
inline constexpr std::size_t kMaxOpsBytes = 16 * 1024 * 1024;
inline constexpr std::size_t kMaxOps = 20000;
inline constexpr std::size_t kMaxWatched = 256;
inline constexpr int kMaxNumberedCopies = 10000;
inline constexpr double kMaxIdentityValue = 9007199254740991.0;

inline constexpr std::string_view kSystemFolders[] = {
    "/",         "/System",      "/Library",     "/Applications", "/Users", "/Volumes", "/bin",
    "/sbin",     "/usr",         "/etc",         "/var",          "/tmp",   "/dev",     "/opt",
    "/cores",    "/private",     "/private/etc", "/private/var",  "/private/tmp", "/Network",
};

inline constexpr std::string_view kHousekeeping[] = {
    ".ardia-folder.json",
    "..ardia-folder.json.icloud",
    ".DS_Store",
};

struct Identity {
  std::int64_t device = 0;
  std::int64_t inode = 0;

  bool operator==(const Identity&) const = default;
};

enum class OpKind { kUnknown, kWrite, kMove, kDelete, kMkdir, kRmdir };

inline bool NoControls(std::string_view text) {
  return std::none_of(text.begin(), text.end(), [](char c) {
    const auto byte = static_cast<unsigned char>(c);
    return byte < 0x20 || byte == 0x7f;
  });
}

inline std::optional<Identity> IdentityFrom(double device, double inode) {
  const auto whole = [](double value) {
    return std::isfinite(value) && value >= 0 && value <= kMaxIdentityValue && std::floor(value) == value;
  };
  if (!whole(device) || !whole(inode)) return std::nullopt;
  return Identity{static_cast<std::int64_t>(device), static_cast<std::int64_t>(inode)};
}

inline bool ValidAbsolutePath(std::string_view path) {
  if (path.empty() || path.front() != '/' || path.size() > kMaxPathBytes) return false;
  return path.find('\0') == std::string_view::npos;
}

inline bool ValidName(std::string_view name) {
  return !name.empty() && name.size() <= kMaxNameBytes && name != "." && name != ".." &&
         name.find('/') == std::string_view::npos && name.find('\0') == std::string_view::npos;
}

inline std::optional<std::vector<std::string>> RelativeParts(std::string_view path) {
  if (path.empty() || path.front() == '/' || path.size() > kMaxPathBytes) return std::nullopt;
  if (path.find('\0') != std::string_view::npos) return std::nullopt;
  std::vector<std::string> parts;
  std::size_t start = 0;
  while (start <= path.size()) {
    const std::size_t end = std::min(path.find('/', start), path.size());
    const std::string_view part = path.substr(start, end - start);
    if (!part.empty()) {
      if (!ValidName(part)) return std::nullopt;
      parts.emplace_back(part);
    }
    start = end + 1;
  }
  if (parts.empty() || parts.size() > kMaxParts) return std::nullopt;
  return parts;
}

inline std::string LowerAscii(std::string_view text) {
  std::string lowered(text);
  for (char& c : lowered) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return lowered;
}

inline bool IsLinkName(std::string_view name) {
  const std::size_t dot = name.rfind('.');
  if (dot == std::string_view::npos || dot == 0) return false;
  return LowerAscii(name.substr(dot + 1)) == kLinkExtension;
}

inline bool IsManifest(std::string_view name) {
  return name == kManifestName;
}

inline bool WritableName(std::string_view name) {
  return IsLinkName(name) || IsManifest(name);
}

inline bool IsHousekeeping(std::string_view name) {
  return std::ranges::find(kHousekeeping, name) != std::end(kHousekeeping);
}

inline std::optional<std::string> PlaceholderTarget(std::string_view name) {
  if (name.size() <= 1 + kPlaceholderSuffix.size() || name.front() != '.' || !name.ends_with(kPlaceholderSuffix)) {
    return std::nullopt;
  }
  return std::string(name.substr(1, name.size() - 1 - kPlaceholderSuffix.size()));
}

inline std::string PlaceholderFor(std::string_view name) {
  return "." + std::string(name) + std::string(kPlaceholderSuffix);
}

inline OpKind OpNamed(std::string_view kind) {
  if (kind == "write") return OpKind::kWrite;
  if (kind == "move") return OpKind::kMove;
  if (kind == "delete") return OpKind::kDelete;
  if (kind == "mkdir") return OpKind::kMkdir;
  if (kind == "rmdir") return OpKind::kRmdir;
  return OpKind::kUnknown;
}

inline std::size_t Utf8Length(unsigned char lead) {
  if (lead < 0x80) return 1;
  if ((lead & 0xE0) == 0xC0) return 2;
  if ((lead & 0xF0) == 0xE0) return 3;
  if ((lead & 0xF8) == 0xF0) return 4;
  return 1;
}

inline bool AsciiSpace(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

inline std::string FolderName(std::string_view name) {
  std::string cleaned;
  cleaned.reserve(name.size());
  for (char c : name) {
    const auto byte = static_cast<unsigned char>(c);
    if (c == '/' || c == ':') {
      cleaned.push_back('-');
    } else if (byte >= 0x20 && byte != 0x7f) {
      cleaned.push_back(c);
    } else if (AsciiSpace(c)) {
      cleaned.push_back(' ');
    }
  }
  std::size_t begin = 0;
  std::size_t end = cleaned.size();
  while (begin < end && AsciiSpace(cleaned[begin])) ++begin;
  while (end > begin && AsciiSpace(cleaned[end - 1])) --end;
  while (begin < end && cleaned[begin] == '.') ++begin;
  std::string capped;
  for (std::size_t index = begin; index < end;) {
    const std::size_t length = std::min(Utf8Length(static_cast<unsigned char>(cleaned[index])), end - index);
    if (capped.size() + length > kMaxFolderNameBytes) break;
    capped.append(cleaned, index, length);
    index += length;
  }
  return capped.empty() ? std::string(kDefaultFolderName) : capped;
}

inline std::string NumberedName(std::string_view stem, int number) {
  return number <= 1 ? std::string(stem) : std::string(stem) + " " + std::to_string(number);
}

inline bool RefusedFolder(std::string_view real, std::string_view home) {
  if (std::ranges::find(kSystemFolders, real) != std::end(kSystemFolders)) return true;
  if (!home.empty() && real == home) return true;
  if (real.starts_with("/Users/")) {
    const std::string_view rest = real.substr(7);
    if (!rest.empty() && rest.find('/') == std::string_view::npos) return true;
  }
  return false;
}

inline bool WatchHit(std::string_view root, std::string_view changed) {
  if (root.empty() || changed.empty()) return false;
  const auto under = [](std::string_view inner, std::string_view outer) {
    return inner.size() > outer.size() && inner.starts_with(outer) && inner[outer.size()] == '/';
  };
  return changed == root || under(changed, root) || under(root, changed);
}

inline bool WatchedPathsValid(const std::vector<std::string>& paths) {
  return paths.size() <= kMaxWatched &&
         std::ranges::all_of(paths, [](const std::string& path) { return ValidAbsolutePath(path); });
}

inline constexpr long long kCoordinationTimeoutSeconds = 20;

class CoordinationGate {
 public:
  bool Begin() {
    int pending = kPending;
    return state_.compare_exchange_strong(pending, kStarted) || pending == kStarted;
  }
  bool Expire() {
    int pending = kPending;
    return state_.compare_exchange_strong(pending, kExpired);
  }
  bool GaveUp() const { return state_.load() == kExpired; }
  bool Started() const { return state_.load() == kStarted; }

 private:
  static constexpr int kPending = 0;
  static constexpr int kStarted = 1;
  static constexpr int kExpired = 2;
  std::atomic<int> state_{kPending};
};

inline bool MovedTo(bool renamed) {
  return renamed;
}

enum class Coordination { kRan, kTimedOut, kFailed };

inline Coordination CoordinationOutcome(bool body_ran, const CoordinationGate& gate) {
  if (body_ran) return Coordination::kRan;
  return gate.GaveUp() ? Coordination::kTimedOut : Coordination::kFailed;
}

}

#endif
