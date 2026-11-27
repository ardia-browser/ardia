#ifndef ARDIA_DESKTOP_AC_DESKTOP_LAYOUT_SYNC_H_
#define ARDIA_DESKTOP_AC_DESKTOP_LAYOUT_SYNC_H_

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

namespace ardia::desktop_layout_sync {

inline constexpr double kDefaultSidebarWidth = 190;
inline constexpr double kSidebarMinWidth = 160;
inline constexpr double kSidebarMaxWidth = 400;
inline constexpr double kMinWindowWidth = 500;
inline constexpr double kSidebarPageRoom = kMinWindowWidth - kDefaultSidebarWidth;
inline constexpr double kMinPane = 220;
inline constexpr double kRubberBand = 36;
inline constexpr double kRubberBandScale = 90;
inline constexpr double kMaxExtent = 32768;
inline constexpr double kMinDeviceScale = 0.25;
inline constexpr double kMaxDeviceScale = 8;
inline constexpr size_t kMaxSlots = 8;
inline constexpr int64_t kMaxHoldMicros = 16667;
inline constexpr int64_t kMinHoldMicros = 1000;
inline constexpr int kMissesBeforeStalled = 2;
inline constexpr size_t kMaxSurfaces = 64;

struct Rect {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;

  friend constexpr bool operator==(const Rect&, const Rect&) = default;
};

struct PixelRect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;

  friend constexpr bool operator==(const PixelRect&, const PixelRect&) = default;
};

struct Insets {
  double left = 0;
  double top = 0;
  double right = 0;
  double bottom = 0;
};

enum class SidebarSide { kLeft, kRight };
enum class SplitOrientation { kHorizontal, kVertical };
enum class DragKind { kNone, kSidebar, kSplit };
enum class DividerKind { kRoot, kStack };

struct DividerRef {
  DividerKind kind = DividerKind::kRoot;
  size_t index = 0;

  friend constexpr bool operator==(const DividerRef&, const DividerRef&) = default;
};

struct SplitSlot {
  double size = 1;
  bool stacked = false;
  std::array<double, 2> stack_sizes{0.5, 0.5};

  friend constexpr bool operator==(const SplitSlot&, const SplitSlot&) = default;
};

struct WindowFrame {
  double width = 0;
  double height = 0;
  double device_scale = 1;
};

struct LayoutInput {
  LayoutInput();
  LayoutInput(const LayoutInput&);
  LayoutInput(LayoutInput&&);
  LayoutInput& operator=(const LayoutInput&);
  LayoutInput& operator=(LayoutInput&&);
  ~LayoutInput();

  WindowFrame window;
  SidebarSide side = SidebarSide::kLeft;
  double sidebar_width = kDefaultSidebarWidth;
  bool sidebar_shown = true;
  bool sidebar_live = false;
  double collapse_below = 0;
  Insets card_insets;
  SplitOrientation orientation = SplitOrientation::kHorizontal;
  std::vector<SplitSlot> split_slots;
  double split_gap = 0;
  DividerRef ratio_divider;
};

struct CssVarSnapshot {
  double sidebar_width = 0;
  double split_ratio = 0;
  uint64_t sequence = 0;

  friend constexpr bool operator==(const CssVarSnapshot&, const CssVarSnapshot&) = default;
};

struct PaneLayout {
  size_t slot = 0;
  size_t stack_index = 0;
  Rect rect;
  PixelRect pixels;
};

struct DividerLayout {
  DividerRef ref;
  bool vertical = false;
  Rect rect;
  PixelRect pixels;
};

struct LayoutSnapshot {
  LayoutSnapshot();
  LayoutSnapshot(const LayoutSnapshot&);
  LayoutSnapshot(LayoutSnapshot&&);
  LayoutSnapshot& operator=(const LayoutSnapshot&);
  LayoutSnapshot& operator=(LayoutSnapshot&&);
  ~LayoutSnapshot();

  uint64_t sequence = 0;
  double device_scale = 1;
  double sidebar_width = 0;
  bool sidebar_collapsed = false;
  Rect sidebar;
  PixelRect sidebar_pixels;
  Rect content;
  PixelRect content_pixels;
  std::vector<PaneLayout> panes;
  std::vector<DividerLayout> dividers;
  std::vector<SplitSlot> split_slots;
  std::optional<DividerRef> active_divider;
  std::optional<double> settle_target;
  double split_ratio = 0;
  CssVarSnapshot css;
};

double SidebarWidthLimit(double window_width);
double ShownSidebarWidth(double saved, double window_width);
double RubberBand(double width, double min, double max);
double Unstretch(double width, double min, double max);
double ClampWidth(double width, double min, double max);
double KeptSidebarWidth(double dragged, double limit, double saved);
double SanitizeDeviceScale(double scale);
double SnapToDevice(double dip, double device_scale);
PixelRect ToPixels(const Rect& rect, double device_scale);
bool HasDivider(size_t count, size_t index);
bool HasDivider(const std::vector<SplitSlot>& slots, DividerRef ref);
std::vector<double> NormalizedSizes(const std::vector<double>& sizes);
std::vector<SplitSlot> NormalizedSlots(const std::vector<SplitSlot>& slots);
std::vector<double> ResizePair(const std::vector<double>& sizes, size_t index, double delta, double total, double gap);
std::vector<double> EvenPair(const std::vector<double>& sizes, size_t index);
std::vector<SplitSlot> ResizeSlots(const std::vector<SplitSlot>& slots, DividerRef ref, double delta, double total,
                                   double gap);
std::vector<SplitSlot> EvenSlots(const std::vector<SplitSlot>& slots, DividerRef ref);
std::optional<LayoutSnapshot> ComputeLayout(const LayoutInput& input, uint64_t sequence,
                                            std::optional<DividerRef> active_divider = std::nullopt);

class LayoutDragSession {
 public:
  struct Release {
    double raw = 0;
    double target = 0;
    double kept = 0;
    bool needs_settle = false;
    bool collapsed = false;
  };

  explicit LayoutDragSession(LayoutInput input, uint64_t first_sequence = 0);
  LayoutDragSession(const LayoutDragSession&) = delete;
  LayoutDragSession& operator=(const LayoutDragSession&) = delete;
  ~LayoutDragSession();

  const LayoutSnapshot& Snapshot() const { return snapshot_; }
  const LayoutInput& Input() const { return input_; }
  DragKind Active() const { return drag_.kind; }
  uint64_t Sequence() const { return sequence_; }
  std::optional<double> SettleTarget() const { return drag_.settle_target; }

  bool BeginSidebar(double pointer_x, double pointer_from_edge = 0);
  bool BeginSplit(DividerRef divider, double pointer);
  bool Move(double pointer);
  bool ResizeWindow(double width, double height);
  bool SetDeviceScale(double device_scale);
  std::optional<Release> End(double pointer);
  std::optional<Release> Terminate();
  bool Settle(double width);
  std::optional<Release> FinishSettle();
  bool Cancel();
  bool ResetSplitPair(DividerRef divider);

 private:
  struct Drag {
    DragKind kind = DragKind::kNone;
    double origin = 0;
    double last_pointer = 0;
    double rest = 0;
    double grabbed = 0;
    bool dragged = false;
    std::optional<double> settle_target;
    DividerRef divider;
  };

  bool Apply(const LayoutInput& next, const Drag& drag);
  bool Reapply(LayoutInput next);
  bool FinishOnLastSequence(LayoutInput next, const Drag& drag);
  bool Step(double pointer, LayoutInput& next, Drag& drag) const;
  std::optional<Release> FinishSidebar(const LayoutInput& from, const Drag& drag, bool released);
  std::optional<Release> FinishSplit(const LayoutInput& from);
  double SidebarWidthAt(const Drag& drag, double pointer, double max, bool* dragged) const;
  std::optional<std::vector<SplitSlot>> SlotsAt(const LayoutInput& next, const Drag& drag, double pointer) const;

  LayoutInput input_;
  LayoutInput before_drag_;
  LayoutSnapshot snapshot_;
  uint64_t sequence_ = 0;
  Drag drag_;
  std::vector<SplitSlot> split_start_;
};

struct SurfaceId {
  uint64_t frame_sequence = 0;
  uint64_t surface_generation = 0;

  friend constexpr bool operator==(const SurfaceId&, const SurfaceId&) = default;
};

enum class PresentReason { kIdle, kMatched, kHolding, kDeadline };

struct PresentDecision {
  PresentReason reason = PresentReason::kIdle;
  bool present = true;
  uint64_t frame_sequence = 0;
  int64_t deadline_micros = 0;
  size_t waiting_on = 0;
};

struct SyncCounts {
  uint64_t layouts = 0;
  uint64_t matched = 0;
  uint64_t deadline_fallbacks = 0;
  uint64_t clock_jumps = 0;
  uint64_t stalls = 0;
  uint64_t stale_submissions = 0;
  uint64_t rejected_submissions = 0;
};

struct ChildGeometry {
  uint64_t child_id = 0;
  Rect rect;
};

class SurfaceSyncTracker {
 public:
  explicit SurfaceSyncTracker(int64_t vsync_interval_micros = kMaxHoldMicros);
  SurfaceSyncTracker(const SurfaceSyncTracker&) = delete;
  SurfaceSyncTracker& operator=(const SurfaceSyncTracker&) = delete;
  ~SurfaceSyncTracker();

  void SetVsyncInterval(int64_t micros);
  void SetDeviceScale(double device_scale);
  int64_t HoldBudget() const { return hold_budget_; }
  bool Active() const { return active_; }
  const SyncCounts& Counts() const { return counts_; }

  void Begin();
  void End();
  std::optional<std::vector<SurfaceId>> ExpectLayout(uint64_t frame_sequence, const Rect& shell,
                                                     const std::vector<ChildGeometry>& children, int64_t now_micros);
  bool ShellSubmitted(SurfaceId id);
  bool ChildSubmitted(uint64_t child_id, SurfaceId id);
  bool RemoveChild(uint64_t child_id);
  PresentDecision Decide(int64_t now_micros);
  SurfaceId ExpectedShell() const { return {frame_sequence_, shell_.expected.surface_generation}; }
  std::optional<SurfaceId> Expected(uint64_t child_id) const;
  bool IsStalled(uint64_t child_id) const;

 private:
  struct Surface {
    uint64_t child_id = 0;
    Rect rect;
    bool has_rect = false;
    SurfaceId expected;
    SurfaceId submitted;
    int misses = 0;
    bool stalled = false;
    bool participating = false;
  };

  Surface* Find(uint64_t child_id);
  const Surface* Find(uint64_t child_id) const;
  bool Accept(Surface& surface, SurfaceId id);
  bool ShellCaught() const;
  static bool Caught(const Surface& surface);
  bool ClockWentBack(int64_t now_micros);

  bool active_ = false;
  int64_t hold_budget_ = kMaxHoldMicros;
  double device_scale_ = 1;
  uint64_t frame_sequence_ = 0;
  uint64_t last_generation_ = 0;
  bool pending_ = false;
  int64_t deadline_micros_ = 0;
  bool clock_jump_fallback_ = false;
  bool has_clock_ = false;
  int64_t last_now_micros_ = 0;
  Surface shell_;
  std::vector<Surface> children_;
  SyncCounts counts_;
};

}

#endif
