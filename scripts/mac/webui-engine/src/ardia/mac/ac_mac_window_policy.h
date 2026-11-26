#ifndef ARDIA_MAC_AC_MAC_WINDOW_POLICY_H_
#define ARDIA_MAC_AC_MAC_WINDOW_POLICY_H_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace ardia_mac::window_policy {

inline constexpr double kMinWidth = 720;
inline constexpr double kMinHeight = 460;
inline constexpr double kFrameLimit = 1e5;
inline constexpr std::size_t kWindowIdLimit = 128;
inline constexpr std::size_t kTitleLimit = 1024;
inline constexpr int kQuitDeadlineSeconds = 10;
inline constexpr int kCloseSettleSeconds = 5;
inline constexpr int kDrainDeadlineSeconds = 30;

inline bool ValidWindowId(std::string_view id) {
  if (id.empty() || id.size() > kWindowIdLimit) return false;
  const auto alnum = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'); };
  if (!alnum(id.front())) return false;
  return std::all_of(id.begin(), id.end(), [&](char c) { return alnum(c) || c == '_' || c == '-'; });
}

inline bool ValidGeneration(std::string_view generation) {
  if (generation.empty() || generation.size() > 20 || generation.front() == '0') return false;
  return std::all_of(generation.begin(), generation.end(), [](char c) { return c >= '0' && c <= '9'; });
}

struct CloseIdentity {
  std::string renderer;
  std::string close;
  bool operator==(const CloseIdentity&) const = default;
};

enum class ClosePhase { kIdle, kRequested, kDraining, kAcknowledged, kClosing, kCancelled };

class CloseBook {
 public:
  std::optional<CloseIdentity> Request(std::uint64_t renderer) {
    if (phase_ != ClosePhase::kIdle && phase_ != ClosePhase::kCancelled) {
      return identity_.renderer == std::to_string(renderer) ? std::optional<CloseIdentity>(identity_)
                                                            : std::nullopt;
    }
    if (renderer == 0 || generation_ == std::numeric_limits<std::uint64_t>::max()) return std::nullopt;
    identity_ = {std::to_string(renderer), std::to_string(++generation_)};
    phase_ = ClosePhase::kRequested;
    return identity_;
  }

  bool Matches(const CloseIdentity& identity, std::uint64_t renderer) const {
    return phase_ != ClosePhase::kIdle && phase_ != ClosePhase::kCancelled && identity == identity_ &&
           identity.renderer == std::to_string(renderer);
  }

  bool BeginDrain(const CloseIdentity& identity, std::uint64_t renderer) {
    if (!Matches(identity, renderer)) return false;
    if (phase_ == ClosePhase::kRequested) phase_ = ClosePhase::kDraining;
    return phase_ == ClosePhase::kDraining;
  }

  bool Acknowledge(const CloseIdentity& identity, std::uint64_t renderer, std::optional<double> watermark) {
    if (!Matches(identity, renderer) || phase_ != ClosePhase::kDraining || !watermark) return false;
    if (!std::isfinite(*watermark) || *watermark < 0 || *watermark > 9007199254740991.0 ||
        std::floor(*watermark) != *watermark) {
      return false;
    }
    phase_ = ClosePhase::kAcknowledged;
    return true;
  }

  bool BeginClosing(const CloseIdentity& identity) {
    if (phase_ != ClosePhase::kAcknowledged || identity != identity_) return false;
    phase_ = ClosePhase::kClosing;
    return true;
  }

  bool Cancel(const CloseIdentity& identity) {
    if (identity != identity_ || phase_ == ClosePhase::kIdle) return false;
    if (phase_ == ClosePhase::kCancelled) return true;
    phase_ = ClosePhase::kCancelled;
    return true;
  }

  void Retire() {
    if (phase_ != ClosePhase::kClosing) phase_ = ClosePhase::kIdle;
  }

  bool Open() const { return phase_ != ClosePhase::kIdle && phase_ != ClosePhase::kCancelled; }
  bool Deciding() const { return phase_ == ClosePhase::kRequested; }
  ClosePhase phase() const { return phase_; }
  const CloseIdentity& identity() const { return identity_; }

 private:
  std::uint64_t generation_ = 0;
  CloseIdentity identity_;
  ClosePhase phase_ = ClosePhase::kIdle;
};

enum class CloseRequestPlan { kRequest, kReissue, kAlreadyLeaving };

inline CloseRequestPlan PlanCloseRequest(bool open, ClosePhase phase, std::uint64_t held_quit,
                                         std::uint64_t requested_quit) {
  if (!open || requested_quit == 0 || held_quit == requested_quit) return CloseRequestPlan::kRequest;
  if (held_quit == 0 && (phase == ClosePhase::kAcknowledged || phase == ClosePhase::kClosing)) {
    return CloseRequestPlan::kAlreadyLeaving;
  }
  return CloseRequestPlan::kReissue;
}

struct DownloadAuthorization {
  bool present = false;
  std::set<std::string> ids;
};

inline bool BlocksShutdown(bool transient, bool in_progress, bool dangerous, bool insecure) {
  return !transient && in_progress && !dangerous && !insecure;
}

struct DownloadAsker {
  std::string window;
  std::string renderer;
  bool operator==(const DownloadAsker&) const = default;
};

class DownloadPermission {
 public:
  void Shown(DownloadAsker asker, std::set<std::string> ids) {
    asker_ = std::move(asker);
    shown_ = DownloadAuthorization{true, std::move(ids)};
    prompt_.clear();
  }

  void Opened(const DownloadAsker& asker, const std::string& dialog_id) {
    if (shown_ && asker_ == asker && prompt_.empty() && !dialog_id.empty()) prompt_ = dialog_id;
  }

  void Declined(const DownloadAsker& asker, const std::string& dialog_id) {
    if (shown_ && asker_ == asker && !prompt_.empty() && prompt_ == dialog_id) {
      shown_.reset();
      prompt_.clear();
    }
  }

  DownloadAuthorization Take(const DownloadAsker& asker) {
    std::optional<DownloadAuthorization> shown = std::move(shown_);
    shown_.reset();
    prompt_.clear();
    if (!shown || asker_ != asker) return {};
    return std::move(*shown);
  }

  bool pending() const { return shown_.has_value(); }

 private:
  DownloadAsker asker_;
  std::optional<DownloadAuthorization> shown_;
  std::string prompt_;
};

inline std::set<std::string> DownloadsToCancel(bool shell_confirmed,
                                               bool unload_handlers_pending,
                                               const DownloadAuthorization& authorized,
                                               const std::set<std::string>& active) {
  std::set<std::string> cancel;
  if (!shell_confirmed || unload_handlers_pending || !authorized.present) return cancel;
  for (const std::string& id : active) {
    if (authorized.ids.contains(id)) cancel.insert(id);
  }
  return cancel;
}

inline bool ValidDeparture(bool present, bool is_dict, std::size_t size, bool has_base, bool has_session) {
  if (!present) return true;
  return is_dict && size == 2 && has_base && has_session;
}

inline bool ValidAcknowledgeShape(std::size_t size, bool has_departure) {
  return size == (has_departure ? 5u : 4u);
}

enum class QuitStep { kWait, kExit, kAbort, kStale };

class QuitBarrier {
 public:
  std::uint64_t Begin(const std::vector<std::string>& windows) {
    if (running_ || generation_ == std::numeric_limits<std::uint64_t>::max()) return 0;
    running_ = true;
    pending_ = std::set<std::string>(windows.begin(), windows.end());
    return ++generation_;
  }

  QuitStep Acknowledged(const std::string& window, std::uint64_t generation) {
    if (!Current(generation)) return QuitStep::kStale;
    pending_.erase(window);
    if (!pending_.empty()) return QuitStep::kWait;
    running_ = false;
    return QuitStep::kExit;
  }

  QuitStep Rejected(const std::string& window, std::uint64_t generation) {
    if (!Current(generation)) return QuitStep::kStale;
    if (!pending_.contains(window)) return QuitStep::kWait;
    running_ = false;
    pending_.clear();
    return QuitStep::kAbort;
  }

  QuitStep Expired(std::uint64_t generation) {
    if (!Current(generation)) return QuitStep::kStale;
    running_ = false;
    pending_.clear();
    return QuitStep::kExit;
  }

  bool Current(std::uint64_t generation) const { return running_ && generation != 0 && generation == generation_; }
  bool Waits(const std::string& window) const { return running_ && pending_.contains(window); }
  bool running() const { return running_; }
  std::uint64_t generation() const { return generation_; }

 private:
  bool running_ = false;
  std::uint64_t generation_ = 0;
  std::set<std::string> pending_;
};

struct WindowState {
  bool maximized = false;
  bool tiled = false;
  bool full_screen = false;
  bool operator==(const WindowState&) const = default;
};

inline WindowState StateOf(bool zoomed, bool full_screen, bool miniaturized) {
  return WindowState{zoomed && !full_screen && !miniaturized, false, full_screen};
}

struct Frame {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
  bool operator==(const Frame&) const = default;
};

inline std::optional<Frame> FrameFrom(std::optional<double> x,
                                      std::optional<double> y,
                                      std::optional<double> width,
                                      std::optional<double> height) {
  if (!x || !y || !width || !height) return std::nullopt;
  for (double value : {*x, *y, *width, *height}) {
    if (!std::isfinite(value) || std::abs(value) > kFrameLimit) return std::nullopt;
  }
  if (*width <= 0 || *height <= 0) return std::nullopt;
  return Frame{std::round(*x), std::round(*y), std::max(kMinWidth, std::round(*width)),
               std::max(kMinHeight, std::round(*height))};
}

inline bool Intersects(const Frame& a, const Frame& b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

inline bool OnAnyScreen(const Frame& frame, const std::vector<Frame>& screens) {
  return std::any_of(screens.begin(), screens.end(), [&](const Frame& screen) { return Intersects(frame, screen); });
}

inline std::optional<std::string> WindowTitle(std::string_view title) {
  if (title.size() > kTitleLimit) return std::nullopt;
  std::string shown;
  shown.reserve(title.size());
  for (char c : title) {
    const auto byte = static_cast<unsigned char>(c);
    shown.push_back(byte < 0x20 || byte == 0x7f ? ' ' : c);
  }
  return shown;
}

enum class Appearance { kAuto, kLight, kDark };

inline std::optional<Appearance> AppearanceNamed(std::string_view name) {
  if (name == "auto") return Appearance::kAuto;
  if (name == "light") return Appearance::kLight;
  if (name == "dark") return Appearance::kDark;
  return std::nullopt;
}

enum class Side { kLeft, kRight };

struct EdgeReport {
  bool over = false;
  double x = -1;
  double y = -1;
  bool operator==(const EdgeReport&) const = default;
};

inline bool PollsOutside(bool over, double x, double y, double width, double height) {
  if (!over) return false;
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height)) return false;
  return x < 0 || y < 0 || x >= width || y >= height;
}

class EdgeWatch {
 public:
  static constexpr double kStrip = 8;
  static constexpr double kReach = 24;
  static constexpr double kHoldLimit = 4096;

  std::optional<EdgeReport> Watch(double hold, Side side, bool while_pressed) {
    hold_ = std::isfinite(hold) ? std::clamp(hold, 0.0, kHoldLimit) : 0;
    side_ = side;
    while_pressed_ = while_pressed;
    watching_ = true;
    fresh_ = true;
    return Report(known_ && Within());
  }

  void Stop() {
    watching_ = false;
    over_ = false;
  }

  std::optional<EdgeReport> Moved(double x, double y, double width, double height, bool pressed) {
    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height) || width <= 0 ||
        height <= 0) {
      return std::nullopt;
    }
    x_ = x;
    y_ = y;
    width_ = width;
    height_ = height;
    pressed_ = pressed;
    known_ = true;
    return Report(Within());
  }

  void Place(double x, double y, double width, double height, bool pressed) {
    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height) || width <= 0 ||
        height <= 0) {
      known_ = false;
      return;
    }
    x_ = x;
    y_ = y;
    width_ = width;
    height_ = height;
    pressed_ = pressed;
    known_ = true;
  }

  void Forget() { known_ = false; }

  std::optional<EdgeReport> Resigned() {
    known_ = false;
    return Report(false);
  }

  std::optional<EdgeReport> Covered() {
    known_ = false;
    return Report(false);
  }

  bool watching() const { return watching_; }
  bool over() const { return watching_ && over_; }

 private:
  bool Within() const {
    if (pressed_ && !while_pressed_) return false;
    const double inset = side_ == Side::kRight ? width_ - 1 - x_ : x_;
    return y_ >= 0 && y_ < height_ && inset >= -kReach && inset < std::max(hold_, kStrip);
  }

  std::optional<EdgeReport> Report(bool over) {
    if (!watching_ || (!fresh_ && over == over_)) return std::nullopt;
    fresh_ = false;
    over_ = over;
    if (!known_) return EdgeReport{over, -1, -1};
    return EdgeReport{over, x_, y_};
  }

  Side side_ = Side::kLeft;
  bool watching_ = false;
  bool fresh_ = false;
  bool over_ = false;
  bool known_ = false;
  bool pressed_ = false;
  bool while_pressed_ = false;
  double hold_ = 0;
  double x_ = -1;
  double y_ = -1;
  double width_ = 0;
  double height_ = 0;
};

}

#endif
