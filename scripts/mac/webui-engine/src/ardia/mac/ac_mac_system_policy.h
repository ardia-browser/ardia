#ifndef ARDIA_MAC_AC_MAC_SYSTEM_POLICY_H_
#define ARDIA_MAC_AC_MAC_SYSTEM_POLICY_H_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace ardia_mac::system_policy {

inline constexpr std::size_t kMaxPathBytes = 4096;
inline constexpr std::size_t kMaxStatusPaths = 64;
inline constexpr std::size_t kMaxKeptDownloads = 100;
inline constexpr std::size_t kExternalUrlLimit = 32 * 1024;
inline constexpr std::size_t kOpenUrlBytes = 32 * 1024;
inline constexpr std::size_t kOpenUrlBatch = 64;
inline constexpr std::size_t kPendingOpenUrls = 256;
inline constexpr std::size_t kPickerPromptLimit = 200;
inline constexpr double kProgressIntervalMs = 100;
inline constexpr double kDefaultIconPoints = 32;
inline constexpr double kMinIconPoints = 16;
inline constexpr double kMaxIconPoints = 512;

inline constexpr std::string_view kSystemMethods[] = {
    "ArdiaSystem.openFile",          "ArdiaSystem.revealFile",         "ArdiaSystem.moveToTrash",
    "ArdiaSystem.fileStatus",        "ArdiaSystem.fileIcon",           "ArdiaSystem.runningAppIcon",
    "ArdiaSystem.isDefaultBrowser",  "ArdiaSystem.setAsDefaultBrowser", "ArdiaSystem.hapticTick",
    "ArdiaSystem.setThinScrollBars", "ArdiaSystem.launchAtLoginStatus", "ArdiaSystem.setLaunchAtLogin",
    "ArdiaShell.pickFiles",          "ArdiaShell.pickFolder",          "ArdiaApp.openExternalURL",
    "ArdiaShell.listenForOpenURLs",
};

inline constexpr std::string_view kOpenUrlsEvent = "ArdiaShell.onOpenURLs";
inline constexpr std::string_view kOpenUrlsListen = "ArdiaShell.listenForOpenURLs";

inline constexpr std::string_view kDownloadCalls[] = {"downloads.list", "downloads.remove", "downloads.clear"};

inline constexpr std::string_view kDeniedSchemes[] = {
    "about",       "afp",      "applescript", "blob",     "chrome",           "chrome-extension",
    "chrome-search", "chrome-untrusted", "data", "devtools", "disk",           "disks",
    "file",        "filesystem", "hcp",       "ie.http",  "javascript",       "mk",
    "ms-help",     "nntp",     "res",         "shell",    "vbscript",         "view-source",
    "vnd.ms.radio", "x-apple.systempreferences", "x-apple-helpbasic"};

inline constexpr std::string_view kShellSchemes[] = {"http", "https", "file"};

inline char Lower(char c) {
  return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
}

inline bool Hex(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

inline bool Controls(std::string_view text) {
  return std::any_of(text.begin(), text.end(), [](char c) {
    const auto byte = static_cast<unsigned char>(c);
    return byte < 0x20 || byte == 0x7f;
  });
}

inline bool Printable(std::string_view text) {
  return std::none_of(text.begin(), text.end(), [](char c) {
    const auto byte = static_cast<unsigned char>(c);
    return byte <= 0x20 || byte == 0x7f;
  });
}

inline bool ValidDownloadId(std::string_view id) {
  if (id.size() != 36) return false;
  for (std::size_t index = 0; index < id.size(); ++index) {
    const bool dash = index == 8 || index == 13 || index == 18 || index == 23;
    if (dash ? id[index] != '-' : !Hex(id[index])) return false;
  }
  return true;
}

inline bool ValidLocalPath(std::string_view path) {
  if (path.empty() || path.size() > kMaxPathBytes || path.front() != '/') return false;
  if (path.find('\0') != std::string_view::npos) return false;
  if (path == "/") return true;
  if (path.back() == '/') return false;
  std::size_t start = 1;
  while (start <= path.size()) {
    const std::size_t end = std::min(path.find('/', start), path.size());
    const std::string_view part = path.substr(start, end - start);
    if (part.empty() || part == "." || part == "..") return false;
    start = end + 1;
  }
  return true;
}

inline bool PathListed(std::string_view path, const std::vector<std::string>& known) {
  if (!ValidLocalPath(path)) return false;
  return std::any_of(known.begin(), known.end(), [path](const std::string& entry) { return entry == path; });
}

inline bool IconPathAllowed(std::string_view path, const std::vector<std::string>& known) {
  if (path.empty() || path.size() > kMaxPathBytes || path.find('\0') != std::string_view::npos) return false;
  if (path.find('/') == std::string_view::npos) return !Controls(path);
  return PathListed(path, known);
}

inline double IconPoints(double requested) {
  if (!std::isfinite(requested)) return kDefaultIconPoints;
  return std::clamp(requested, kMinIconPoints, kMaxIconPoints);
}

inline int IconPixels(double requested) {
  return static_cast<int>(std::round(IconPoints(requested) * 2));
}

inline std::optional<int> ProcessId(double requested) {
  if (!std::isfinite(requested) || requested < 1 || requested > std::numeric_limits<int>::max() ||
      std::floor(requested) != requested) {
    return std::nullopt;
  }
  return static_cast<int>(requested);
}

inline bool ExternalSchemeAllowed(std::string_view scheme) {
  if (scheme.empty() || scheme.size() > 64) return false;
  const char first = scheme.front();
  if (!((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z'))) return false;
  std::string lower;
  for (const char c : scheme) {
    const bool allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '+' ||
                         c == '-' || c == '.';
    if (!allowed) return false;
    lower.push_back(Lower(c));
  }
  return std::none_of(std::begin(kDeniedSchemes), std::end(kDeniedSchemes),
                      [&lower](std::string_view denied) { return lower == denied; });
}

inline bool ExternalTextAllowed(std::string_view text) {
  return !text.empty() && text.size() <= kExternalUrlLimit && Printable(text) &&
         text.find('"') == std::string_view::npos && text.find('\\') == std::string_view::npos;
}

inline bool SchemeGoesToShell(std::string_view url) {
  if (url.empty() || url.size() > kOpenUrlBytes || !Printable(url)) return false;
  const std::size_t colon = url.find(':');
  if (colon == std::string_view::npos || colon == 0) return false;
  std::string scheme;
  for (const char c : url.substr(0, colon)) scheme.push_back(Lower(c));
  if (std::none_of(std::begin(kShellSchemes), std::end(kShellSchemes),
                   [&scheme](std::string_view allowed) { return scheme == allowed; })) {
    return false;
  }
  return url.substr(colon + 1).starts_with("//");
}

class OpenUrlInbox {
 public:
  std::size_t Add(const std::vector<std::string>& urls) {
    std::size_t added = 0;
    for (const std::string& url : urls) {
      if (urls_.size() >= kPendingOpenUrls) break;
      if (!SchemeGoesToShell(url)) continue;
      urls_.push_back(url);
      ++added;
    }
    return added;
  }

  std::vector<std::string> Take() {
    const std::size_t count = std::min(urls_.size(), kOpenUrlBatch);
    std::vector<std::string> taken(urls_.begin(), urls_.begin() + static_cast<std::ptrdiff_t>(count));
    urls_.erase(urls_.begin(), urls_.begin() + static_cast<std::ptrdiff_t>(count));
    return taken;
  }

  bool empty() const { return urls_.empty(); }
  std::size_t pending() const { return urls_.size(); }

 private:
  std::vector<std::string> urls_;
};

inline bool PickerPromptUsable(std::string_view prompt) {
  return !prompt.empty() && prompt.size() <= kPickerPromptLimit && !Controls(prompt);
}

enum class LoginStatus { kNotRegistered, kEnabled, kRequiresApproval, kNotFound };

inline LoginStatus LoginStatusFor(long service_status) {
  switch (service_status) {
    case 1:
      return LoginStatus::kEnabled;
    case 2:
      return LoginStatus::kRequiresApproval;
    case 3:
      return LoginStatus::kNotFound;
    default:
      return LoginStatus::kNotRegistered;
  }
}

inline std::string_view LoginStatusName(LoginStatus status) {
  switch (status) {
    case LoginStatus::kEnabled:
      return "enabled";
    case LoginStatus::kRequiresApproval:
      return "requiresApproval";
    case LoginStatus::kNotFound:
      return "notFound";
    case LoginStatus::kNotRegistered:
      return "notRegistered";
  }
  return "notRegistered";
}

inline bool ValidClearCutoff(double cutoff) {
  return std::isfinite(cutoff) && cutoff >= 0;
}

inline bool ClearsDownload(bool in_progress, bool kept, double start_ms, double cutoff_ms) {
  return !in_progress && !kept && std::isfinite(start_ms) && start_ms <= cutoff_ms;
}

inline bool Removable(bool in_progress) {
  return !in_progress;
}

struct ProgressMark {
  bool live = false;
  bool emitted = false;
  bool paused = false;
  bool dangerous = false;
  double last_ms = 0;
};

inline bool EmitsChange(ProgressMark& mark, bool in_progress, bool paused, bool dangerous, double now_ms) {
  if (in_progress) mark.live = true;
  if (!mark.live) return false;
  if (in_progress && mark.emitted && mark.paused == paused && mark.dangerous == dangerous &&
      now_ms - mark.last_ms < kProgressIntervalMs) {
    return false;
  }
  mark.emitted = true;
  mark.paused = paused;
  mark.dangerous = dangerous;
  mark.last_ms = now_ms;
  return true;
}

inline ProgressMark SeededMark(bool in_progress, bool paused, bool dangerous, double now_ms) {
  ProgressMark mark;
  mark.live = in_progress;
  mark.emitted = in_progress;
  mark.paused = paused;
  mark.dangerous = dangerous;
  mark.last_ms = now_ms;
  return mark;
}

template <typename Callback>
class ReadyQueue {
 public:
  std::optional<Callback> Hold(bool initialized, Callback callback) {
    if (ready_ || initialized) {
      ready_ = true;
      return std::optional<Callback>(std::move(callback));
    }
    waiting_.push_back(std::move(callback));
    return std::nullopt;
  }

  std::vector<Callback> Release() {
    ready_ = true;
    return std::exchange(waiting_, {});
  }

  std::vector<Callback> Drop() { return std::exchange(waiting_, {}); }

  std::vector<Callback> Close() {
    closed_ = true;
    return Drop();
  }

  bool closed() const { return closed_; }
  bool ready() const { return ready_; }
  std::size_t waiting() const { return waiting_.size(); }

 private:
  bool ready_ = false;
  bool closed_ = false;
  std::vector<Callback> waiting_;
};

inline bool DownloadMember(bool primary_profile, int tabs_in_window) {
  return primary_profile || tabs_in_window > 0;
}

enum class DownloadRoute { kServe, kRefuseQueued, kUnavailable };

inline bool QueuesOnManager(std::string_view name) {
  return name == "downloads.list" || name == "downloads.clear";
}

inline DownloadRoute RouteDownloadRequest(std::string_view name, bool profile_usable, bool watched, bool has_manager) {
  if (profile_usable && watched && has_manager) return DownloadRoute::kServe;
  return QueuesOnManager(name) ? DownloadRoute::kRefuseQueued : DownloadRoute::kUnavailable;
}

inline bool HandsLinksToChrome(bool hosts_alive, std::size_t pending, bool quitting) {
  return !hosts_alive && pending > 0 && !quitting;
}

inline bool CapturesOpenUrls(bool hook_installed, bool host_alive, bool host_seen) {
  return hook_installed && (host_alive || !host_seen);
}

enum class PickerAdmission { kOpen, kAlreadyOpen };

inline PickerAdmission AdmitPicker(bool showing) {
  return showing ? PickerAdmission::kAlreadyOpen : PickerAdmission::kOpen;
}

}

#endif
