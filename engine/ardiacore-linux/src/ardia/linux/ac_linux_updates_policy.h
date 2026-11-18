#ifndef ARDIA_LINUX_AC_LINUX_UPDATES_POLICY_H_
#define ARDIA_LINUX_AC_LINUX_UPDATES_POLICY_H_

#include <cstddef>
#include <optional>
#include <string_view>

namespace ardia::linux_updates_policy {

enum class Source { kKillSwitches, kReleases };

inline constexpr std::string_view kKillSwitchesUrl = "https://ardia.dev/switches.json";
inline constexpr std::string_view kReleasesUrl =
    "https://api.github.com/repos/ardia-browser/ardia/releases?per_page=100";
inline constexpr size_t kMaxKillSwitchesBytes = 16 * 1024;
inline constexpr size_t kMaxReleasesBytes = 4 * 1024 * 1024;
inline constexpr int kTimeoutSeconds = 20;
inline constexpr int kMaxInFlight = 2;

inline std::string_view UrlFor(Source source) {
  return source == Source::kKillSwitches ? kKillSwitchesUrl : kReleasesUrl;
}

inline size_t MaxBytesFor(Source source) {
  return source == Source::kKillSwitches ? kMaxKillSwitchesBytes : kMaxReleasesBytes;
}

inline std::optional<Source> SourceForMethod(std::string_view method) {
  if (method == "ArdiaShell.fetchKillSwitches") return Source::kKillSwitches;
  if (method == "ArdiaUpdates.releases") return Source::kReleases;
  return std::nullopt;
}

inline bool AdmitFetch(int in_flight) {
  return in_flight >= 0 && in_flight < kMaxInFlight;
}

inline int ReportedStatus(bool network_ok, int http_status, bool has_body) {
  if (!network_ok || !has_body || http_status < 200 || http_status > 299) {
    return 0;
  }
  return http_status;
}

inline bool CachesForProcess(Source source, int status) {
  return source == Source::kKillSwitches && status == 200;
}

}

#endif
