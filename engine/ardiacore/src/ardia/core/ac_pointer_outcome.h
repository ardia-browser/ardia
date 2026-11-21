// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_CORE_AC_POINTER_OUTCOME_H_
#define ARDIA_CORE_AC_POINTER_OUTCOME_H_

#include <cstddef>
#include <cstdint>
#include <set>
#include <vector>

namespace ardia {

class PageEpoch {
 public:
  uint64_t value() const { return value_; }
  void Committed() { ++value_; }
  bool Unchanged(uint64_t admitted) const {
    return admitted != 0 && admitted == value_;
  }

 private:
  uint64_t value_ = 1;
};

enum class PointerEventResult { kPending, kNotSent, kSentUnknown, kAcked };

enum class PointerOutcome { kPending, kDone, kNotDelivered, kUnknown };

struct PointerEvent {
  bool press = false;
  PointerEventResult result = PointerEventResult::kPending;
};

inline bool PointerEventSent(const PointerEvent& event) {
  return event.result == PointerEventResult::kSentUnknown ||
         event.result == PointerEventResult::kAcked;
}

inline PointerOutcome PointerOutcomeOf(const std::vector<PointerEvent>& events,
                                       bool epoch_unchanged,
                                       bool widget_alive) {
  if (events.empty()) {
    return PointerOutcome::kNotDelivered;
  }
  bool all_acked = true;
  bool press_sent = false;
  bool has_press = false;
  for (const PointerEvent& event : events) {
    if (event.result == PointerEventResult::kPending) {
      return PointerOutcome::kPending;
    }
    all_acked = all_acked && event.result == PointerEventResult::kAcked;
    has_press = has_press || event.press;
    press_sent = press_sent || (event.press && PointerEventSent(event));
  }
  if (has_press ? !press_sent : !PointerEventSent(events.front())) {
    return PointerOutcome::kNotDelivered;
  }
  return all_acked && epoch_unchanged && widget_alive ? PointerOutcome::kDone
                                                      : PointerOutcome::kUnknown;
}

template <typename Key>
class OutstandingSlots {
 public:
  bool Take(const Key& key) { return held_.insert(key).second; }
  void Release(const Key& key) { held_.erase(key); }
  bool Held(const Key& key) const { return held_.contains(key); }

 private:
  std::set<Key> held_;
};

class WheelSlotState {
 public:
  bool Forward() {
    if (phase_ != Phase::kWaiting) {
      return false;
    }
    phase_ = Phase::kForwarded;
    return true;
  }

  bool Abandon() {
    if (phase_ != Phase::kWaiting) {
      return false;
    }
    phase_ = Phase::kFreed;
    return true;
  }

  bool Expire() { return Abandon(); }

  bool Acked(bool phase_end) {
    if (phase_ != Phase::kForwarded) {
      return false;
    }
    (phase_end ? phase_end_acked_ : wheel_acked_) = true;
    if (!wheel_acked_ || !phase_end_acked_) {
      return false;
    }
    phase_ = Phase::kFreed;
    return true;
  }

  bool Gone() {
    if (phase_ == Phase::kFreed) {
      return false;
    }
    phase_ = Phase::kFreed;
    return true;
  }

  bool forwarded() const { return phase_ == Phase::kForwarded; }
  bool freed() const { return phase_ == Phase::kFreed; }

 private:
  enum class Phase { kWaiting, kForwarded, kFreed };
  Phase phase_ = Phase::kWaiting;
  bool wheel_acked_ = false;
  bool phase_end_acked_ = false;
};

inline bool RefusesHiddenTarget(bool wheel, bool hidden) {
  return wheel && hidden;
}

inline constexpr int64_t kPersonBusyMicroseconds = 500000;

inline bool PersonBusy(bool hidden,
                       bool person_input_seen,
                       int64_t microseconds_since_person_input) {
  return !hidden && person_input_seen && microseconds_since_person_input >= 0 &&
         microseconds_since_person_input < kPersonBusyMicroseconds;
}

inline bool NeedsRecoveryRelease(const std::vector<PointerEvent>& events,
                                 PointerOutcome outcome) {
  if (outcome != PointerOutcome::kUnknown) {
    return false;
  }
  for (const PointerEvent& event : events) {
    if (event.press && PointerEventSent(event)) {
      return true;
    }
  }
  return false;
}

}

#endif
