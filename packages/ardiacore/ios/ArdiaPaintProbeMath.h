#pragma once

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
};

constexpr unsigned kReasonCount = 8;

struct View {
  bool alphaZero = false;
  bool viewHidden = false;
  bool pageHidden = false;
  bool pageDetached = false;
  bool awaitingFrame = false;
  bool standInLent = false;
  bool standInLeaving = false;
  bool veilUp = false;
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
  return reasons;
}

struct Tally {
  unsigned views = 0;
  unsigned unpainted = 0;
  unsigned reasons = 0;

  void Add(unsigned viewReasons) {
    views++;
    if (viewReasons == 0) return;
    unpainted++;
    reasons |= viewReasons;
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
};

}
