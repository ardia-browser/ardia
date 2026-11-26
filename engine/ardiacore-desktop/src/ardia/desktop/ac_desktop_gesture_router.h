#ifndef ARDIA_DESKTOP_AC_DESKTOP_GESTURE_ROUTER_H_
#define ARDIA_DESKTOP_AC_DESKTOP_GESTURE_ROUTER_H_

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>
#include <vector>

#include "ardia/desktop/ac_desktop_pager_spring.h"

namespace ardia::desktop_gesture {

inline constexpr double kStartDistance = 4;
inline constexpr double kStartDominance = 1.5;
inline constexpr double kCancelDominance = 2;
inline constexpr double kPagerVerticalIntent = 3 * kStartDistance;
inline constexpr std::size_t kVelocitySamples = 6;
inline constexpr double kVelocityWindow = 0.1;
inline constexpr double kMinVelocitySpan = 0.004;
inline constexpr double kMomentumStartWait = 0.1;

enum class TouchPhase { kMayBegin, kBegan, kChanged, kEnded, kCancelled };

enum class MomentumPhase { kBegan, kChanged, kEnded, kCancelled };

enum class Verdict { kNone, kWaiting, kTracking, kVerticalIntent, kContentConsumed, kContentScrolls, kUnavailable,
                     kTargetGone, kAxisCancelled, kOverscrollBlocked, kStale, kSuperseded };

enum class ContentAck { kPending, kConsumed, kUnconsumed };

struct ContentState {
  ContentAck ack = ContentAck::kPending;
  bool overscrolled = false;
  bool overscroll_allowed = true;
};

constexpr std::string_view VerdictName(Verdict verdict) {
  switch (verdict) {
    case Verdict::kNone:
      return "none";
    case Verdict::kWaiting:
      return "waiting";
    case Verdict::kTracking:
      return "tracking";
    case Verdict::kVerticalIntent:
      return "verticalIntent";
    case Verdict::kContentConsumed:
      return "contentConsumed";
    case Verdict::kContentScrolls:
      return "contentScrolls";
    case Verdict::kUnavailable:
      return "unavailable";
    case Verdict::kTargetGone:
      return "targetGone";
    case Verdict::kAxisCancelled:
      return "axisCancelled";
    case Verdict::kOverscrollBlocked:
      return "overscrollBlocked";
    case Verdict::kStale:
      return "stale";
    case Verdict::kSuperseded:
      return "superseded";
  }
  return "none";
}

struct Target {
  int64_t id = 0;
  bool is_pager = false;
  bool has_native_pager = false;
  bool can_swipe_back = false;
  bool can_swipe_forward = false;
  bool tracks_unavailable_directions = false;
  bool allows_vertical_motion = false;
  bool content_scrolls_back = false;
  bool content_scrolls_forward = false;
  bool page_hit = false;
};

struct Action {
  int64_t target = 0;
  bool native_pager = false;
  desktop_pager::PagerInput input = desktop_pager::PagerInput::kCancelled;
  double distance = 0;
  int direction = 0;
  double dy = 0;
  double velocity = 0;
  bool available = false;
  double timestamp = 0;
};

struct Result {
  bool swallow = false;
  Verdict verdict = Verdict::kNone;
  std::vector<Action> actions;
};

inline void ApplyToPager(desktop_pager::PagerSpring& pager, const Action& action, double page_width) {
  if (!action.native_pager) return;
  pager.Input(action.input, action.distance, action.direction, page_width, action.timestamp);
}

class GestureRouter {
 public:
  Result Scroll(TouchPhase phase, double dx, double dy, double timestamp_s, const Target* hit,
                const ContentState* content = nullptr, int64_t window = 0) {
    Result result;
    const double now = std::isfinite(timestamp_s) ? timestamp_s : last_time_;
    last_time_ = now;
    const double step_x = std::isfinite(dx) ? dx : 0;
    const double step_y = std::isfinite(dy) ? dy : 0;
    const bool finishing = phase == TouchPhase::kEnded || phase == TouchPhase::kCancelled;
    const bool live = gesture_.state == State::kPending || gesture_.state == State::kTracking;
    if (phase != TouchPhase::kBegan && phase != TouchPhase::kMayBegin && live && window != gesture_.window) {
      if (finishing) ReleasePrepared(now, window, result);
      result.verdict = Verdict::kStale;
      return result;
    }
    if (phase == TouchPhase::kBegan || window == momentum_.window) momentum_ = MomentumState();
    if (phase == TouchPhase::kMayBegin) {
      Prepare(hit, now, window, result);
      return result;
    }
    if (phase == TouchPhase::kBegan) Begin(hit, now, window, result);
    if (gesture_.state == State::kIdle || gesture_.state == State::kIgnored) {
      if (finishing) ReleasePrepared(now, window, result);
      return result;
    }
    if (!gesture_.target) {
      Reject(Verdict::kTargetGone, result);
      return result;
    }
    if (content) MergeContent(*content);
    gesture_.dx += step_x;
    gesture_.dy += step_y;
    gesture_.time = now;
    Sample(now, step_x);
    if (finishing) {
      if (gesture_.state != State::kTracking) {
        gesture_.state = State::kIdle;
        ReleasePrepared(now, window, result);
        return result;
      }
      Emit(phase == TouchPhase::kEnded ? desktop_pager::PagerInput::kEnded : desktop_pager::PagerInput::kCancelled,
           ReleaseVelocity(now), result);
      gesture_.state = State::kIdle;
      if (!gesture_.target->page_hit) momentum_ = MomentumState{gesture_.window, now, true, false, gesture_.target->id};
      return result;
    }
    if (gesture_.state == State::kPending) {
      if (!ShouldTrack(result)) return result;
      gesture_.state = State::kTracking;
      if (prepared_ && prepared_window_ == gesture_.window && prepared_->id == gesture_.target->id) prepared_.reset();
      result.verdict = Verdict::kTracking;
      Emit(desktop_pager::PagerInput::kBegan, 0, result);
      result.swallow = true;
      return result;
    }
    if (!gesture_.target->is_pager && !gesture_.target->allows_vertical_motion &&
        kCancelDominance * std::abs(gesture_.dx) < std::abs(gesture_.dy)) {
      Emit(desktop_pager::PagerInput::kCancelled, 0, result);
      gesture_.state = State::kIgnored;
      result.verdict = Verdict::kAxisCancelled;
      return result;
    }
    result.verdict = Verdict::kTracking;
    Emit(desktop_pager::PagerInput::kChanged, ReleaseVelocity(now), result);
    result.swallow = true;
    return result;
  }

  bool Momentum(MomentumPhase phase, double timestamp_s, int64_t window = 0) {
    if (!momentum_.armed) return false;
    if (!momentum_.flowing) {
      if (window != momentum_.window) return false;
      const double elapsed = timestamp_s - momentum_.ended_at;
      momentum_.flowing = phase == MomentumPhase::kBegan && std::isfinite(elapsed) && elapsed >= 0 &&
                          elapsed <= kMomentumStartWait;
      if (!momentum_.flowing) {
        momentum_ = MomentumState();
        return false;
      }
    } else if (window != momentum_.window) {
      return false;
    }
    if (phase == MomentumPhase::kEnded || phase == MomentumPhase::kCancelled) momentum_ = MomentumState();
    return true;
  }

  Result Forget(int64_t target_id) {
    Result result;
    if (prepared_ && prepared_->id == target_id) ReleasePrepared(last_time_, prepared_window_, result);
    if (gesture_.target && gesture_.target->id == target_id) {
      if (gesture_.state == State::kTracking) Emit(desktop_pager::PagerInput::kCancelled, 0, result);
      if (gesture_.state == State::kPending || gesture_.state == State::kTracking) gesture_.state = State::kIgnored;
      gesture_.target.reset();
      result.verdict = Verdict::kTargetGone;
    }
    if (momentum_.armed && momentum_.target == target_id) momentum_ = MomentumState();
    return result;
  }

  bool tracking() const { return gesture_.state == State::kTracking; }
  bool pending() const { return gesture_.state == State::kPending; }
  std::optional<int64_t> prepared() const {
    return prepared_ ? std::optional<int64_t>(prepared_->id) : std::nullopt;
  }
  std::optional<int64_t> target() const {
    return gesture_.target ? std::optional<int64_t>(gesture_.target->id) : std::nullopt;
  }
  int direction() const { return gesture_.direction; }

 private:
  enum class State { kIdle, kPending, kTracking, kIgnored };

  struct Gesture {
    State state = State::kIdle;
    std::optional<Target> target;
    double dx = 0;
    double dy = 0;
    int direction = 0;
    bool available = false;
    std::array<double, kVelocitySamples> times{};
    std::array<double, kVelocitySamples> deltas{};
    std::size_t samples = 0;
    double time = 0;
    int64_t window = 0;
    ContentState content;
  };

  struct MomentumState {
    int64_t window = 0;
    double ended_at = 0;
    bool armed = false;
    bool flowing = false;
    int64_t target = 0;
  };

  static Action PagerAction(const Target& target, desktop_pager::PagerInput input, double timestamp_s) {
    Action action;
    action.target = target.id;
    action.native_pager = true;
    action.input = input;
    action.timestamp = timestamp_s;
    return action;
  }

  void ReleasePrepared(double timestamp_s, int64_t window, Result& result) {
    if (!prepared_ || prepared_window_ != window) return;
    const Target prepared = *prepared_;
    prepared_.reset();
    result.actions.push_back(PagerAction(prepared, desktop_pager::PagerInput::kAbandon, timestamp_s));
  }

  void Prepare(const Target* hit, double timestamp_s, int64_t window, Result& result) {
    ReleasePrepared(timestamp_s, prepared_window_, result);
    if (!hit || !hit->has_native_pager) return;
    prepared_ = *hit;
    prepared_window_ = window;
    result.actions.push_back(PagerAction(*hit, desktop_pager::PagerInput::kPrepare, timestamp_s));
  }

  void Begin(const Target* hit, double timestamp_s, int64_t window, Result& result) {
    if (gesture_.state == State::kTracking && gesture_.target) {
      gesture_.time = timestamp_s;
      if (gesture_.target->has_native_pager) {
        result.actions.push_back(PagerAction(*gesture_.target, desktop_pager::PagerInput::kAbandon, timestamp_s));
      } else {
        Emit(desktop_pager::PagerInput::kCancelled, 0, result);
      }
      result.verdict = Verdict::kSuperseded;
    }
    gesture_ = Gesture();
    gesture_.window = window;
    if (!hit) {
      gesture_.state = State::kIgnored;
      ReleasePrepared(timestamp_s, window, result);
      return;
    }
    if (!prepared_ || prepared_->id != hit->id) ReleasePrepared(timestamp_s, window, result);
    gesture_.state = State::kPending;
    gesture_.target = *hit;
  }

  void Reject(Verdict verdict, Result& result) {
    gesture_.state = State::kIgnored;
    result.verdict = verdict;
    ReleasePrepared(gesture_.time, gesture_.window, result);
  }

  void MergeContent(const ContentState& next) {
    ContentState& content = gesture_.content;
    if (content.ack == ContentAck::kPending) content.ack = next.ack;
    if (next.overscrolled) {
      content.overscroll_allowed = (content.overscrolled ? content.overscroll_allowed : true) && next.overscroll_allowed;
      content.overscrolled = true;
    }
  }

  bool Wait(Result& result) {
    result.verdict = Verdict::kWaiting;
    return false;
  }

  bool Refuse(Verdict verdict, Result& result) {
    Reject(verdict, result);
    return false;
  }

  bool ShouldTrack(Result& result) {
    const double dx = gesture_.dx;
    const double dy = gesture_.dy;
    const Target& target = *gesture_.target;
    const ContentState& content = gesture_.content;
    const double vertical_intent = target.is_pager ? kPagerVerticalIntent : kStartDistance;
    if (std::abs(dy) >= vertical_intent && kCancelDominance * std::abs(dx) < std::abs(dy)) {
      return Refuse(Verdict::kVerticalIntent, result);
    }
    const bool below = target.has_native_pager ? dx == 0 : std::abs(dx) < kStartDistance;
    if (below || kStartDominance * std::abs(dx) < std::abs(dy)) return Wait(result);
    const int direction = dx > 0 ? 1 : -1;
    if (content.ack == ContentAck::kConsumed) return Refuse(Verdict::kContentConsumed, result);
    if (target.page_hit) {
      if (content.ack == ContentAck::kPending || !content.overscrolled) return Wait(result);
      if (!content.overscroll_allowed) return Refuse(Verdict::kOverscrollBlocked, result);
    } else if (direction > 0 ? target.content_scrolls_back : target.content_scrolls_forward) {
      return Refuse(Verdict::kContentScrolls, result);
    }
    const bool available = direction > 0 ? target.can_swipe_back : target.can_swipe_forward;
    if (!available && !target.tracks_unavailable_directions) return Refuse(Verdict::kUnavailable, result);
    gesture_.direction = direction;
    gesture_.available = available;
    return true;
  }

  void Sample(double timestamp_s, double dx) {
    const std::size_t slot = gesture_.samples % kVelocitySamples;
    gesture_.times[slot] = timestamp_s;
    gesture_.deltas[slot] = dx;
    ++gesture_.samples;
  }

  double ReleaseVelocity(double now) const {
    const std::size_t n = gesture_.samples < kVelocitySamples ? gesture_.samples : kVelocitySamples;
    double sum = 0;
    double oldest = now;
    for (std::size_t k = 0; k < n; ++k) {
      if (now - gesture_.times[k] > kVelocityWindow) continue;
      sum += gesture_.deltas[k];
      oldest = std::min(oldest, gesture_.times[k]);
    }
    const double velocity = now - oldest > kMinVelocitySpan ? sum / (now - oldest) : 0;
    return std::isfinite(velocity) ? velocity : 0;
  }

  void Emit(desktop_pager::PagerInput input, double velocity, Result& result) {
    const Target& target = *gesture_.target;
    Action action;
    action.target = target.id;
    action.native_pager = target.has_native_pager;
    action.input = input;
    action.distance = gesture_.dx * gesture_.direction;
    action.direction = gesture_.direction;
    action.dy = gesture_.dy;
    action.velocity = velocity * gesture_.direction;
    action.available = gesture_.available;
    action.timestamp = gesture_.time;
    result.actions.push_back(action);
  }

  Gesture gesture_;
  std::optional<Target> prepared_;
  int64_t prepared_window_ = 0;
  MomentumState momentum_;
  double last_time_ = 0;
};

}

#endif
