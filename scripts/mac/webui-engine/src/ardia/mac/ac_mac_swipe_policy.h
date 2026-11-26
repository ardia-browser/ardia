#ifndef ARDIA_MAC_AC_MAC_SWIPE_POLICY_H_
#define ARDIA_MAC_AC_MAC_SWIPE_POLICY_H_

#include <cmath>
#include <cstdint>
#include <optional>
#include <string_view>
#include <utility>

namespace ardia_mac::swipe_policy {

inline constexpr char kScrollGestureEvent[] = "onScrollGesture";
inline constexpr char kPageSwipeEvent[] = "onPageSwipe";
inline constexpr char kScrollGesturesCapability[] = "shell.scrollGestures";

inline constexpr double kStartDistance = 4;
inline constexpr double kStartDominance = 1.5;
inline constexpr double kDeltaLimit = 10000;
inline constexpr double kPointLimit = 1000000;

inline constexpr std::uint64_t kPhaseBegan = 1u << 0;
inline constexpr std::uint64_t kPhaseStationary = 1u << 1;
inline constexpr std::uint64_t kPhaseChanged = 1u << 2;
inline constexpr std::uint64_t kPhaseEnded = 1u << 3;
inline constexpr std::uint64_t kPhaseCancelled = 1u << 4;
inline constexpr std::uint64_t kPhaseMayBegin = 1u << 5;

enum class Phase { kNone, kMayBegin, kBegan, kChanged, kEnded, kCancelled };

constexpr Phase PhaseOf(std::uint64_t mask) {
  if (mask & kPhaseCancelled) {
    return Phase::kCancelled;
  }
  if (mask & kPhaseEnded) {
    return Phase::kEnded;
  }
  if (mask & kPhaseBegan) {
    return Phase::kBegan;
  }
  if (mask & kPhaseMayBegin) {
    return Phase::kMayBegin;
  }
  if (mask & (kPhaseChanged | kPhaseStationary)) {
    return Phase::kChanged;
  }
  return Phase::kNone;
}

constexpr std::string_view PhaseName(Phase phase) {
  switch (phase) {
    case Phase::kNone:
      return "none";
    case Phase::kMayBegin:
      return "mayBegin";
    case Phase::kBegan:
      return "began";
    case Phase::kChanged:
      return "changed";
    case Phase::kEnded:
      return "ended";
    case Phase::kCancelled:
      return "cancelled";
  }
  return "none";
}

enum class Kind { kIgnored, kWheel, kGesture, kMomentum };

constexpr Kind Classify(Phase phase, Phase momentum, bool precise) {
  if (phase == Phase::kNone && momentum == Phase::kNone) {
    return Kind::kWheel;
  }
  if (!precise) {
    return Kind::kIgnored;
  }
  return phase == Phase::kNone ? Kind::kMomentum : Kind::kGesture;
}

constexpr std::string_view KindPhaseName(Kind kind, Phase phase) {
  return kind == Kind::kWheel ? std::string_view("wheel") : PhaseName(phase);
}

inline std::optional<double> Delta(double value) {
  if (!std::isfinite(value)) {
    return std::nullopt;
  }
  return std::fmax(-kDeltaLimit, std::fmin(kDeltaLimit, value));
}

inline bool FinitePoint(double x, double y) {
  return std::isfinite(x) && std::isfinite(y) && std::fabs(x) <= kPointLimit && std::fabs(y) <= kPointLimit;
}

inline bool FiniteTime(double seconds) {
  return std::isfinite(seconds) && seconds >= 0;
}

enum class Route { kNone, kShell, kPage };

class RouteLatch {
 public:
  Route Next(Kind kind, Phase phase, Route hit) {
    if (kind == Kind::kIgnored) {
      return Route::kNone;
    }
    if (kind == Kind::kWheel) {
      return hit;
    }
    if (kind == Kind::kGesture && (phase == Phase::kMayBegin || phase == Phase::kBegan)) {
      if (open_ && latched_ != Route::kNone && latched_ != hit) {
        abandoned_ = latched_;
      }
      latched_ = hit;
      open_ = true;
    } else if (kind == Kind::kGesture && (phase == Phase::kEnded || phase == Phase::kCancelled)) {
      open_ = false;
    }
    return latched_;
  }

  Route TakeAbandoned() { return std::exchange(abandoned_, Route::kNone); }

  Route Interrupt() {
    const Route open = open_ ? latched_ : Route::kNone;
    Reset();
    return open;
  }

  void Reset() {
    latched_ = Route::kNone;
    abandoned_ = Route::kNone;
    open_ = false;
  }

 private:
  Route latched_ = Route::kNone;
  Route abandoned_ = Route::kNone;
  bool open_ = false;
};

inline constexpr double kCancelDominance = 2;

constexpr bool HorizontalIntent(double dx, double dy) {
  const double x = dx < 0 ? -dx : dx;
  const double y = dy < 0 ? -dy : dy;
  return x >= kStartDistance && kStartDominance * x >= y;
}

constexpr bool VerticalIntent(double dx, double dy) {
  const double x = dx < 0 ? -dx : dx;
  const double y = dy < 0 ? -dy : dy;
  return y >= kStartDistance && kCancelDominance * x < y;
}

enum class Ack { kWheelBegan, kWheelConsumed, kScrollBegin, kScrollConsumed, kScrollUnconsumed };

struct AckEvent {
  Ack ack = Ack::kWheelBegan;
  std::int64_t time = 0;
  bool main = true;
};

struct Step {
  Phase phase = Phase::kCancelled;
  double dx = 0;
  double dy = 0;
};

class PageSwipe {
 public:
  void Begin(bool enabled, std::uint64_t gesture, std::int64_t start) {
    *this = PageSwipe();
    state_ = enabled && start > 0 ? State::kPending : State::kIdle;
    gesture_ = gesture;
    start_ = start;
  }

  std::optional<Step> Scroll(double dx, double dy) {
    if (state_ == State::kIdle || state_ == State::kPage) {
      return std::nullopt;
    }
    total_dx_ += dx;
    total_dy_ += dy;
    if (state_ == State::kTracking) {
      return Step{Phase::kChanged, dx, dy};
    }
    if (VerticalIntent(total_dx_, total_dy_)) {
      state_ = State::kPage;
      return std::nullopt;
    }
    return Start();
  }

  std::optional<Step> Acknowledge(const AckEvent& event) {
    if (event.time < start_) {
      return std::nullopt;
    }
    if (state_ == State::kTracking && !claimed_ && scrolling_ && event.ack == Ack::kScrollConsumed) {
      state_ = State::kPage;
      return Step{Phase::kCancelled};
    }
    if (state_ != State::kPending) {
      return std::nullopt;
    }
    switch (event.ack) {
      case Ack::kWheelBegan:
        wheel_began_ = true;
        return std::nullopt;
      case Ack::kWheelConsumed:
        if (wheel_began_) {
          state_ = State::kPage;
        }
        return std::nullopt;
      case Ack::kScrollBegin:
        scrolling_ = scrolling_ || wheel_began_;
        return std::nullopt;
      case Ack::kScrollConsumed:
        if (scrolling_) {
          state_ = State::kPage;
        }
        return std::nullopt;
      case Ack::kScrollUnconsumed:
        if (!scrolling_ || !event.main) {
          return std::nullopt;
        }
        unconsumed_ = true;
        return Start();
    }
    return std::nullopt;
  }

  bool Claim(std::uint64_t gesture, bool claimed) {
    if (state_ != State::kTracking || gesture != gesture_) {
      return false;
    }
    claimed_ = claimed;
    return true;
  }

  std::optional<Step> End(bool cancelled) {
    const bool tracking = state_ == State::kTracking;
    state_ = State::kIdle;
    claimed_ = false;
    if (!tracking) {
      return std::nullopt;
    }
    return Step{cancelled ? Phase::kCancelled : Phase::kEnded};
  }

  bool Swallows() const {
    return state_ == State::kTracking && claimed_ && HorizontalIntent(total_dx_, total_dy_);
  }

  bool active() const { return state_ == State::kPending || state_ == State::kTracking; }
  bool tracking() const { return state_ == State::kTracking; }
  bool pending() const { return state_ == State::kPending; }
  bool page_owned() const { return state_ == State::kPage; }
  bool claimed() const { return claimed_; }
  std::uint64_t gesture() const { return gesture_; }

 private:
  enum class State { kIdle, kPending, kPage, kTracking };

  std::optional<Step> Start() {
    if (!unconsumed_) {
      return std::nullopt;
    }
    if (VerticalIntent(total_dx_, total_dy_)) {
      state_ = State::kPage;
      return std::nullopt;
    }
    if (!HorizontalIntent(total_dx_, total_dy_)) {
      return std::nullopt;
    }
    state_ = State::kTracking;
    return Step{Phase::kBegan, total_dx_, total_dy_};
  }

  State state_ = State::kIdle;
  std::uint64_t gesture_ = 0;
  std::int64_t start_ = 0;
  bool wheel_began_ = false;
  bool scrolling_ = false;
  bool unconsumed_ = false;
  bool claimed_ = false;
  double total_dx_ = 0;
  double total_dy_ = 0;
};

inline constexpr char kPageSwipeClaimCall[] = "shell.pageSwipeClaim";
inline constexpr std::uint64_t kGestureLimit = 9007199254740991u;

inline std::optional<std::uint64_t> GestureId(std::optional<double> value) {
  if (!value || !std::isfinite(*value) || *value < 1 || *value > static_cast<double>(kGestureLimit) ||
      std::floor(*value) != *value) {
    return std::nullopt;
  }
  return static_cast<std::uint64_t>(*value);
}

}

#endif
