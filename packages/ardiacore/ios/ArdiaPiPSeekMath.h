#pragma once

#include <cmath>

namespace ardia_pip_seek {

constexpr double kSkipSeconds = 10;
constexpr double kDeadBandHalfWidth = 40;
constexpr double kClickSlop = 3;

inline double SkipSecondsAt(double x, double width) {
  if (!(width > 0) || x < 0 || x > width) return 0;
  const double fromCentre = x - width / 2;
  if (std::fabs(fromCentre) <= kDeadBandHalfWidth) return 0;
  return fromCentre < 0 ? -kSkipSeconds : kSkipSeconds;
}

inline double Travel(double dx, double dy) { return std::hypot(dx, dy); }

inline bool IsClick(double travel) { return travel < kClickSlop; }

}
