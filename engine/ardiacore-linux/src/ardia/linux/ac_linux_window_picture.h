#ifndef ARDIA_LINUX_AC_LINUX_WINDOW_PICTURE_H_
#define ARDIA_LINUX_AC_LINUX_WINDOW_PICTURE_H_

#include <optional>
#include <string>
#include <string_view>

namespace ardia::linux_window_picture {

inline constexpr char kSnapshotCall[] = "ArdiaApp.devSnapshotWindow";
inline constexpr const char* kWindowPictureCapabilities[] = {"ArdiaApp.devSnapshotWindow"};

struct SnapshotRequest {
  std::string window_id;
  std::string path;
  bool transparent;
};

inline std::optional<SnapshotRequest> ParseRequest(std::string_view window_id,
                                                   std::string_view path,
                                                   std::optional<bool> transparent) {
  if (window_id.empty() || window_id.find('\0') != std::string_view::npos) return std::nullopt;
  if (path.empty() || path.front() != '/' || path.back() == '/' || path.find('\0') != std::string_view::npos) {
    return std::nullopt;
  }
  return SnapshotRequest{std::string(window_id), std::string(path), transparent.value_or(false)};
}

}

#endif
