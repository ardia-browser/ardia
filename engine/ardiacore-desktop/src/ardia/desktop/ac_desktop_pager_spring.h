#ifndef ARDIA_DESKTOP_AC_DESKTOP_PAGER_SPRING_H_
#define ARDIA_DESKTOP_AC_DESKTOP_PAGER_SPRING_H_

#include <algorithm>
#include <array>
#include <climits>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace ardia::desktop_pager {

inline constexpr double kTrackingScale = 0.5;
inline constexpr double kRubberDimension = 255;
inline constexpr double kRubberCoefficient = 0.15;
inline constexpr double kFlickVelocity = 5;
inline constexpr double kOmega = 2 * std::numbers::pi / 0.25;
inline constexpr double kRestDisplacement = 0.003;
inline constexpr double kRestSpeed = 0.1;
inline constexpr double kHistoryWindow = 0.1;
inline constexpr std::size_t kHistoryCapacity = 64;
inline constexpr double kMinPageWidth = 1;
inline constexpr double kMaxReleaseVelocity = 40;
inline constexpr double kMaxSettleSeconds = 2;
inline constexpr double kFirstFrameLead = 1.0 / 60;

enum class PagerInput { kPrepare, kAbandon, kBegan, kChanged, kEnded, kCancelled };

enum class PagerPhase { kIdle, kTracking, kHolding, kSettling };

constexpr std::string_view InputName(PagerInput input) {
  switch (input) {
    case PagerInput::kPrepare:
      return "prepare";
    case PagerInput::kAbandon:
      return "abandon";
    case PagerInput::kBegan:
      return "began";
    case PagerInput::kChanged:
      return "changed";
    case PagerInput::kEnded:
      return "ended";
    case PagerInput::kCancelled:
      return "cancelled";
  }
  return "cancelled";
}

constexpr std::optional<PagerInput> ParseInput(std::string_view name) {
  for (PagerInput input : {PagerInput::kPrepare, PagerInput::kAbandon, PagerInput::kBegan, PagerInput::kChanged,
                           PagerInput::kEnded, PagerInput::kCancelled}) {
    if (InputName(input) == name) return input;
  }
  return std::nullopt;
}

constexpr std::string_view PhaseName(PagerPhase phase) {
  switch (phase) {
    case PagerPhase::kIdle:
      return "idle";
    case PagerPhase::kTracking:
      return "tracking";
    case PagerPhase::kHolding:
      return "holding";
    case PagerPhase::kSettling:
      return "settling";
  }
  return "idle";
}

inline double RubberBand(double value, double dimension) {
  if (!(value > 0)) return 0;
  if (std::isinf(value)) return dimension;
  return (1 - 1 / (value * kRubberCoefficient / dimension + 1)) * dimension;
}

inline int ClampToIndex(double value, int lo, int hi) {
  if (std::isnan(value)) return lo;
  return static_cast<int>(std::clamp(value, static_cast<double>(lo), static_cast<double>(hi)));
}

inline int FloorToInt(double value) {
  return ClampToIndex(std::floor(value), INT_MIN, INT_MAX);
}

inline int CeilToInt(double value) {
  return ClampToIndex(std::ceil(value), INT_MIN, INT_MAX);
}

struct Frame {
  double position = 0;
  double velocity = 0;
  PagerPhase phase = PagerPhase::kIdle;
  int selected = 0;
  int count = 1;
  int64_t sequence = 0;
  int64_t selection_sequence = 0;
  bool moved = false;
  bool began = false;
  bool selected_changed = false;
  bool settled = false;
  bool detent_crossed = false;
  int detent_crossings = 0;
  bool needs_frame = false;
};

class PagerSpring {
 public:
  void Configure(int count, int selected, int64_t ack, const std::vector<std::string>* order = nullptr) {
    ApplyConfiguration(count, selected, ack, order);
    if (pending_selection_ && !PendingSelectionHolds()) pending_selection_.reset();
  }

  void Input(PagerInput input, double distance, int direction, double page_width, double timestamp_s) {
    if (!configured_) return;
    switch (input) {
      case PagerInput::kPrepare:
        if (phase_ == PagerPhase::kSettling) {
          StopSpring();
          phase_ = PagerPhase::kHolding;
          velocity_ = 0;
        }
        return;
      case PagerInput::kAbandon:
        if (phase_ == PagerPhase::kHolding) {
          Settle(selected_, 0);
        } else if (phase_ == PagerPhase::kTracking) {
          Release(0, false);
        }
        return;
      case PagerInput::kBegan:
        Begin();
        Track(distance, direction, page_width, timestamp_s, true);
        return;
      case PagerInput::kChanged:
        if (phase_ != PagerPhase::kTracking) return;
        Track(distance, direction, page_width, timestamp_s, true);
        return;
      case PagerInput::kEnded:
      case PagerInput::kCancelled:
        if (phase_ != PagerPhase::kTracking) return;
        Track(distance, direction, page_width, timestamp_s, false);
        Release(ReleaseVelocity(timestamp_s), input == PagerInput::kCancelled);
        return;
    }
  }

  Frame StepFrame(double timestamp_s) {
    if (!std::isfinite(timestamp_s)) return Drain();
    const double now = last_frame_ ? std::max(timestamp_s, *last_frame_) : timestamp_s;
    const double previous = last_frame_.value_or(now);
    last_frame_ = now;
    if (phase_ == PagerPhase::kSettling && spring_) {
      if (!spring_->start) spring_->start = now - std::clamp(now - previous, 0.0, kFirstFrameLead);
      AdvanceSpring(now - *spring_->start);
    }
    return Drain();
  }

  Frame Snapshot() const {
    Frame frame;
    frame.position = position_;
    frame.velocity = velocity_;
    frame.phase = phase_;
    frame.selected = selected_;
    frame.count = count_;
    frame.sequence = sequence_;
    frame.selection_sequence = selection_sequence_;
    frame.moved = moved_;
    frame.began = began_;
    frame.selected_changed = PendingSelectionHolds();
    frame.settled = settled_;
    frame.detent_crossed = detent_crossings_ > 0;
    frame.detent_crossings = detent_crossings_;
    frame.needs_frame = phase_ == PagerPhase::kSettling;
    return frame;
  }

  bool SwitchTo(int index, const std::vector<std::string>* order = nullptr) {
    if (!configured_) return false;
    Sync(order);
    const int target = std::clamp(index, 0, count_ - 1);
    const double v = phase_ == PagerPhase::kSettling ? velocity_ : 0;
    Settle(target, Towards(target, v));
    return true;
  }

  bool Step(int delta, bool wrap, const std::vector<std::string>* order = nullptr) {
    if (!configured_) return false;
    Sync(order);
    const int64_t count = count_;
    const int64_t moved = static_cast<int64_t>(selected_) + delta;
    const int64_t target = wrap ? ((moved % count) + count) % count : std::clamp<int64_t>(moved, 0, count - 1);
    return target == selected_ || SwitchTo(static_cast<int>(target));
  }

  bool Select(std::string_view id, const std::vector<std::string>& order) {
    if (!configured_ || order.size() > static_cast<std::size_t>(INT_MAX)) return false;
    const auto found = std::find(order.begin(), order.end(), id);
    if (found == order.end()) return false;
    CancelMotion();
    count_ = static_cast<int>(order.size());
    SetOrder(&order);
    Jump(static_cast<int>(found - order.begin()), true);
    AnnounceSelection();
    return true;
  }

  void SetReduceMotion(bool reduce) {
    reduce_motion_ = reduce;
    if (reduce && phase_ == PagerPhase::kSettling && spring_) Rest(spring_->target);
  }

  bool configured() const { return configured_; }
  bool reduce_motion() const { return reduce_motion_; }
  PagerPhase phase() const { return phase_; }
  double position() const { return position_; }
  double velocity() const { return velocity_; }
  int selected() const { return selected_; }
  int count() const { return count_; }
  int64_t sequence() const { return sequence_; }
  int64_t selection_sequence() const { return selection_sequence_; }
  std::size_t history_size() const { return history_size_; }

  std::optional<std::string_view> selected_id() const {
    if (!has_order_ || selected_ < 0 || static_cast<std::size_t>(selected_) >= order_.size()) return std::nullopt;
    return std::string_view(order_[static_cast<std::size_t>(selected_)]);
  }

 private:
  struct Drag {
    double start = 0;
    double width = 0;
    int lo = 0;
    int hi = 0;
    int home = 0;
    int detent = 0;
  };

  struct Sample {
    double time = 0;
    double position = 0;
  };

  struct PendingSelection {
    int64_t sequence = 0;
    int index = 0;
    std::optional<std::string> id;
  };

  struct Spring {
    double from = 0;
    int target = 0;
    double velocity = 0;
    std::optional<double> start;
  };

  int64_t Next() { return ++counter_; }

  void ApplyConfiguration(int count, int selected, int64_t ack, const std::vector<std::string>* order) {
    const int clamped = std::max(1, count);
    prop_selected_ = std::clamp(selected, 0, clamped - 1);
    prop_ack_ = std::max(prop_ack_, ack);
    if (!configured_) {
      configured_ = true;
      count_ = clamped;
      SetOrder(order);
      selected_ = prop_selected_;
      position_ = selected_;
      sequence_ = Next();
      moved_ = true;
      return;
    }
    const bool reordered = order && (!has_order_ || *order != order_);
    if (clamped != count_ || reordered) {
      int index = prop_selected_;
      const bool had_order = has_order_;
      const std::vector<std::string> old = order_;
      count_ = clamped;
      SetOrder(order);
      if (prop_ack_ < selection_sequence_ && had_order && has_order_ && selected_ >= 0 &&
          static_cast<std::size_t>(selected_) < old.size()) {
        const auto moved = std::find(order_.begin(), order_.end(), old[static_cast<std::size_t>(selected_)]);
        if (moved != order_.end()) index = static_cast<int>(moved - order_.begin());
      }
      CancelMotion();
      Jump(std::clamp(index, 0, count_ - 1));
      return;
    }
    Reconcile();
  }

  void SetOrder(const std::vector<std::string>* order) {
    has_order_ = order != nullptr;
    if (order) {
      order_ = *order;
    } else {
      order_.clear();
    }
  }

  void Reconcile() {
    if (phase_ != PagerPhase::kIdle || prop_ack_ < selection_sequence_ || prop_selected_ == selected_) return;
    Jump(std::clamp(prop_selected_, 0, count_ - 1));
  }

  void Jump(int index, bool selection = false) {
    selected_ = index;
    position_ = index;
    velocity_ = 0;
    sequence_ = Next();
    if (selection) selection_sequence_ = sequence_;
    moved_ = true;
  }

  void Begin() {
    StopSpring();
    const int home = selected_;
    const double x = position_;
    const int lo = std::max(0, std::min(home - 1, FloorToInt(x)));
    const int hi = std::min(count_ - 1, std::max(home + 1, CeilToInt(x)));
    drag_ = Drag{x, 0, lo, hi, home, ClampToIndex(std::round(x), lo, hi)};
    history_size_ = 0;
    history_head_ = 0;
    velocity_ = 0;
    phase_ = PagerPhase::kTracking;
    sequence_ = Next();
    began_ = true;
  }

  void Track(double distance, int direction, double page_width, double timestamp_s, bool sample) {
    if (std::isfinite(page_width) && page_width >= kMinPageWidth) drag_.width = page_width;
    const double width = drag_.width;
    if (!(width >= kMinPageWidth) || !std::isfinite(distance)) return;
    const double raw = drag_.start + (direction > 0 ? -1.0 : 1.0) * (distance * kTrackingScale / width);
    const double lo = drag_.lo;
    const double hi = drag_.hi;
    double x = raw;
    if (raw > hi) {
      x = hi + RubberBand((raw - hi) * width, kRubberDimension) / width;
    } else if (raw < lo) {
      x = lo - RubberBand((lo - raw) * width, kRubberDimension) / width;
    }
    if (!std::isfinite(x)) return;
    position_ = x;
    moved_ = true;
    if (sample && std::isfinite(timestamp_s)) Record(timestamp_s, x);
    const int nearest = ClampToIndex(std::round(x), drag_.lo, drag_.hi);
    if (nearest != drag_.detent) {
      const int64_t crossed = std::abs(static_cast<int64_t>(nearest) - drag_.detent);
      detent_crossings_ = static_cast<int>(std::min<int64_t>(INT_MAX, detent_crossings_ + crossed));
      drag_.detent = nearest;
    }
  }

  const Sample& HistoryAt(std::size_t offset) const {
    return history_[(history_head_ + offset) % kHistoryCapacity];
  }

  void Record(double timestamp_s, double x) {
    const double time = history_size_ ? std::max(timestamp_s, HistoryAt(history_size_ - 1).time) : timestamp_s;
    if (history_size_ == kHistoryCapacity) {
      history_head_ = (history_head_ + 1) % kHistoryCapacity;
      --history_size_;
    }
    history_[(history_head_ + history_size_) % kHistoryCapacity] = Sample{time, x};
    ++history_size_;
    while (history_size_ && time - HistoryAt(0).time > kHistoryWindow) {
      history_head_ = (history_head_ + 1) % kHistoryCapacity;
      --history_size_;
    }
  }

  double ReleaseVelocity(double timestamp_s) const {
    if (!history_size_) return 0;
    const double last_time = HistoryAt(history_size_ - 1).time;
    const double now = std::isfinite(timestamp_s) ? std::max(timestamp_s, last_time) : last_time;
    std::optional<Sample> first;
    std::optional<Sample> last;
    std::size_t recent = 0;
    for (std::size_t i = 0; i < history_size_; ++i) {
      const Sample& sample = HistoryAt(i);
      if (now - sample.time > kHistoryWindow) continue;
      if (!first) first = sample;
      last = sample;
      ++recent;
    }
    if (recent < 2 || !(last->time > first->time)) return 0;
    const double v = (last->position - first->position) / (last->time - first->time);
    if (!std::isfinite(v)) return 0;
    return std::clamp(v, -kMaxReleaseVelocity, kMaxReleaseVelocity);
  }

  void Release(double v, bool cancelled) {
    const int home = drag_.home;
    int target = home;
    if (!cancelled) {
      const bool flick = std::abs(v * drag_.width) >= kFlickVelocity;
      const double aim = !flick ? std::round(position_) : v > 0 ? std::floor(position_) + 1 : std::ceil(position_) - 1;
      const int lo = std::max(0, home - 1);
      const int hi = std::max(lo, std::min(count_ - 1, home + 1));
      target = ClampToIndex(aim, lo, hi);
    }
    Settle(target, Towards(target, v));
  }

  double WithoutOvershoot(int target, double v) const {
    const double reach = kOmega * std::abs(target - position_);
    return std::clamp(v, -reach, reach);
  }

  double Towards(int target, double v) const {
    const double d = target - position_;
    return d != 0 && v != 0 && (d > 0) == (v > 0) ? v : 0;
  }

  void Sync(const std::vector<std::string>* order) {
    if (!order || order->empty() || (has_order_ && *order == order_)) return;
    std::optional<std::string> current;
    if (auto id = selected_id()) current = std::string(*id);
    const bool kept = current && std::find(order->begin(), order->end(), *current) != order->end();
    const std::size_t fallback =
        std::min(static_cast<std::size_t>(std::max(prop_selected_, 0)), order->size() - 1);
    const std::string id = kept ? *current : (*order)[fallback];
    Select(id, *order);
  }

  void Settle(int target, double v) {
    if (target != selected_) {
      selected_ = target;
      sequence_ = Next();
      selection_sequence_ = sequence_;
      AnnounceSelection();
    }
    StopSpring();
    if (reduce_motion_) {
      Rest(target);
      return;
    }
    phase_ = PagerPhase::kSettling;
    const double bounded = WithoutOvershoot(target, v);
    velocity_ = bounded;
    spring_ = Spring{position_, target, bounded, std::nullopt};
  }

  void AdvanceSpring(double t) {
    const Spring s = *spring_;
    const double x0 = s.from - s.target;
    const double b = s.velocity + kOmega * x0;
    const double decay = std::exp(-kOmega * t);
    const double x = (x0 + b * t) * decay;
    const double v = (s.velocity - kOmega * b * t) * decay;
    if ((std::abs(x) < kRestDisplacement && std::abs(v) < kRestSpeed) || t >= kMaxSettleSeconds ||
        !std::isfinite(x) || !std::isfinite(v)) {
      Rest(s.target);
      return;
    }
    position_ = s.target + x;
    velocity_ = v;
    moved_ = true;
  }

  void Rest(int target) {
    StopSpring();
    position_ = target;
    velocity_ = 0;
    phase_ = PagerPhase::kIdle;
    sequence_ = Next();
    moved_ = true;
    settled_ = true;
    Reconcile();
  }

  void StopSpring() { spring_.reset(); }

  void AnnounceSelection() {
    pending_selection_ = PendingSelection{selection_sequence_, selected_, std::nullopt};
    if (auto id = selected_id()) pending_selection_->id = std::string(*id);
  }

  bool PendingSelectionHolds() const {
    if (!pending_selection_ || pending_selection_->sequence != selection_sequence_) return false;
    if (pending_selection_->id) return selected_id() == std::optional<std::string_view>(*pending_selection_->id);
    return pending_selection_->index == selected_;
  }

  void CancelMotion() {
    StopSpring();
    phase_ = PagerPhase::kIdle;
    velocity_ = 0;
  }

  Frame Drain() {
    Frame frame = Snapshot();
    moved_ = false;
    began_ = false;
    pending_selection_.reset();
    settled_ = false;
    detent_crossings_ = 0;
    return frame;
  }

  bool configured_ = false;
  bool reduce_motion_ = false;
  int count_ = 1;
  bool has_order_ = false;
  std::vector<std::string> order_;
  int selected_ = 0;
  double position_ = 0;
  double velocity_ = 0;
  PagerPhase phase_ = PagerPhase::kIdle;
  int64_t counter_ = 0;
  int64_t sequence_ = 0;
  int64_t selection_sequence_ = 0;
  int prop_selected_ = 0;
  int64_t prop_ack_ = 0;
  Drag drag_;
  std::array<Sample, kHistoryCapacity> history_{};
  std::size_t history_head_ = 0;
  std::size_t history_size_ = 0;
  std::optional<Spring> spring_;
  std::optional<double> last_frame_;
  bool moved_ = false;
  bool began_ = false;
  std::optional<PendingSelection> pending_selection_;
  bool settled_ = false;
  int detent_crossings_ = 0;
};

}

#endif
