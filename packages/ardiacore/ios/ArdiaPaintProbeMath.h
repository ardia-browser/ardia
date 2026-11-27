#pragma once

#include <cstddef>
#include <vector>

namespace ardia_paint_probe {

enum Reason : unsigned {
  kAlphaZero = 1u << 0,
  kViewHidden = 1u << 1,
  kPageHidden = 1u << 2,
  kPageDetached = 1u << 3,
  kFrameHoldAwaiting = 1u << 4,
  kStandInLent = 1u << 5,
  kStandInLeaving = 1u << 6,
  kVeilUp = 1u << 7,
  kStandInShowing = 1u << 8,
};

constexpr unsigned kReasonCount = 9;

constexpr unsigned kInformationalReasons = kStandInShowing;
constexpr unsigned kBlockingReasons = ((1u << kReasonCount) - 1) & ~kInformationalReasons;
constexpr unsigned kCoveredByStandIn = kPageHidden | kPageDetached | kFrameHoldAwaiting;

constexpr unsigned kMaxHeldMs = 600000;

struct View {
  bool alphaZero = false;
  bool viewHidden = false;
  bool pageHidden = false;
  bool pageDetached = false;
  bool awaitingFrame = false;
  bool standInLent = false;
  bool standInLeaving = false;
  bool veilUp = false;
  bool standInShowing = false;
};

inline unsigned ReasonsOf(const View &view) {
  unsigned reasons = 0;
  if (view.alphaZero) reasons |= kAlphaZero;
  if (view.viewHidden) reasons |= kViewHidden;
  if (view.pageHidden) reasons |= kPageHidden;
  if (view.pageDetached) reasons |= kPageDetached;
  if (view.awaitingFrame) reasons |= kFrameHoldAwaiting;
  if (view.standInLent) reasons |= kStandInLent;
  if (view.standInLeaving) reasons |= kStandInLeaving;
  if (view.veilUp) reasons |= kVeilUp;
  if (view.standInLent && view.standInShowing && !view.standInLeaving) {
    reasons &= ~(kStandInLent | kCoveredByStandIn);
    reasons |= kStandInShowing;
  }
  return reasons;
}

inline unsigned HeldMs(double now, double since) {
  if (since <= 0 || now <= since) return 0;
  const double ms = (now - since) * 1000 + 0.5;
  return ms >= kMaxHeldMs ? kMaxHeldMs : static_cast<unsigned>(ms);
}

inline double EarliestHold(double a, double b) {
  if (a <= 0) return b > 0 ? b : 0;
  if (b <= 0) return a;
  return a < b ? a : b;
}

inline double EarliestHold(double a, double b, double c) { return EarliestHold(EarliestHold(a, b), c); }

constexpr double kInvisibleAlpha = 0.01;

inline bool Invisible(bool hidden, double alpha, double layerOpacity) {
  return hidden || alpha <= kInvisibleAlpha || layerOpacity <= kInvisibleAlpha;
}

struct StandInLayer {
  bool attached = false;
  bool hidden = false;
  double alpha = 1;
  bool abovePage = false;
  bool pageShown = false;
};

inline bool StandInShows(const StandInLayer &layer) {
  return layer.attached && !layer.hidden && layer.alpha > kInvisibleAlpha && (layer.abovePage || !layer.pageShown);
}

struct Tally {
  unsigned views = 0;
  unsigned unpainted = 0;
  unsigned reasons = 0;
  unsigned heldMs = 0;

  void Add(unsigned viewReasons, unsigned held = 0) {
    views++;
    if (viewReasons == 0) return;
    reasons |= viewReasons;
    if (held > heldMs) heldMs = held;
    if (viewReasons & kBlockingReasons) unpainted++;
  }
};

struct Episode {
  bool sent = false;

  bool ShouldSend(const Tally &tally) {
    if (tally.unpainted == 0) {
      sent = false;
      return false;
    }
    if (sent) return false;
    sent = true;
    return true;
  }

  void Settle(const Tally &followUp) {
    if (followUp.unpainted == 0) sent = false;
  }
};

struct FollowUp {
  unsigned long generation = 0;
  bool pending = false;

  unsigned long Hold() {
    pending = true;
    return ++generation;
  }

  bool Take(unsigned long due) {
    if (!pending || due != generation) return false;
    pending = false;
    return true;
  }

  void Drop() { pending = false; }
};

struct StackStep {
  double z = 0;
  unsigned long index = 0;
};

using StackPath = std::vector<StackStep>;

inline bool DrawnAbove(const StackPath &upper, const StackPath &lower) {
  const std::size_t shared = upper.size() < lower.size() ? upper.size() : lower.size();
  for (std::size_t level = 0; level < shared; level++) {
    const StackStep &a = upper[level], &b = lower[level];
    if (a.index == b.index) continue;
    return a.z != b.z ? a.z > b.z : a.index > b.index;
  }
  return false;
}

}
