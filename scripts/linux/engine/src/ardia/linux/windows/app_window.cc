// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/windows/app_window.h"

#include <algorithm>
#include <cmath>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/app_lifetime.h"
#include "ardia/linux/host/host.h"
#include "ardia/linux/host/key_map.h"
#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/focus_return.h"
#include "base/base64.h"
#include "chrome/browser/devtools/devtools_contents_resizing_strategy.h"
#include "chrome/browser/devtools/devtools_window.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted_memory.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "components/input/native_web_keyboard_event.h"
#include "content/public/browser/keyboard_event_processing_result.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/mojom/page/draggable_region.mojom.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/aura/window.h"
#include "ui/base/hit_test.h"
#include "ui/compositor/compositor.h"
#include "ui/compositor/layer.h"
#include "ui/gfx/geometry/transform.h"
#include "ui/display/screen.h"
#include "ui/events/event.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/snapshot/snapshot.h"
#include "ui/views/controls/native/native_view_host.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/view_targeter.h"
#include "ui/views/window/frame_view.h"
#include "third_party/skia/include/core/SkPath.h"
#include "third_party/skia/include/core/SkRRect.h"
#include "third_party/skia/include/pathops/SkPathOps.h"

namespace ardia_linux {

namespace {

constexpr int kFrameCornerRadius = 12;
constexpr int kResizeBorder = 5;
constexpr int kResizeCorner = 16;
constexpr base::TimeDelta kFrameSettle = base::Milliseconds(120);
constexpr base::TimeDelta kFadeStep = base::Milliseconds(16);
constexpr base::TimeDelta kBrowserFade = base::Milliseconds(250);
constexpr base::TimeDelta kSmallFade = base::Milliseconds(200);
constexpr int kMotionDelayMs = 0;

gfx::RectF MotionRectAt(const PageMotion& motion, base::TimeDelta elapsed) {
  const double progress =
      std::clamp(elapsed / motion.duration, 0.0, 1.0) *
      (motion.rects.size() - 1);
  const size_t index =
      std::min(static_cast<size_t>(progress), motion.rects.size() - 2);
  const float fraction = static_cast<float>(progress - index);
  const gfx::RectF& from = motion.rects[index];
  const gfx::RectF& to = motion.rects[index + 1];
  return gfx::RectF(from.x() + (to.x() - from.x()) * fraction,
                    from.y() + (to.y() - from.y()) * fraction,
                    from.width() + (to.width() - from.width()) * fraction,
                    from.height() + (to.height() - from.height()) * fraction);
}

base::TimeDelta MotionDelay() {
  int delay = kMotionDelayMs;
  if (std::optional<std::string> value = ardiacore::TestValue("motionDelayMs")) {
    base::StringToInt(*value, &delay);
  }
  return base::Milliseconds(std::clamp(delay, -100, 100));
}

std::unique_ptr<views::Widget::ShapeRects> RoundedShape(const gfx::Size& size,
                                                        int radius) {
  auto rects = std::make_unique<views::Widget::ShapeRects>();
  const int r = std::min({radius, size.width() / 2, size.height() / 2});
  for (int row = 0; row < r; ++row) {
    const double dy = r - row - 0.5;
    const int inset =
        r - static_cast<int>(std::floor(std::sqrt(r * r - dy * dy)));
    rects->emplace_back(inset, row, size.width() - 2 * inset, 1);
    rects->emplace_back(inset, size.height() - row - 1,
                        size.width() - 2 * inset, 1);
  }
  rects->emplace_back(0, r, size.width(), std::max(0, size.height() - 2 * r));
  return rects;
}

}

class AppWindow::Frame : public views::FrameView {
 public:
  explicit Frame(AppWindow* window) : window_(window) {}

  gfx::Rect GetBoundsForClientView() const override { return bounds(); }

  gfx::Rect GetWindowBoundsForClientBounds(
      const gfx::Rect& client_bounds) const override {
    return client_bounds;
  }

  int NonClientHitTest(const gfx::Point& point) override {
    views::Widget* widget = window_->widget();
    if (!widget || !bounds().Contains(point)) {
      return HTNOWHERE;
    }
    if (widget->IsFullscreen()) {
      return HTCLIENT;
    }
    if (window_->shape_.resizable && !widget->IsMaximized()) {
      const int edge =
          GetHTComponentForFrame(point, gfx::Insets(kResizeBorder),
                                 kResizeCorner, kResizeCorner, true);
      if (edge != HTNOWHERE) {
        return edge;
      }
    }
    if (window_->draggable_region().contains(point.x(), point.y()) &&
        window_->input_region().PageAt(point).empty()) {
      return HTCAPTION;
    }
    return HTCLIENT;
  }

 private:
  raw_ptr<AppWindow> window_;
};

PageMotion::PageMotion() = default;
PageMotion::PageMotion(const PageMotion&) = default;
PageMotion& PageMotion::operator=(const PageMotion&) = default;
PageMotion::~PageMotion() = default;

AppWindowView::AppWindowView(AppWindow* window)
    : window_(window), motion_delay_(MotionDelay()) {
  ui_view_ = AddChildView(std::make_unique<views::WebView>(nullptr));
  SetEventTargeter(std::make_unique<views::ViewTargeter>(this));
}

void AppWindowView::ShowContextMenuForViewImpl(
    views::View* source,
    const gfx::Point& point,
    ui::mojom::MenuSourceType source_type) {
  gfx::Point local = point;
  views::View::ConvertPointFromScreen(this, &local);
  if (!window_->draggable_region().contains(local.x(), local.y())) {
    return;
  }
  base::DictValue payload;
  payload.Set("id", window_->id());
  payload.Set("x", local.x());
  payload.Set("y", local.y());
  CountLinux("windowMenusFromTopBar");
  AppWindows::Get().Emit("onSystemContextMenu", std::move(payload));
}

AppWindowView::~AppWindowView() {
  StopStepping();
}

views::WebView* AppWindowView::PageView(const std::string& key) const {
  auto found = pages_.find(key);
  return found == pages_.end() ? nullptr : found->second.get();
}

views::WebView* AppWindowView::AddPage(const std::string& key,
                                       content::WebContents* contents,
                                       bool above_ui) {
  if (views::WebView* existing = PageView(key)) {
    if (existing->web_contents() != contents) {
      existing->SetWebContents(contents);
    }
    return existing;
  }
  const std::optional<size_t> ui_index = GetIndexOf(ui_view_);
  views::WebView* page =
      PagesUnderUi() && !above_ui
          ? AddChildViewAt(std::make_unique<views::WebView>(nullptr),
                           ui_index.value_or(0))
          : AddChildView(std::make_unique<views::WebView>(nullptr));
  page->SetVisible(false);
  page->SetWebContents(contents);
  pages_[key] = page;
  if (above_ui) {
    above_ui_.insert(key);
  }
  return page;
}

bool AppWindowView::PagesUnderUi() {
  return !ardiacore::TestFlag("pagesAboveUi");
}

AppWindowView::Placement::Placement() = default;
AppWindowView::Placement::Placement(const Placement&) = default;
AppWindowView::Placement& AppWindowView::Placement::operator=(
    const Placement&) = default;
AppWindowView::Placement::~Placement() = default;

void AppWindowView::PlacePage(const std::string& key,
                              const gfx::Rect& bounds,
                              int radius,
                              const std::vector<RoundedArea>& holes,
                              const PageMotion* motion) {
  Placement& placement = placements_[key];
  placement.bounds = bounds;
  placement.radius = radius;
  placement.holes = holes;
  RelayoutPage(key);
  if (motion && motion->rects.size() >= 2 && motion->duration.is_positive() &&
      !DevToolsView(key)) {
    StartMotion(key, *motion);
  } else {
    EndMotion(key);
  }
}

aura::Window* AppWindowView::PageNativeView(const std::string& key) const {
  views::WebView* page = PageView(key);
  return page ? page->holder()->native_view() : nullptr;
}

void AppWindowView::ShowMotionAt(const std::string& key,
                                 const gfx::RectF& rect) {
  aura::Window* native = PageNativeView(key);
  auto placed = placements_.find(key);
  if (!native || placed == placements_.end() ||
      placed->second.bounds.IsEmpty()) {
    return;
  }
  const gfx::Rect& final_rect = placed->second.bounds;
  gfx::Transform transform;
  transform.Translate(rect.x() - final_rect.x(), rect.y() - final_rect.y());
  transform.Scale(rect.width() / final_rect.width(),
                  rect.height() / final_rect.height());
  native->SetTransform(transform);
}

void AppWindowView::StartMotion(const std::string& key,
                                const PageMotion& motion) {
  ui::Compositor* compositor =
      GetWidget() && GetWidget()->IsVisible() ? GetWidget()->GetCompositor()
                                              : nullptr;
  if (!compositor) {
    EndMotion(key);
    return;
  }
  RunningMotion& running = motions_[key];
  running.motion = motion;
  running.start = base::TimeTicks::Now() - motion.elapsed + motion_delay_;
  if (views::Widget* widget = GetWidget()) {
    widget->LayoutRootViewIfNecessary();
  }
  ShowMotionAt(key, MotionRectAt(motion, motion.elapsed));
  if (!stepping_) {
    stepping_ = compositor;
    compositor->AddAnimationObserver(this);
  }
}

void AppWindowView::EndMotion(const std::string& key) {
  if (motions_.erase(key) == 0) {
    return;
  }
  if (aura::Window* native = PageNativeView(key)) {
    native->SetTransform(gfx::Transform());
  }
  if (motions_.empty()) {
    StopStepping();
  }
}

void AppWindowView::OnAnimationStep(base::TimeTicks timestamp) {
  std::vector<std::string> ended;
  for (auto& [key, running] : motions_) {
    const PageMotion& motion = running.motion;
    const base::TimeDelta elapsed =
        std::max(timestamp - running.start, motion.elapsed);
    if (elapsed >= motion.duration) {
      ended.push_back(key);
      continue;
    }
    ShowMotionAt(key, MotionRectAt(motion, elapsed));
  }
  for (const std::string& key : ended) {
    EndMotion(key);
  }
}

void AppWindowView::OnCompositingShuttingDown(ui::Compositor* compositor) {
  stepping_ = nullptr;
  std::vector<std::string> keys;
  for (const auto& [key, running] : motions_) {
    keys.push_back(key);
  }
  for (const std::string& key : keys) {
    EndMotion(key);
  }
}

void AppWindowView::StopStepping() {
  if (stepping_) {
    stepping_->RemoveAnimationObserver(this);
    stepping_ = nullptr;
  }
}

void AppWindowView::RelayoutPage(const std::string& key) {
  views::WebView* page = PageView(key);
  auto placed = placements_.find(key);
  if (!page || placed == placements_.end()) {
    return;
  }
  const Placement& placement = placed->second;
  const bool clipped = !PagesUnderUi() || above_ui_.contains(key);
  gfx::Rect page_bounds = placement.bounds;
  views::WebView* devtools = DevToolsView(key);
  DevToolsContentsResizingStrategy strategy;
  content::WebContents* docked =
      page->web_contents()
          ? DevToolsWindow::GetInTabWebContents(page->web_contents(),
                                                &strategy)
          : nullptr;
  if (devtools && docked && devtools->web_contents() == docked) {
    gfx::Rect devtools_bounds;
    gfx::Rect inspected_bounds;
    ApplyDevToolsContentsResizingStrategy(
        strategy, gfx::Rect(placement.bounds.size()), &devtools_bounds,
        &inspected_bounds);
    devtools_bounds.Offset(placement.bounds.OffsetFromOrigin());
    inspected_bounds.Offset(placement.bounds.OffsetFromOrigin());
    devtools->SetBoundsRect(devtools_bounds);
    devtools->SetVisible(true);
    Shape(devtools, devtools_bounds, placement, clipped);
    page_bounds = inspected_bounds;
  } else if (devtools) {
    devtools->SetVisible(false);
  }
  page->SetBoundsRect(page_bounds);
  page->SetVisible(true);
  Shape(page, page_bounds, placement, clipped);
}

void AppWindowView::Shape(views::WebView* view,
                          const gfx::Rect& view_bounds,
                          const Placement& placement,
                          bool clipped) {
  const float corner = static_cast<float>(std::max(0, placement.radius));
  view->holder()->SetNativeViewCornerRadii(gfx::RoundedCornersF(corner));
  if (!clipped) {
    return;
  }
  SkPath shape = SkPath::RRect(
      SkRect::MakeWH(view_bounds.width(), view_bounds.height()), corner,
      corner);
  for (const RoundedArea& hole : placement.holes) {
    const gfx::RectF cut =
        hole.rect - gfx::Vector2dF(view_bounds.x(), view_bounds.y());
    const SkPath hole_path = SkPath::RRect(
        SkRect::MakeXYWH(cut.x(), cut.y(), cut.width(), cut.height()),
        hole.radius, hole.radius);
    if (std::optional<SkPath> cut_shape =
            Op(shape, hole_path, kDifference_SkPathOp)) {
      shape = std::move(*cut_shape);
    }
  }
  view->holder()->SetClipPath(shape);
}

views::WebView* AppWindowView::DevToolsView(const std::string& key) const {
  auto found = devtools_.find(key);
  return found == devtools_.end() ? nullptr : found->second.get();
}

void AppWindowView::SetDevTools(const std::string& key,
                                content::WebContents* devtools) {
  views::WebView* page = PageView(key);
  views::WebView* view = DevToolsView(key);
  if (!page || !devtools) {
    if (view) {
      devtools_.erase(key);
      view->SetWebContents(nullptr);
      RemoveChildViewT(view);
    }
    RelayoutPage(key);
    return;
  }
  if (!view) {
    const std::optional<size_t> page_index = GetIndexOf(page);
    view = AddChildViewAt(std::make_unique<views::WebView>(nullptr),
                          page_index.value_or(0));
    view->SetVisible(false);
    devtools_[key] = view;
  }
  if (view->web_contents() != devtools) {
    view->SetWebContents(devtools);
  }
  RelayoutPage(key);
}

void AppWindowView::RemovePage(const std::string& key) {
  EndMotion(key);
  SetDevTools(key, nullptr);
  placements_.erase(key);
  above_ui_.erase(key);
  auto found = pages_.find(key);
  if (found == pages_.end()) {
    return;
  }
  views::WebView* page = found->second;
  pages_.erase(found);
  page->SetWebContents(nullptr);
  RemoveChildViewT(page);
}

std::vector<std::string> AppWindowView::PageKeys() const {
  std::vector<std::string> keys;
  for (const auto& [key, view] : pages_) {
    keys.push_back(key);
  }
  return keys;
}

gfx::Size AppWindowView::GetMinimumSize() const {
  return minimum_size_;
}

void AppWindowView::OnBoundsChanged(const gfx::Rect& previous_bounds) {
  ui_view_->SetBoundsRect(GetLocalBounds());
}

views::View* AppWindowView::TargetForRect(views::View* root,
                                          const gfx::Rect& rect) {
  const std::string key =
      window_->input_region().PageAt(rect.CenterPoint());
  views::WebView* page = key.empty() ? nullptr : PageView(key);
  views::WebView* devtools = key.empty() ? nullptr : DevToolsView(key);
  if (devtools && devtools->GetVisible() &&
      devtools->bounds().Contains(rect.CenterPoint()) &&
      !(page && page->GetVisible() &&
        page->bounds().Contains(rect.CenterPoint()))) {
    return devtools->holder();
  }
  views::WebView* target = page && page->GetVisible() ? page : ui_view_.get();
  return target->holder();
}

AppWindow::AppWindow(std::string id,
                     WindowShape shape,
                     std::unique_ptr<content::WebContents> ui)
    : id_(std::move(id)),
      shape_(std::move(shape)),
      ui_(std::move(ui)) {
  SetCanResize(shape_.resizable);
  SetCanMaximize(shape_.maximizable);
  SetCanMinimize(true);
  SetCanFullscreen(shape_.fullscreenable);
  views::WidgetDelegate::SetTitle(base::UTF8ToUTF16(shape_.title));
  view_ = SetContentsView(std::make_unique<AppWindowView>(this));
  view_->set_minimum_size(shape_.minimum_size);

  ui_->SetDelegate(this);
  content::WebContentsObserver::Observe(ui_.get());
  ui_->SetSupportsDraggableRegions(true);

  widget_ = std::make_unique<views::Widget>();
  views::Widget::InitParams params(
      views::Widget::InitParams::CLIENT_OWNS_WIDGET,
      views::Widget::InitParams::TYPE_WINDOW);
  params.delegate = this;
  params.bounds = shape_.bounds;
  params.remove_standard_frame = true;
  params.opacity = views::Widget::InitParams::WindowOpacity::kTranslucent;
  params.name = "ArdiaAppWindow";
  params.wm_class_name = "ardia";
  params.wm_class_class = "Ardia";
  params.wm_role_name = "ardia";
  params.wayland_app_id = "ardia";
  widget_->Init(std::move(params));
  widget_observation_.Observe(widget_.get());
  widget_->GetNativeWindow()->AddPreTargetHandler(this);
  widget_->GetContentsView()->set_context_menu_controller(view_);
  view_->ui_view()->SetWebContents(ui_.get());
  MakeTransparent();
  ApplyShape();
}

AppWindow::~AppWindow() {
  widget_observation_.Reset();
  if (view_ && view_->ui_view()) {
    view_->ui_view()->SetWebContents(nullptr);
  }
  view_ = nullptr;
  widget_.reset();
  content::WebContentsObserver::Observe(nullptr);
  if (ui_) {
    ui_->SetDelegate(nullptr);
  }
  ui_.reset();
}

void AppWindow::MakeTransparent() {
  if (!ui_) {
    return;
  }
  ui_->SetPageBaseBackgroundColor(SK_ColorTRANSPARENT);
  if (content::RenderWidgetHostView* rwhv = ui_->GetRenderWidgetHostView()) {
    rwhv->SetBackgroundColor(SK_ColorTRANSPARENT);
  }
  if (aura::Window* native = ui_->GetNativeView()) {
    native->layer()->SetFillsBoundsOpaquely(false);
  }
}

void AppWindow::RenderViewReady() {
  MakeTransparent();
}

void AppWindow::RenderFrameHostChanged(content::RenderFrameHost* old_host,
                                       content::RenderFrameHost* new_host) {
  MakeTransparent();
}

void AppWindow::PrimaryMainDocumentElementAvailable() {
  MakeTransparent();
}

void AppWindow::ApplyShape() {
  if (!widget_ || views::Widget::IsWindowCompositingSupported()) {
    return;
  }
  if (widget_->IsMaximized() || widget_->IsFullscreen()) {
    widget_->SetShape(nullptr);
    return;
  }
  widget_->SetShape(RoundedShape(widget_->GetWindowBoundsInScreen().size(),
                                 kFrameCornerRadius));
}

void AppWindow::Show() {
  if (!widget_ || closing_ || shown_) {
    return;
  }
  shown_ = true;
  const bool fade = shape_.animated || !is_browser_kind();
  if (fade) {
    fade_length_ =
        shape_.kind == WindowKind::kSmall ? kSmallFade : kBrowserFade;
    fade_started_ = base::TimeTicks::Now();
    widget_->SetOpacity(0);
  }
  AppWindow* newer = AppWindows::Get().AnotherJustAppeared(this);
  const bool behind = newer != nullptr;
  const bool inactive =
      !shape_.focus || ardiacore::BackgroundInstance() || behind;
  Note("windows", "show " + id_ +
                      (behind ? " behind the window that just appeared"
                              : inactive ? " inactive" : " active"));
  if (inactive) {
    widget_->ShowInactive();
    if (behind && newer->widget()) {
      newer->widget()->StackAtTop();
    } else {
      widget_->StackAtTop();
    }
  } else {
    widget_->Show();
    widget_->Activate();
  }
  CountLinux(behind ? "windowShowsBehindNewWindow" : "windowShows");
  if (!behind) {
    AppWindows::Get().NoteAppeared(this);
  }
  if (fade) {
    fade_timer_.Start(FROM_HERE, kFadeStep,
                      base::BindRepeating(&AppWindow::StepFade,
                                          base::Unretained(this)));
  }
  EmitFrameSoon();
}

void AppWindow::StepFade() {
  if (!widget_) {
    fade_timer_.Stop();
    return;
  }
  const double progress = std::clamp(
      (base::TimeTicks::Now() - fade_started_) / fade_length_, 0.0, 1.0);
  widget_->SetOpacity(static_cast<float>(progress));
  if (progress >= 1) {
    fade_timer_.Stop();
  }
}

void AppWindow::CloseByApp() {
  if (!widget_ || closing_) {
    return;
  }
  closed_by_app_ = true;
  widget_->CloseWithReason(views::Widget::ClosedReason::kUnspecified);
}

void AppWindow::Focus() {
  if (!widget_ || closing_) {
    return;
  }
  Note("windows", "focus " + id_);
  if (widget_->IsMinimized()) {
    widget_->Restore();
  }
  if (!widget_->IsVisible()) {
    widget_->Show();
  }
  if (!ardiacore::BackgroundInstance()) {
    widget_->Activate();
  }
}

void AppWindow::Minimize() {
  if (widget_ && !closing_) {
    widget_->Minimize();
  }
}

void AppWindow::ToggleMaximize() {
  if (!widget_ || closing_ || !shape_.maximizable) {
    return;
  }
  if (widget_->IsMaximized()) {
    widget_->Restore();
  } else {
    widget_->Maximize();
  }
}

void AppWindow::SetPageFullscreen(bool on) {
  if (widget_ && !closing_ && widget_->IsFullscreen() != on) {
    if (on) {
      CountLinux("windowFullScreens");
    }
    page_made_fullscreen_ = on;
    widget_->SetFullscreen(on);
  }
}

void AppWindow::LeavePageFullscreen() {
  if (widget_ && !closing_ && page_made_fullscreen_ &&
      widget_->IsFullscreen()) {
    CountLinux("pageFullScreenExits");
    page_made_fullscreen_ = false;
    widget_->SetFullscreen(false);
  }
}

void AppWindow::SetTitle(const std::string& title) {
  views::WidgetDelegate::SetTitle(
      base::UTF8ToUTF16(title.empty() ? std::string("Ardia") : title));
}

void AppWindow::BeginDrag() {
  if (!widget_ || closing_ || widget_->IsFullscreen()) {
    return;
  }
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<AppWindow> window) {
                       if (!window || !window->widget_ || window->closing_) {
                         return;
                       }
                       const gfx::Point cursor =
                           display::Screen::Get()->GetCursorScreenPoint();
                       const gfx::Rect bounds =
                           window->widget_->GetWindowBoundsInScreen();
                       window->widget_->RunMoveLoop(
                           cursor - bounds.origin(),
                           views::Widget::MoveLoopSource::kMouse,
                           views::Widget::MoveLoopEscapeBehavior::kDontHide);
                     },
                     weak_factory_.GetWeakPtr()));
}

gfx::Rect AppWindow::Bounds() const {
  return widget_ ? widget_->GetWindowBoundsInScreen() : gfx::Rect();
}

int AppWindow::FrameCornerRadius() const {
  return widget_ && (widget_->IsMaximized() || widget_->IsFullscreen())
             ? 0
             : kFrameCornerRadius;
}

bool AppWindow::TakeKeyboardFromPage() {
  if (!widget_ || closing_ || !ui_) {
    return false;
  }
  AppWindow* active = nullptr;
  for (const std::string& id : AppWindows::Get().Ids()) {
    AppWindow* window = AppWindows::Get().Find(id);
    if (window && window->KeyboardIsHere()) {
      active = window;
    }
  }
  if (active && active != this) {
    return false;
  }
  ui_->Focus();
  return true;
}

bool AppWindow::KeyboardIsHere() const {
  return widget_ && !closing_ && widget_->IsActive();
}

base::DictValue AppWindow::DebugState() const {
  base::DictValue state;
  if (!widget_) {
    return state;
  }
  state.Set("visible", widget_->IsVisible());
  state.Set("minimized", widget_->IsMinimized());
  state.Set("maximized", widget_->IsMaximized());
  state.Set("fullScreen", widget_->IsFullscreen());
  state.Set("focused", widget_->IsActive());
  state.Set("frame", AppWindows::FrameOf(Bounds()));
  const gfx::Rect bounds = Bounds();
  base::DictValue rect;
  rect.Set("x", bounds.x());
  rect.Set("y", bounds.y());
  rect.Set("width", bounds.width());
  rect.Set("height", bounds.height());
  state.Set("bounds", std::move(rect));
  state.Set("compositing", views::Widget::IsWindowCompositingSupported());
  base::ListValue pages;
  for (const std::string& key : view_->PageKeys()) {
    pages.Append(key);
  }
  state.Set("pages", std::move(pages));
  return state;
}

void AppWindow::Snapshot(base::OnceCallback<void(base::Value)> done) {
  if (!widget_ || closing_ || !widget_->IsVisible()) {
    std::move(done).Run(base::Value());
    return;
  }
  const gfx::Size size = widget_->GetWindowBoundsInScreen().size();
  ui::GrabWindowSnapshotAsPNG(
      widget_->GetNativeWindow(), gfx::Rect(size),
      base::BindOnce(
          [](gfx::Size size, base::OnceCallback<void(base::Value)> done,
             scoped_refptr<base::RefCountedMemory> png) {
            if (!png || png->size() == 0) {
              std::move(done).Run(base::Value());
              return;
            }
            base::DictValue picture;
            picture.Set("url", "data:image/png;base64," +
                                   base::Base64Encode(base::span(*png)));
            picture.Set("width", size.width());
            picture.Set("height", size.height());
            std::move(done).Run(base::Value(std::move(picture)));
          },
          size, std::move(done)));
}

bool AppWindow::ShouldDescendIntoChildForEventHandling(
    gfx::NativeView child,
    const gfx::Point& location) {
  if (!view_ || closing_) {
    return true;
  }
  const std::string page = input_region_.PageAt(location);
  if (ui_ && child == ui_->GetNativeView()) {
    return page.empty();
  }
  for (const std::string& key : view_->PageKeys()) {
    views::WebView* view = view_->PageView(key);
    content::WebContents* contents = view ? view->web_contents() : nullptr;
    if (contents && child == contents->GetNativeView()) {
      return page == key;
    }
  }
  return true;
}

std::unique_ptr<views::FrameView> AppWindow::CreateFrameView(
    views::Widget* widget) {
  return std::make_unique<Frame>(this);
}

bool AppWindow::OnCloseRequested(views::Widget::ClosedReason reason) {
  if (closed_by_app_ || AppLifetime::Get().quitting() ||
      AppLifetime::Get().finished() || !is_browser_kind()) {
    return true;
  }
  AppWindows::Get().WindowEvent("closeRequest", id_);
  return false;
}

void AppWindow::OnWidgetActivationChanged(views::Widget* widget, bool active) {
  if (active) {
    Note("windows", "activated " + id_);
    AppWindows::Get().WindowActivated(this);
    Host::Get()->WindowActivated(id_);
  }
}

void AppWindow::OnWidgetBoundsChanged(views::Widget* widget,
                                      const gfx::Rect& new_bounds) {
  ApplyShape();
  EmitFrameSoon();
  Host::Get()->WindowMoved(id_);
  OnWidgetShowStateChanged(widget);
}

void AppWindow::OnWidgetShowStateChanged(views::Widget* widget) {
  ApplyShape();
  const bool maximized = widget->IsMaximized();
  if (maximized != maximized_) {
    maximized_ = maximized;
    base::DictValue extra;
    extra.Set("on", maximized);
    AppWindows::Get().WindowEvent("maximized", id_, std::move(extra));
  }
  const bool fullscreen = widget->IsFullscreen();
  if (fullscreen != fullscreen_) {
    fullscreen_ = fullscreen;
    if (!fullscreen) {
      page_made_fullscreen_ = false;
    }
    Host::Get()->WindowFullscreenChanged(id_);
    base::DictValue extra;
    extra.Set("on", fullscreen);
    AppWindows::Get().WindowEvent("fullScreen", id_, std::move(extra));
  }
}

void AppWindow::OnWidgetDestroying(views::Widget* widget) {
  if (closing_) {
    return;
  }
  const bool was_active = widget->IsActive();
  closing_ = true;
  fade_timer_.Stop();
  frame_timer_.Stop();
  if (aura::Window* native = widget->GetNativeWindow()) {
    native->RemovePreTargetHandler(this);
  }
  Host::Get()->WindowClosing(id_);
  if (view_ && view_->ui_view()) {
    view_->ui_view()->SetWebContents(nullptr);
  }
  view_ = nullptr;
  AppWindows::Get().WindowClosed(this);
  if (was_active) {
    ReturnFocusSoon();
  }
}

void AppWindow::EmitFrameSoon() {
  frame_timer_.Start(FROM_HERE, kFrameSettle,
                     base::BindOnce(&AppWindow::EmitFrame,
                                    base::Unretained(this)));
}

void AppWindow::EmitFrame() {
  if (!widget_ || closing_ || !widget_->IsVisible() ||
      widget_->IsMaximized() || widget_->IsFullscreen() ||
      widget_->IsMinimized()) {
    return;
  }
  base::DictValue extra;
  extra.Set("frame", AppWindows::FrameOf(Bounds()));
  AppWindows::Get().WindowEvent("frame", id_, std::move(extra));
}

void AppWindow::DraggableRegionsChanged(
    const std::vector<blink::mojom::DraggableRegionPtr>& regions,
    content::WebContents* contents) {
  SkRegion region;
  for (const blink::mojom::DraggableRegionPtr& entry : regions) {
    const gfx::Rect& bounds = entry->bounds;
    region.op(SkIRect::MakeLTRB(bounds.x(), bounds.y(), bounds.right(),
                                bounds.bottom()),
              entry->draggable ? SkRegion::kUnion_Op
                               : SkRegion::kDifference_Op);
  }
  draggable_region_ = std::move(region);
}

content::KeyboardEventProcessingResult AppWindow::PreHandleKeyboardEvent(
    content::WebContents* source,
    const input::NativeWebKeyboardEvent& event) {
  return KeyMap::Get().PreHandle(id_, nullptr, event);
}

bool AppWindow::HandleKeyboardEvent(
    content::WebContents* source,
    const input::NativeWebKeyboardEvent& event) {
  return KeyMap::Get().Handle(id_, nullptr, event);
}

void AppWindow::CloseContents(content::WebContents* source) {
  CloseByApp();
}

void AppWindow::ActivateContents(content::WebContents* contents) {
  Focus();
}

content::WebContents* AppWindow::AddNewContents(
    content::WebContents* source,
    std::unique_ptr<content::WebContents> new_contents,
    const GURL& target_url,
    WindowOpenDisposition disposition,
    const blink::mojom::WindowFeatures& window_features,
    bool user_gesture,
    bool* was_blocked) {
  if (was_blocked) {
    *was_blocked = true;
  }
  return nullptr;
}

content::WebContents* AppWindow::OpenURLFromTab(
    content::WebContents* source,
    const content::OpenURLParams& params,
    base::OnceCallback<void(content::NavigationHandle&)>
        navigation_handle_callback) {
  return nullptr;
}

bool AppWindow::IsWebContentsCreationOverridden(
    content::RenderFrameHost* opener,
    content::SiteInstance* source_site_instance,
    content::mojom::WindowContainerType window_container_type,
    const GURL& opener_url,
    const std::string& frame_name,
    const GURL& target_url) {
  return true;
}

void AppWindow::NotePress(const ui::LocatedEvent& event) {
  const gfx::PointF at = event.root_location_f();
  Host::Get()->PagePressed(id_, input_region_.PageAt(at));
}

void AppWindow::OnMouseEvent(ui::MouseEvent* event) {
  if (event->type() == ui::EventType::kMousePressed ||
      event->type() == ui::EventType::kMouseReleased) {
    Host::Get()->PageMouse(id_, input_region_.PageAt(event->root_location_f()),
                           *event);
  }
  if (event->type() != ui::EventType::kMousePressed) {
    return;
  }
  NotePress(*event);
}

void AppWindow::OnTouchEvent(ui::TouchEvent* event) {
  if (event->type() == ui::EventType::kTouchPressed) {
    NotePress(*event);
  }
}

}
