#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

namespace ardia_little_fit {

struct Size {
  double w, h;
};
struct Rect {
  double x, y, w, h;
  double maxX() const { return x + w; }
  double maxY() const { return y + h; }
  double midX() const { return x + w / 2; }
  double midY() const { return y + h / 2; }
};

constexpr double kContainTolerance = 1;
constexpr double kLargestShareOfScreen = 0.8;
constexpr double kWholeScreen = 1;

inline double FitSide(double wanted, double minimum, double visible, double share) {
  const double largest = std::min(std::max(std::round(visible * share), minimum), visible);
  return std::min(std::round(std::min(std::max(wanted, minimum), largest)), visible);
}

inline double FitOrigin(double start, double extent, double side) {
  return std::clamp(std::round(start + (extent - side) / 2), start, std::max(start, start + extent - side));
}

inline Rect Fit(Rect visible, Size wanted, Size minimum, double share = kLargestShareOfScreen) {
  const double width = FitSide(wanted.w, minimum.w, visible.w, share);
  const double height = FitSide(wanted.h, minimum.h, visible.h, share);
  return {FitOrigin(visible.x, visible.w, width), FitOrigin(visible.y, visible.h, height), width, height};
}

inline bool Contains(Rect outer, Rect inner, double tolerance = kContainTolerance) {
  return inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance &&
         inner.maxX() <= outer.maxX() + tolerance && inner.maxY() <= outer.maxY() + tolerance;
}

inline double Overlap(Rect a, Rect b) {
  const double width = std::min(a.maxX(), b.maxX()) - std::max(a.x, b.x);
  const double height = std::min(a.maxY(), b.maxY()) - std::max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

inline int ScreenHolding(Rect bounds, const std::vector<Rect> &frames) {
  int best = -1;
  double bestOverlap = 0;
  for (size_t i = 0; i < frames.size(); i++) {
    const double overlap = Overlap(bounds, frames[i]);
    if (overlap > bestOverlap) best = static_cast<int>(i), bestOverlap = overlap;
  }
  return best;
}

inline Rect FlipFromTopLeft(Rect r, double primaryHeight) { return {r.x, primaryHeight - r.y - r.h, r.w, r.h}; }

struct Display {
  Rect frame;
  Rect visible;
};

struct Placement {
  Size wanted;
  Rect placed;
};

inline bool FitLanding(Rect landed, const std::vector<Display> &displays, Size minimum, const Placement *placement, Rect *fitted) {
  std::vector<Rect> frames;
  for (const Display &display : displays) frames.push_back(display.frame);
  const int held = ScreenHolding(landed, frames);
  if (held < 0) return false;
  const Rect visible = displays[held].visible;
  if (placement && ScreenHolding(placement->placed, frames) != held) {
    *fitted = Fit(visible, placement->wanted, minimum);
    return true;
  }
  if (Contains(visible, landed)) return false;
  *fitted = Fit(visible, {landed.w, landed.h}, minimum, kWholeScreen);
  return true;
}

}
