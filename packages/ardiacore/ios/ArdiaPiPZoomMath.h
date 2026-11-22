#pragma once

#include <algorithm>
#include <cmath>

#include "ArdiaPiPThrowMath.h"

namespace ardia_pip_zoom {

struct Rect {
  double x, y, w, h;
  double maxX() const { return x + w; }
  double maxY() const { return y + h; }
};
struct Size {
  double w, h;
};
struct Point {
  double x, y;
};

constexpr double kPerPoint = 0.004, kPerLine = 0.08;
constexpr double kDockSlop = 64;
constexpr double kMostPastEdge = ardia_pip_throw::kTuckPastEdge;
constexpr double kPinchFollow = 0.05;
constexpr double kHandOffLinger = 0.25, kHandOffTimeout = 0.6;
constexpr double kHittableHiddenAlpha = 0.01;

inline double ScrollFactor(double deltaY, bool precise) {
  return std::exp((precise ? kPerPoint : kPerLine) * deltaY);
}

inline double MagnifyFactor(double magnification) {
  return std::max(0.05, 1 + magnification);
}

inline void WidthLimits(double aspect, Size minSize, Size maxSize, Rect visible, double *low, double *high) {
  *low = std::max({minSize.w, minSize.h * aspect, 1.0});
  *high = std::min({maxSize.w, maxSize.h * aspect, visible.w, visible.h * aspect});
  if (*low > *high) *low = *high;
}

inline double Anchor(double origin, double size, double next, double pointer, double low, double high) {
  double before = origin - low, after = high - (origin + size);
  if (before >= 0 && after >= 0 && std::min(before, after) <= kDockSlop) return before <= after ? origin : origin + size - next;
  double fraction = std::clamp((pointer - origin) / size, 0.0, 1.0);
  return pointer - fraction * next;
}

inline double CornerGrowth(double byX, double byY, double aspect) {
  const double squared = aspect * aspect;
  return (squared * byX + byY) / (squared + 1);
}

inline double KeptWithin(double value, double next, double origin, double size, double low, double high) {
  const double most = std::floor(next * kMostPastEdge);
  return std::clamp(value, std::max(std::min(low, origin), low - most), std::min(std::max(high, origin + size), high + most) - next);
}

inline bool Finite(Rect r) {
  return std::isfinite(r.x) && std::isfinite(r.y) && std::isfinite(r.w) && std::isfinite(r.h) && r.w > 0 && r.h > 0;
}

struct Result {
  Rect frame;
  double width;
};

inline Result Zoom(Rect frame, double width, double aspect, double factor, Point pointer, Rect visible, Size minSize,
                   Size maxSize) {
  double low, high;
  WidthLimits(aspect, minSize, maxSize, visible, &low, &high);
  double w = std::clamp(width * factor, low, high);
  double rw = std::clamp(std::round(w), std::ceil(low), std::max(std::ceil(low), std::floor(high)));
  double rh = std::round(rw / aspect);
  double x = Anchor(frame.x, frame.w, rw, pointer.x, visible.x, visible.maxX());
  double y = Anchor(frame.y, frame.h, rh, pointer.y, visible.y, visible.maxY());
  x = KeptWithin(x, rw, frame.x, frame.w, visible.x, visible.maxX());
  y = KeptWithin(y, rh, frame.y, frame.h, visible.y, visible.maxY());
  return {{std::round(x), std::round(y), rw, rh}, w};
}

}
