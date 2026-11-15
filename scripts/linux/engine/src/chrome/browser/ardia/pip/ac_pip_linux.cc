// Copyright 2026 Ardia. Apache-2.0.

#include <optional>
#include <vector>

#include "base/no_destructor.h"
#include "chrome/browser/ardia/pip/ac_pip_mac.h"

namespace {

std::optional<gfx::Rect>& SavedBounds() {
  static base::NoDestructor<std::optional<gfx::Rect>> bounds;
  return *bounds;
}

}  // namespace

std::optional<gfx::Rect> LoadArdiaPictureInPictureBounds() {
  return SavedBounds();
}

void SaveArdiaPictureInPictureBounds(const gfx::Rect& bounds) {
  SavedBounds() = bounds;
}

void FadeOutArdiaPictureInPicture(gfx::NativeWindow window,
                                  base::TimeDelta duration) {}

void ResetArdiaPictureInPictureFade(gfx::NativeWindow window) {}

bool PresentArdiaPictureInPictureControls(
    gfx::NativeWindow window,
    const std::vector<ArdiaPipNativeControl>& controls) {
  return false;
}
