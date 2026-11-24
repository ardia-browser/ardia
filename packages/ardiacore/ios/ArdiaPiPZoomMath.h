#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

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

constexpr double kMostScrollExponent = 2, kLeastMagnifyFactor = 0.05, kMostMagnifyFactor = 4, kFarthestPointer = 1e6;
constexpr double kPinchStall = 1.0;

inline double ScrollFactor(double deltaY, bool precise) {
  if (!std::isfinite(deltaY)) return 1;
  return std::exp(std::clamp((precise ? kPerPoint : kPerLine) * deltaY, -kMostScrollExponent, kMostScrollExponent));
}

inline double MagnifyFactor(double magnification) {
  if (!std::isfinite(magnification)) return 1;
  return std::clamp(1 + magnification, kLeastMagnifyFactor, kMostMagnifyFactor);
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

struct Window {
  long number, standIn;
  Rect frame;
  Rect shown = {0, 0, 0, 0};
  bool standInClear = false;
};

inline bool UsablePointer(Point p) {
  return std::isfinite(p.x) && std::isfinite(p.y) && std::fabs(p.x) <= kFarthestPointer && std::fabs(p.y) <= kFarthestPointer;
}

inline bool KeepsStandIn(bool windowExists, bool visible, bool stashed) { return windowExists && visible && !stashed; }

inline bool WantsOtherAppPinches(bool appActive, bool zoomEnabled, bool anyZoomable) { return !appActive && zoomEnabled && anyZoomable; }

inline bool Contains(Rect r, Point p) { return p.x >= r.x && p.x < r.maxX() && p.y >= r.y && p.y < r.maxY(); }

inline long WindowUnder(const std::vector<Window> &frontToBack, Point pointer, long topmost) {
  for (const Window &window : frontToBack) {
    const bool named = topmost && (topmost == window.number || (window.standIn && topmost == window.standIn));
    if (window.standIn) {
      if (Contains(window.shown, pointer) && (window.standInClear || named)) return window.number;
      continue;
    }
    if (Contains(window.frame, pointer) && named) return window.number;
  }
  return 0;
}

enum class Phase { None, Began, Changed, Ended };

struct PinchLock {
  long window = 0;
  bool owned = false, elsewhere = false, stalled = false;
  long session = 0;
};

struct PinchStep {
  long window = 0;
  bool consume = false, begin = false, apply = false, end = false, cancel = false;
  long finish = 0, session = 0, finishSession = 0;
};

inline PinchStep On(const PinchLock &lock, long window, bool begin, bool apply, bool end, bool cancel) {
  PinchStep step;
  step.window = window;
  step.consume = true;
  step.begin = begin;
  step.apply = apply;
  step.end = end;
  step.cancel = cancel;
  step.session = begin ? 0 : lock.session;
  return step;
}

inline PinchStep StepPinch(PinchLock &lock, Phase phase, long under, bool lockedZooms) {
  if (phase == Phase::Began) {
    const bool finishing = lock.owned && lock.window && !lock.stalled;
    const long finish = finishing ? lock.window : 0, finishSession = finishing ? lock.session : 0;
    lock = {under, under != 0, under == 0, false, 0};
    PinchStep step = under ? On(lock, under, true, true, false, false) : PinchStep{};
    step.finish = finish;
    step.finishSession = finishSession;
    return step;
  }
  const bool ended = phase == Phase::Ended;
  PinchStep step;
  if (lock.owned) {
    step.consume = true;
    if (lock.window && !lockedZooms) {
      if (!lock.stalled) step = On(lock, lock.window, false, false, false, true);
      lock.window = 0;
    } else if (lock.window && lock.stalled) {
      if (!ended) step = On(lock, lock.window, true, true, false, false);
      lock.stalled = false;
    } else if (lock.window) {
      step = On(lock, lock.window, false, true, ended, false);
    }
  } else if (!lock.elsewhere && under) {
    step = On(lock, under, false, true, ended, false);
  }
  if (ended) lock = {};
  return step;
}

inline void BindSession(PinchLock &lock, long window, long session) {
  if (lock.owned && lock.window == window) lock.session = session;
}

inline PinchStep StallPinch(PinchLock &lock) {
  if (!lock.owned || !lock.window || lock.stalled) return {};
  lock.stalled = true;
  PinchStep step;
  step.window = lock.window;
  step.end = true;
  step.session = lock.session;
  return step;
}

inline void YieldPinch(PinchLock &lock, long window) {
  if (!lock.window || (window && lock.window != window)) return;
  lock.window = 0;
  lock.stalled = false;
  lock.session = 0;
}

inline bool SameSession(long stepSession, long current) { return !stepSession || stepSession == current; }

inline PinchStep FinishPending(PinchLock &lock) {
  PinchStep step;
  if (!lock.owned || !lock.window || lock.stalled) return step;
  step.finish = lock.window;
  step.finishSession = lock.session;
  lock.window = 0;
  lock.session = 0;
  return step;
}

inline PinchStep HoldPinch(PinchLock &lock, Phase phase) {
  PinchStep step = phase == Phase::Changed || phase == Phase::None ? PinchStep{} : FinishPending(lock);
  if (phase == Phase::Began) lock = {0, true, false, false, 0};
  else if (phase == Phase::Ended) lock = {};
  step.consume = lock.owned || phase == Phase::Ended;
  return step;
}

struct PinchStart {
  PinchStep finish, step;
};

inline PinchStart StartPinch(PinchLock &lock, const std::vector<Window> &frontToBack, Point pointer, long topmost) {
  const long under = WindowUnder(frontToBack, pointer, topmost);
  PinchStart start;
  start.finish = FinishPending(lock);
  start.step = StepPinch(lock, Phase::Began, under, true);
  return start;
}

}
