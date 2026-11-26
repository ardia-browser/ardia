#ifndef ARDIA_DESKTOP_AC_DESKTOP_TAB_REVEAL_H_
#define ARDIA_DESKTOP_AC_DESKTOP_TAB_REVEAL_H_

#include <algorithm>
#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <utility>
#include <vector>

namespace ardia::desktop_tab_reveal {

using TabId = int64_t;
using PaneId = int64_t;
using SurfaceEpoch = uint64_t;

inline constexpr TabId kNoTab = 0;
inline constexpr SurfaceEpoch kNoEpoch = 0;
inline constexpr int64_t kDefaultHoldMs = 150;
inline constexpr int64_t kMaxHoldMs = 1000;
inline constexpr int32_t kDefaultSizeTolerancePx = 1;
inline constexpr int32_t kMaxSizeTolerancePx = 64;

struct RevealConfig {
  int64_t hold_ms = kDefaultHoldMs;
  int32_t size_tolerance_px = kDefaultSizeTolerancePx;
};

struct TabSurfaceState {
  TabId tab_id = kNoTab;
  bool has_committed_frame = false;
  int32_t surface_width = 0;
  int32_t surface_height = 0;
  bool is_dom_only = false;
  bool is_evicted = false;
  bool is_crashed = false;
};

enum class RevealAction { kNone, kShowTargetNow, kHoldPrevious, kHideAllNative };

enum class SwitchKind { kNone, kInstant, kHeld, kCold, kDomOnly, kEmpty };

struct Reveal {
  PaneId pane_id = 0;
  RevealAction action = RevealAction::kNone;
  SwitchKind kind = SwitchKind::kNone;
  TabId visible = kNoTab;
  TabId awaiting = kNoTab;
  SurfaceEpoch awaiting_epoch = kNoEpoch;
  std::vector<TabId> hide;
  int64_t deadline_ms = 0;
  uint64_t generation = 0;
};

struct RevealStats {
  uint64_t instant_reveals = 0;
  uint64_t held_until_frame = 0;
  uint64_t deadline_fallbacks = 0;
  uint64_t superseded_switches = 0;
  uint64_t dom_only_switches = 0;
  uint64_t cold_reveals = 0;
  uint64_t dropped_holds = 0;
  uint64_t hold_count = 0;
  int64_t hold_duration_ms_sum = 0;
  int64_t hold_duration_ms_max = 0;
};

class TabRevealCoordinator {
 public:
  TabRevealCoordinator() = default;
  explicit TabRevealCoordinator(RevealConfig config) { Configure(config); }

  void Configure(RevealConfig config) {
    config_.hold_ms = std::clamp<int64_t>(config.hold_ms, 0, kMaxHoldMs);
    config_.size_tolerance_px = std::clamp<int32_t>(config.size_tolerance_px, 0, kMaxSizeTolerancePx);
  }

  const RevealConfig& config() const { return config_; }

  std::vector<Reveal> SetReducedMotion(bool reduced, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals = ExpireDue(now);
    reduced_motion_ = reduced;
    if (reduced) DropAllHolds(now, reveals);
    return reveals;
  }

  bool reduced_motion() const { return reduced_motion_; }

  std::vector<Reveal> SetWindowVisible(bool visible, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals = ExpireDue(now);
    window_visible_ = visible;
    if (!visible) DropAllHolds(now, reveals);
    return reveals;
  }

  bool window_visible() const { return window_visible_; }

  std::vector<Reveal> ResizePane(PaneId pane_id, int32_t width, int32_t height, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals = ExpireDue(now);
    Pane& pane = panes_[pane_id];
    pane.width = width;
    pane.height = height;
    if (pane.pending && Fits(pane, pane.target)) reveals.push_back(Settle(pane_id, pane, now, Outcome::kFrame));
    return reveals;
  }

  std::vector<Reveal> RemovePane(PaneId pane_id, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals = ExpireDue(now);
    const auto found = panes_.find(pane_id);
    if (found == panes_.end()) return reveals;
    Pane& pane = found->second;
    if (pane.pending) EndHold(pane, now, Outcome::kDropped);
    pane.pending = false;
    Reveal reveal = Base(pane_id, pane);
    reveal.action = RevealAction::kHideAllNative;
    reveal.kind = SwitchKind::kEmpty;
    reveal.visible = kNoTab;
    Hide(reveal, pane.visible, kNoTab);
    Hide(reveal, pane.target, kNoTab);
    panes_.erase(found);
    reveals.push_back(std::move(reveal));
    return reveals;
  }

  std::vector<Reveal> UpdateTab(const TabSurfaceState& state, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals = ExpireDue(now);
    if (state.tab_id == kNoTab) return reveals;
    const auto found = tabs_.find(state.tab_id);
    Surface next;
    next.state = state;
    bool invalidated = false;
    if (found == tabs_.end()) {
      next.epoch = ++next_epoch_;
    } else {
      const TabSurfaceState& was = found->second.state;
      invalidated = was.is_crashed != state.is_crashed || was.is_evicted != state.is_evicted ||
                    was.is_dom_only != state.is_dom_only || (was.has_committed_frame && !state.has_committed_frame);
      next.epoch = invalidated ? ++next_epoch_ : found->second.epoch;
    }
    tabs_[state.tab_id] = next;
    React(state.tab_id, now, reveals);
    if (invalidated) ReissueAwaitedEpoch(state.tab_id, reveals);
    return reveals;
  }

  std::vector<Reveal> OnTargetFrameCommitted(TabId tab_id, SurfaceEpoch epoch, int32_t width, int32_t height,
                                             int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals = ExpireDue(now);
    const auto found = tabs_.find(tab_id);
    if (tab_id == kNoTab || found == tabs_.end() || found->second.epoch != epoch) return reveals;
    TabSurfaceState& state = found->second.state;
    if (state.is_crashed || state.is_dom_only) return reveals;
    state.has_committed_frame = true;
    state.surface_width = width;
    state.surface_height = height;
    state.is_evicted = false;
    React(tab_id, now, reveals);
    return reveals;
  }

  std::vector<Reveal> OnTabCrashed(TabId tab_id, int64_t now_ms) {
    const auto found = tabs_.find(tab_id);
    if (tab_id == kNoTab || found == tabs_.end()) return ExpireDue(Now(now_ms));
    TabSurfaceState crashed = found->second.state;
    crashed.is_crashed = true;
    crashed.has_committed_frame = false;
    return UpdateTab(crashed, now_ms);
  }

  std::vector<Reveal> OnTabClosed(TabId tab_id, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals = ExpireDue(now);
    if (tab_id == kNoTab || !tabs_.count(tab_id)) return reveals;
    tabs_.erase(tab_id);
    for (auto& [id, pane] : panes_) {
      if (pane.pending && pane.visible == tab_id) {
        pane.visible = kNoTab;
        reveals.push_back(Settle(id, pane, now, Outcome::kDropped));
      } else if (pane.pending && pane.target == tab_id) {
        pane.target = kNoTab;
        pane.generation = NextGeneration();
        Reveal reveal = Base(id, pane);
        reveal.action = RevealAction::kHoldPrevious;
        reveal.kind = SwitchKind::kHeld;
        reveals.push_back(std::move(reveal));
      } else if (pane.visible == tab_id) {
        pane.visible = kNoTab;
        if (pane.target == tab_id) pane.target = kNoTab;
        Reveal reveal = Base(id, pane);
        reveal.action = RevealAction::kHideAllNative;
        reveal.kind = SwitchKind::kEmpty;
        reveals.push_back(std::move(reveal));
      } else if (pane.target == tab_id) {
        pane.target = kNoTab;
      }
    }
    return reveals;
  }

  std::vector<Reveal> Switch(PaneId pane_id, TabId target, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals = ExpireDue(now);
    Pane& pane = panes_[pane_id];
    if (target == pane.target &&
        (pane.pending ? target != kNoTab : target == pane.visible || target == kNoTab || IsDomOnly(target))) {
      return reveals;
    }
    if (target != kNoTab && !tabs_.count(target)) {
      Surface fresh;
      fresh.state.tab_id = target;
      fresh.epoch = ++next_epoch_;
      tabs_[target] = fresh;
    }
    if (target != kNoTab) DetachFromOtherPanes(pane_id, target, now, reveals);
    const bool was_pending = pane.pending;
    const TabId previous_target = pane.target;
    pane.generation = NextGeneration();
    pane.target = target;
    if (was_pending && previous_target != kNoTab) ++stats_.superseded_switches;

    if (target == kNoTab || IsDomOnly(target)) {
      if (was_pending) EndHold(pane, now, Outcome::kDropped);
      pane.pending = false;
      Reveal reveal = Base(pane_id, pane);
      reveal.action = RevealAction::kHideAllNative;
      reveal.kind = target == kNoTab ? SwitchKind::kEmpty : SwitchKind::kDomOnly;
      if (target != kNoTab) ++stats_.dom_only_switches;
      Hide(reveal, pane.visible, kNoTab);
      Hide(reveal, previous_target, kNoTab);
      pane.visible = kNoTab;
      reveal.visible = kNoTab;
      reveals.push_back(std::move(reveal));
      return reveals;
    }

    if ((target == pane.visible && IsPainted(target)) || Fits(pane, target)) {
      if (was_pending) EndHold(pane, now, Outcome::kDropped);
      pane.pending = false;
      const TabId outgoing = pane.visible;
      pane.visible = target;
      Reveal reveal = Base(pane_id, pane);
      reveal.action = RevealAction::kShowTargetNow;
      reveal.kind = SwitchKind::kInstant;
      ++stats_.instant_reveals;
      Hide(reveal, outgoing, target);
      if (was_pending) Hide(reveal, previous_target, target);
      reveals.push_back(std::move(reveal));
      return reveals;
    }

    const int64_t hold = HoldBudgetMs();
    if (was_pending && hold > 0 && IsPainted(pane.visible)) {
      Reveal reveal = Base(pane_id, pane);
      reveal.action = RevealAction::kHoldPrevious;
      reveal.kind = SwitchKind::kHeld;
      Hide(reveal, previous_target, pane.visible);
      reveals.push_back(std::move(reveal));
      return reveals;
    }

    if (was_pending) EndHold(pane, now, Outcome::kDropped);
    const TabId outgoing = pane.visible;
    const int64_t deadline = SaturatingAdd(now, hold);
    if (hold > 0 && deadline > now && IsPainted(outgoing)) {
      pane.pending = true;
      pane.hold_started_ms = now;
      pane.deadline_ms = deadline;
      Reveal reveal = Base(pane_id, pane);
      reveal.action = RevealAction::kHoldPrevious;
      reveal.kind = SwitchKind::kHeld;
      Hide(reveal, previous_target, outgoing);
      reveals.push_back(std::move(reveal));
      return reveals;
    }

    pane.pending = false;
    pane.visible = target;
    Reveal reveal = Base(pane_id, pane);
    reveal.action = RevealAction::kShowTargetNow;
    reveal.kind = SwitchKind::kCold;
    ++stats_.cold_reveals;
    Hide(reveal, outgoing, target);
    if (was_pending) Hide(reveal, previous_target, target);
    reveals.push_back(std::move(reveal));
    return reveals;
  }

  std::vector<Reveal> Tick(int64_t now_ms) { return ExpireDue(Now(now_ms)); }

  std::optional<int64_t> NextDeadlineMs() const {
    std::optional<int64_t> next;
    for (const auto& [id, pane] : panes_) {
      if (pane.pending && (!next || pane.deadline_ms < *next)) next = pane.deadline_ms;
    }
    return next;
  }

  bool IsHolding(PaneId pane_id) const {
    const auto found = panes_.find(pane_id);
    return found != panes_.end() && found->second.pending;
  }

  TabId VisibleTab(PaneId pane_id) const {
    const auto found = panes_.find(pane_id);
    return found == panes_.end() ? kNoTab : found->second.visible;
  }

  TabId TargetTab(PaneId pane_id) const {
    const auto found = panes_.find(pane_id);
    return found == panes_.end() ? kNoTab : found->second.target;
  }

  SurfaceEpoch EpochOf(TabId tab_id) const {
    const auto found = tabs_.find(tab_id);
    return found == tabs_.end() ? kNoEpoch : found->second.epoch;
  }

  const RevealStats& stats() const { return stats_; }

  RevealStats TakeStats() {
    const RevealStats taken = stats_;
    stats_ = RevealStats{};
    return taken;
  }

 private:
  enum class Outcome { kFrame, kDeadline, kDropped };

  struct Surface {
    TabSurfaceState state;
    SurfaceEpoch epoch = kNoEpoch;
  };

  struct Pane {
    int32_t width = 0;
    int32_t height = 0;
    TabId visible = kNoTab;
    TabId target = kNoTab;
    bool pending = false;
    uint64_t generation = 0;
    int64_t hold_started_ms = 0;
    int64_t deadline_ms = 0;
  };

  static int64_t SaturatingAdd(int64_t a, int64_t b) {
    return a > std::numeric_limits<int64_t>::max() - b ? std::numeric_limits<int64_t>::max() : a + b;
  }

  static bool Near(int32_t a, int32_t b, int32_t tolerance) {
    const int64_t difference = static_cast<int64_t>(a) - static_cast<int64_t>(b);
    return difference <= tolerance && -difference <= tolerance;
  }

  static bool HasArea(const TabSurfaceState& surface) {
    return surface.surface_width > 0 && surface.surface_height > 0;
  }

  int64_t Now(int64_t now_ms) {
    last_now_ms_ = std::max(last_now_ms_, std::max<int64_t>(now_ms, 0));
    return last_now_ms_;
  }

  uint64_t NextGeneration() { return ++next_generation_; }

  int64_t HoldBudgetMs() const { return reduced_motion_ || !window_visible_ ? 0 : config_.hold_ms; }

  bool IsDomOnly(TabId tab) const {
    const auto found = tabs_.find(tab);
    return found != tabs_.end() && found->second.state.is_dom_only;
  }

  bool IsPainted(TabId tab) const {
    const auto found = tabs_.find(tab);
    if (tab == kNoTab || found == tabs_.end()) return false;
    const TabSurfaceState& surface = found->second.state;
    return surface.has_committed_frame && HasArea(surface) && !surface.is_crashed && !surface.is_evicted &&
           !surface.is_dom_only;
  }

  bool Fits(const Pane& pane, TabId tab) const {
    if (!IsPainted(tab)) return false;
    const TabSurfaceState& surface = tabs_.at(tab).state;
    const bool laid_out = pane.width > 0 || pane.height > 0;
    if (!laid_out) return true;
    if (pane.width <= 0 || pane.height <= 0) return false;
    return Near(surface.surface_width, pane.width, config_.size_tolerance_px) &&
           Near(surface.surface_height, pane.height, config_.size_tolerance_px);
  }

  bool ShownByAnotherPane(TabId tab, PaneId pane_id) const {
    for (const auto& [id, pane] : panes_) {
      if (id != pane_id && (pane.visible == tab || pane.target == tab)) return true;
    }
    return false;
  }

  Reveal Base(PaneId pane_id, const Pane& pane) const {
    Reveal reveal;
    reveal.pane_id = pane_id;
    reveal.visible = pane.visible;
    reveal.awaiting = pane.pending ? pane.target : kNoTab;
    reveal.awaiting_epoch = pane.pending ? EpochOf(pane.target) : kNoEpoch;
    reveal.deadline_ms = pane.pending ? pane.deadline_ms : 0;
    reveal.generation = pane.generation;
    return reveal;
  }

  void Hide(Reveal& reveal, TabId tab, TabId keep) const {
    if (tab == kNoTab || tab == keep || !tabs_.count(tab) || ShownByAnotherPane(tab, reveal.pane_id)) return;
    if (std::find(reveal.hide.begin(), reveal.hide.end(), tab) != reveal.hide.end()) return;
    reveal.hide.push_back(tab);
  }

  void EndHold(Pane& pane, int64_t now, Outcome outcome) {
    const int64_t held = std::max<int64_t>(now - pane.hold_started_ms, 0);
    ++stats_.hold_count;
    stats_.hold_duration_ms_sum = SaturatingAdd(stats_.hold_duration_ms_sum, held);
    stats_.hold_duration_ms_max = std::max(stats_.hold_duration_ms_max, held);
    if (outcome == Outcome::kFrame) ++stats_.held_until_frame;
    if (outcome == Outcome::kDeadline) ++stats_.deadline_fallbacks;
    if (outcome == Outcome::kDropped) ++stats_.dropped_holds;
  }

  Reveal Settle(PaneId pane_id, Pane& pane, int64_t now, Outcome outcome) {
    EndHold(pane, now, outcome);
    pane.pending = false;
    const TabId held = pane.visible;
    const bool native = pane.target != kNoTab && !IsDomOnly(pane.target);
    pane.visible = native ? pane.target : kNoTab;
    Reveal reveal = Base(pane_id, pane);
    reveal.action = native ? RevealAction::kShowTargetNow : RevealAction::kHideAllNative;
    reveal.kind = native ? SwitchKind::kHeld : (pane.target == kNoTab ? SwitchKind::kEmpty : SwitchKind::kDomOnly);
    Hide(reveal, held, pane.visible);
    return reveal;
  }

  std::vector<Reveal> ExpireDue(int64_t now) {
    std::vector<Reveal> reveals;
    for (auto& [id, pane] : panes_) {
      if (pane.pending && now >= pane.deadline_ms) reveals.push_back(Settle(id, pane, now, Outcome::kDeadline));
    }
    return reveals;
  }

  void DropAllHolds(int64_t now, std::vector<Reveal>& reveals) {
    for (auto& [id, pane] : panes_) {
      if (pane.pending) reveals.push_back(Settle(id, pane, now, Outcome::kDropped));
    }
  }

  void DetachFromOtherPanes(PaneId pane_id, TabId tab, int64_t now, std::vector<Reveal>& reveals) {
    for (auto& [id, pane] : panes_) {
      if (id == pane_id || (pane.visible != tab && pane.target != tab)) continue;
      if (pane.pending && pane.visible == tab) {
        pane.visible = kNoTab;
        reveals.push_back(Settle(id, pane, now, Outcome::kDropped));
        continue;
      }
      if (pane.pending) {
        pane.target = kNoTab;
        pane.generation = NextGeneration();
        Reveal reveal = Base(id, pane);
        reveal.action = RevealAction::kHoldPrevious;
        reveal.kind = SwitchKind::kHeld;
        reveals.push_back(std::move(reveal));
        continue;
      }
      pane.visible = kNoTab;
      pane.target = kNoTab;
      pane.generation = NextGeneration();
      Reveal reveal = Base(id, pane);
      reveal.action = RevealAction::kHideAllNative;
      reveal.kind = SwitchKind::kEmpty;
      reveals.push_back(std::move(reveal));
    }
  }

  void ReissueAwaitedEpoch(TabId tab, std::vector<Reveal>& reveals) const {
    for (const auto& [id, pane] : panes_) {
      if (!pane.pending || pane.target != tab) continue;
      Reveal reveal = Base(id, pane);
      reveal.action = RevealAction::kHoldPrevious;
      reveal.kind = SwitchKind::kHeld;
      reveals.push_back(std::move(reveal));
    }
  }

  void React(TabId tab, int64_t now, std::vector<Reveal>& reveals) {
    const TabSurfaceState& state = tabs_.at(tab).state;
    for (auto& [id, pane] : panes_) {
      if (pane.pending && pane.visible == tab && !IsPainted(tab)) {
        reveals.push_back(Settle(id, pane, now, Outcome::kDropped));
      } else if (pane.pending && pane.target == tab) {
        if (state.is_dom_only || state.is_crashed) {
          reveals.push_back(Settle(id, pane, now, Outcome::kDropped));
        } else if (Fits(pane, tab)) {
          reveals.push_back(Settle(id, pane, now, Outcome::kFrame));
        }
      } else if (!pane.pending && pane.target == tab && pane.visible == tab && state.is_dom_only) {
        Reveal reveal = Base(id, pane);
        reveal.action = RevealAction::kHideAllNative;
        reveal.kind = SwitchKind::kDomOnly;
        Hide(reveal, tab, kNoTab);
        pane.visible = kNoTab;
        reveal.visible = kNoTab;
        reveals.push_back(std::move(reveal));
      } else if (!pane.pending && pane.target == tab && pane.visible == kNoTab && !state.is_dom_only) {
        pane.visible = tab;
        Reveal reveal = Base(id, pane);
        reveal.action = RevealAction::kShowTargetNow;
        reveal.kind = SwitchKind::kCold;
        reveals.push_back(std::move(reveal));
      }
    }
  }

  RevealConfig config_;
  bool reduced_motion_ = false;
  bool window_visible_ = true;
  int64_t last_now_ms_ = 0;
  uint64_t next_generation_ = 0;
  SurfaceEpoch next_epoch_ = kNoEpoch;
  std::map<TabId, Surface> tabs_;
  std::map<PaneId, Pane> panes_;
  RevealStats stats_;
};

}

#endif
