#include <cassert>
#include <cstdio>
#include <optional>
#include <string>
#include <string_view>

#include "ardia/linux/ac_linux_window_picture.h"

namespace picture = ardia::linux_window_picture;

int main() {
  static_assert(std::string_view(picture::kSnapshotCall) == "ArdiaApp.devSnapshotWindow");
  static_assert(sizeof(picture::kWindowPictureCapabilities) / sizeof(picture::kWindowPictureCapabilities[0]) == 1);
  assert(std::string_view(picture::kWindowPictureCapabilities[0]) == picture::kSnapshotCall);

  auto opaque = picture::ParseRequest("main", "/tmp/shot.png", std::nullopt);
  assert(opaque && opaque->window_id == "main" && opaque->path == "/tmp/shot.png" && !opaque->transparent);
  auto clear = picture::ParseRequest("window-7", "/tmp/a b/shot.png", true);
  assert(clear && clear->window_id == "window-7" && clear->path == "/tmp/a b/shot.png" && clear->transparent);
  auto filled = picture::ParseRequest("main", "/shot.png", false);
  assert(filled && !filled->transparent);

  for (const char* relative : {"", "shot.png", "./shot.png", "../shot.png", "~/shot.png", "tmp/shot.png", " /tmp/shot.png"}) {
    assert(!picture::ParseRequest("main", relative, std::nullopt));
  }
  assert(!picture::ParseRequest("main", "/", std::nullopt));
  assert(!picture::ParseRequest("main", "/tmp/", std::nullopt));
  assert(!picture::ParseRequest("main", std::string("/tmp/shot\0.png", 14), std::nullopt));
  assert(!picture::ParseRequest(std::string("ma\0in", 5), "/tmp/shot.png", std::nullopt));
  assert(!picture::ParseRequest("", "/tmp/shot.png", std::nullopt));
  std::puts("ok");
  return 0;
}
