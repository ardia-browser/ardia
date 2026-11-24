#pragma once

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/desktop/ac_desktop_window_corners.h"

namespace base {
template <typename T> class WeakPtr {
 public:
  WeakPtr() = default;
  WeakPtr(T* value, std::weak_ptr<bool> alive) : value_(value), alive_(std::move(alive)) {}
  T* get() const { return alive_.expired() ? nullptr : value_; }
  T* operator->() const { return get(); }
  explicit operator bool() const { return get(); }
 private:
  T* value_ = nullptr;
  std::weak_ptr<bool> alive_;
};
template <typename T> class WeakPtrFactory {
 public:
  explicit WeakPtrFactory(T* value) : value_(value) {}
  WeakPtr<T> GetWeakPtr() { return {value_, alive_}; }
 private:
  T* value_;
  std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};
class OnceClosure {
 public:
  OnceClosure() = default;
  template <typename F> OnceClosure(F fn) : fn_(std::move(fn)) {}
  explicit operator bool() const { return static_cast<bool>(fn_); }
  void Run() && { auto fn = std::move(fn_); if (fn) fn(); }
 private:
  std::function<void()> fn_;
};
template <typename F, typename... Bound> OnceClosure BindOnce(F fn, Bound... bound) {
  return OnceClosure([fn, bound...]() mutable { fn(std::move(bound)...); });
}
struct DictValue {
  DictValue& Set(const char*, const char* value) { type = value; return *this; }
  std::string type;
};
template <typename T> class AutoReset {
 public:
  AutoReset(T* target, T value) : target_(target), previous_(*target) { *target_ = std::move(value); }
  ~AutoReset() { *target_ = std::move(previous_); }
 private:
  T* target_;
  T previous_;
};
}

#define METADATA_HEADER(...)

using Profile = int;

namespace gfx {
struct Vector2d {
  int x = 0, y = 0;
};
struct Size {
  int width = 0, height = 0;
  bool IsEmpty() const { return width <= 0 || height <= 0; }
  bool operator==(const Size&) const = default;
};
struct Rect {
  int x_ = 0, y_ = 0, w_ = 0, h_ = 0;
  Rect() = default;
  Rect(int x, int y, int w, int h) : x_(x), y_(y), w_(w), h_(h) {}
  explicit Rect(Size size) : w_(size.width), h_(size.height) {}
  int x() const { return x_; }
  int y() const { return y_; }
  int width() const { return w_; }
  int height() const { return h_; }
  Size size() const { return {w_, h_}; }
  bool IsEmpty() const { return w_ <= 0 || h_ <= 0; }
  Vector2d OffsetFromOrigin() const { return {x_, y_}; }
  void Offset(int dx, int dy) { x_ += dx; y_ += dy; }
  void Intersect(const Rect& other) {
    const int left = std::max(x_, other.x_), top = std::max(y_, other.y_);
    const int right = std::min(x_ + w_, other.x_ + other.w_), bottom = std::min(y_ + h_, other.y_ + other.h_);
    if (right <= left || bottom <= top) { *this = Rect(); return; }
    *this = Rect(left, top, right - left, bottom - top);
  }
  bool operator==(const Rect&) const = default;
};
inline Rect operator+(Rect rect, Vector2d offset) { rect.Offset(offset.x, offset.y); return rect; }
struct RoundedCornersF {
  float upper_left = 0, upper_right = 0, lower_right = 0, lower_left = 0;
  RoundedCornersF() = default;
  explicit RoundedCornersF(float r) : upper_left(r), upper_right(r), lower_right(r), lower_left(r) {}
  RoundedCornersF(float ul, float ur, float lr, float ll)
      : upper_left(ul), upper_right(ur), lower_right(lr), lower_left(ll) {}
  bool operator==(const RoundedCornersF&) const = default;
};
}

namespace ui {
enum LayerType { LAYER_NOT_DRAWN };
struct Layer {
  Layer* parent() const { return parent_; }
  void SetFillsBoundsOpaquely(bool value) { opaque = value; }
  void SetMasksToBounds(bool value) { masks_to_bounds = value; }
  void SetRoundedCornerRadius(gfx::RoundedCornersF value) { radii = value; }
  void SetIsFastRoundedCorner(bool value) { fast_rounded = value; }
  Layer* parent_ = nullptr;
  bool opaque = true;
  bool masks_to_bounds = false;
  bool fast_rounded = false;
  gfx::RoundedCornersF radii;
};
}

namespace views {
inline const int* const kHostViewKey = nullptr;
inline bool manages_layers = true;
}

namespace aura {
struct Window {
  void Show() { shows++; visible = true; }
  void Hide() { visible = false; }
  bool IsVisible() const { return visible; }
  ui::Layer* layer() { return &layer_; }
  const void* GetProperty(const int*) const { return host_view; }
  bool visible = true;
  int shows = 0;
  bool parented = false;
  const void* host_view = nullptr;
  ui::Layer layer_;
};
}

namespace gfx {
using NativeView = aura::Window*;
}

namespace content {
class WebContents;
class WebContentsObserver {
 public:
  explicit WebContentsObserver(WebContents* contents = nullptr) { Observe(contents); }
  virtual ~WebContentsObserver() { Observe(nullptr); }
  void Observe(WebContents* contents);
  WebContents* web_contents() const { return observed_; }
  virtual void WebContentsDestroyed() {}
 private:
  WebContents* observed_ = nullptr;
};
class WebContents {
 public:
  ~WebContents() { Destroy(); }
  int GetBrowserContext() const { return 0; }
  void Destroy() {
    if (destroyed) return;
    destroyed = true;
    auto pending = observers;
    for (auto* observer : pending) observer->WebContentsDestroyed();
    alive.reset();
  }
  base::WeakPtr<WebContents> GetWeakPtr() { return {this, alive}; }
  aura::Window* GetNativeView() { return &native; }
  void Focus() {
    focuses++;
    auto hook = focused;
    if (hook) hook();
  }
  struct Delegate {
    bool fullscreen = false;
    bool IsFullscreenForTabOrPending(const WebContents*) const { return fullscreen; }
  };
  bool IsBeingCaptured() const { return captured; }
  gfx::Size GetPreferredSize() const { return preferred_size; }
  Delegate* GetDelegate() { return &delegate; }
  std::function<void()> focused;
  aura::Window native;
  Delegate delegate;
  bool captured = false;
  gfx::Size preferred_size;
  int focuses = 0;
  bool destroyed = false;
  std::vector<WebContentsObserver*> observers;
  std::shared_ptr<bool> alive = std::make_shared<bool>(true);
};
inline void WebContentsObserver::Observe(WebContents* contents) {
  if (observed_) std::erase(observed_->observers, this);
  observed_ = contents;
  if (observed_) observed_->observers.push_back(this);
}
}

namespace ardiacore {
inline content::WebContents* shown_slot = nullptr;
inline void NoteTabInShownSlot(content::WebContents* contents) { shown_slot = contents; }
}

struct DevToolsContentsResizingStrategy {
  bool hide_inspected_contents() const { return hide; }
  int width = 0;
  bool hide = false;
};
inline void ApplyDevToolsContentsResizingStrategy(const DevToolsContentsResizingStrategy& strategy,
                                                  const gfx::Rect& container, gfx::Rect* devtools,
                                                  gfx::Rect* page) {
  *devtools = container;
  *page = gfx::Rect(container.x(), container.y(), container.width() - strategy.width, container.height());
}
struct DevToolsWindow {
  static content::WebContents* GetInTabWebContents(content::WebContents* inspected,
                                                   DevToolsContentsResizingStrategy* strategy) {
    const auto found = docked.find(inspected);
    if (found == docked.end() || !found->second || found->second->destroyed) return nullptr;
    if (strategy) *strategy = strategies[inspected];
    return found->second;
  }
  static DevToolsWindow* AsDevToolsWindow(content::WebContents* contents) {
    static DevToolsWindow window;
    return contents && !companions.contains(contents) ? &window : nullptr;
  }
  static inline std::set<content::WebContents*> companions;
  static inline std::map<content::WebContents*, content::WebContents*> docked;
  static inline std::map<content::WebContents*, DevToolsContentsResizingStrategy> strategies;
};

namespace views {
class View {
 public:
  virtual ~View() = default;
  bool Contains(const View* view) const { return view == this; }
  void RequestFocus();
  void SetVisible(bool value) { visible_ = value; }
  bool GetVisible() const { return visible_; }
  void SetBoundsRect(const gfx::Rect& bounds) {
    const gfx::Rect previous = bounds_;
    bounds_ = bounds;
    OnBoundsChanged(previous);
  }
  const gfx::Rect& bounds() const { return bounds_; }
  void SetPaintToLayer(ui::LayerType = ui::LAYER_NOT_DRAWN) {
    if (!layer_) layer_ = std::make_unique<ui::Layer>();
  }
  ui::Layer* layer() const { return layer_.get(); }
 protected:
  virtual void OnBoundsChanged(const gfx::Rect&) {}
 private:
  bool visible_ = true;
  gfx::Rect bounds_;
  std::unique_ptr<ui::Layer> layer_;
};
class FocusManager {
 public:
  View* GetFocusedView() const { return focused; }
  void ClearFocus() { focused = nullptr; }
  View* focused = nullptr;
};
inline FocusManager focus_manager;
inline bool detach_advances_focus = false;
inline int focused_detaches = 0;
inline void View::RequestFocus() { focus_manager.focused = this; }
struct NativeViewHolder {
  explicit NativeViewHolder(const View* owner = nullptr) : owner_(owner) {}
  void SetNativeViewCornerRadii(gfx::RoundedCornersF radii) {
    applied_radii = clip_installed ? gfx::RoundedCornersF(radii.upper_left, radii.upper_right, 0, 0) : radii;
  }
  void SetNativeViewSize(gfx::Size size) { native_size = size; }
  void SetBoundsRect(const gfx::Rect& rect) { holder_bounds = rect; }
  const gfx::Rect& bounds() const { return holder_bounds; }
  void DeprecatedLayoutImmediately() {
    immediate_layouts++;
    if (!owner_ || !native_) return;
    const gfx::Rect parent_local(owner_->bounds().size());
    clip_installed = !parent_local.IsEmpty() && !holder_bounds.IsEmpty() && holder_bounds != parent_local;
    clip_rect = clip_installed ? parent_local : gfx::Rect();
  }
  aura::Window* GetNativeViewContainer() { return manages_layers ? nullptr : &container_; }
  gfx::NativeView native_view() const { return native_; }
  bool layer_managed_by_views() const { return manages_layers; }
  ui::Layer* layer() { return native_ ? &layer_ : nullptr; }
  bool Holds(gfx::NativeView native) {
    if (native_ != native || !native->parented) return false;
    return manages_layers ? native->layer()->parent() == &layer_ : native->host_view == this;
  }
  void Attach(gfx::NativeView native) {
    native_ = native;
    native->parented = true;
    if (manages_layers) native->layer_.parent_ = &layer_;
    else native->host_view = this;
  }
  void Detach() {
    gfx::NativeView native = std::exchange(native_, nullptr);
    native->parented = false;
    if (native->layer_.parent_ == &layer_) native->layer_.parent_ = nullptr;
    if (native->host_view == this) native->host_view = nullptr;
    clip_installed = false;
    clip_rect = gfx::Rect();
    native->Hide();
  }
  const View* owner_ = nullptr;
  gfx::NativeView native_ = nullptr;
  ui::Layer layer_;
  aura::Window container_;
  gfx::Rect holder_bounds;
  gfx::Rect clip_rect;
  gfx::Size native_size;
  gfx::RoundedCornersF applied_radii;
  bool clip_installed = false;
  int immediate_layouts = 0;
};
using NativeViewHost = NativeViewHolder;
class WebView : public View, private content::WebContentsObserver {
 public:
  explicit WebView(Profile* = nullptr) : holder_(this) {}
  void SetWebContents(content::WebContents* contents) {
    if (contents == contents_) return;
    if (contents_) holder_.Detach();
    contents_ = contents;
    Observe(contents);
    if (!contents && detach_advances_focus && focus_manager.focused == this) {
      focused_detaches++;
      focus_manager.focused = nullptr;
    }
    if (!contents) return;
    holder_.Attach(contents->GetNativeView());
    OnBoundsChanged(bounds());
    if (GetVisible()) contents->GetNativeView()->Show();
  }
  content::WebContents* web_contents() const { return contents_; }
  NativeViewHolder* holder() { return &holder_; }
  int base_bounds_changes = 0;
 protected:
  void OnBoundsChanged(const gfx::Rect&) override {
    base_bounds_changes++;
    holder_.SetBoundsRect(gfx::Rect(bounds().size()));
  }
 private:
  void WebContentsDestroyed() override { SetWebContents(nullptr); }
  content::WebContents* contents_ = nullptr;
  NativeViewHolder holder_;
};
}

ARDIA_VIEWPORT_VIEW

struct ContentsContainerView {
  views::WebView* devtools_web_view() { return &devtools; }
  views::WebView devtools;
};
struct BrowserView;
struct BrowserWindowInterface { BrowserView* view = nullptr; };
inline Profile* ProfileOf(int) { return nullptr; }
struct BrowserView {
  static BrowserView* GetBrowserViewForBrowser(BrowserWindowInterface* browser) { return browser ? browser->view : nullptr; }
  views::WebView* GetActiveContentsWebView() { return &contents; }
  ContentsContainerView* GetContentsContainerViewFor(content::WebContents* inspected) {
    return containers.contains(inspected) ? &containers[inspected] : nullptr;
  }
  views::WebView contents;
  std::map<content::WebContents*, ContentsContainerView> containers;
};

inline std::vector<base::OnceClosure> posted;
inline void DrainPosted() {
  while (!posted.empty()) {
    auto pending = std::move(posted);
    posted.clear();
    for (auto& task : pending) std::move(task).Run();
  }
}

inline std::map<content::WebContents*, int> tab_ids;
inline int TabId(content::WebContents* contents) { return tab_ids.contains(contents) ? tab_ids.at(contents) : 0; }

namespace ardiacore {
inline std::vector<content::WebContents*> forgotten_hangs;
inline void ForgetDeferredLinuxHangs(content::WebContents* contents) { forgotten_hangs.push_back(contents); }
}

namespace desktop_window_corners = ardia::desktop_window_corners;

class ShellHostView;
ARDIA_FRONTEND_WATCH

class TabBinding {
 public:
  TabBinding(ShellHostView* owner, content::WebContents* contents) : owner_(owner), contents_(contents) {}
  content::WebContents* contents() const { return contents_; }
  ViewportView* viewport() const { return viewport_; }
  ViewportView* devtools_viewport() const { return devtools_viewport_; }
  void SetDevToolsViewport(ViewportView* view) { devtools_viewport_ = view; }
  void ResetPageCommands() { resets++; }
  std::unique_ptr<int> media = std::make_unique<int>(1);
  struct Page {
    TabBinding* binding;
    bool EmitClosed();
  };
  std::unique_ptr<Page> page_ = std::make_unique<Page>(Page{this});
  void RetirePage() { page_.reset(); }
  void ReportPresentation(std::string name, base::DictValue data);
  struct Weak {
    TabBinding* binding;
    explicit operator bool() const { return binding; }
  };
  Weak GetWeakPtr() { return {this}; }
  void WebContentsDestroyed();
  void FocusFromHost();
  void OnWebContentsFocused(void*);
  bool presented = true;
  bool host_focusing_ = false;
  std::unique_ptr<DevToolsFrontendWatch> devtools_watch;
  bool devtools_had_focus = false;
  gfx::Rect pane_bounds;
  gfx::Rect content_bounds;
  std::vector<gfx::Rect> pane_shape;
  std::vector<gfx::Rect> pane_input_shape;
  bool pane_visible = false;
  desktop_window_corners::Corners pane_radii = desktop_window_corners::kPageCardCorners;
  std::string claim = "claim";
  uint64_t renderer_generation = 1;
  int resets = 0;
  ShellHostView* owner_;
  content::WebContents* contents_;
  ViewportView* viewport_ = nullptr;
  ViewportView* devtools_viewport_ = nullptr;
};

class ShellHostView : public views::View {
 public:
  ShellHostView();
  ~ShellHostView();
  void LayoutPane(TabBinding* binding);
  std::vector<TabBinding*> forgotten;
  void ForgetClosedTab(TabBinding* binding) { forgotten.push_back(binding); }
  void OnDevToolsDockChanged(content::WebContents* inspected, content::WebContents* devtools);
  void HideDevToolsViewport(TabBinding* binding);
  void Restack() { restacks++; }
  void ClipPaneView(TabBinding* binding, views::WebView* view);
  void ClipViewport(views::WebView* view, const desktop_window_corners::Corners& own) {
    clipped.push_back(view);
    clipped_radii.push_back(own);
    if (auto* viewport = dynamic_cast<ViewportView*>(view)) {
      viewport->ApplyCornerRadii(gfx::RoundedCornersF(own.upper_left, own.upper_right, own.lower_right, own.lower_left));
    }
  }
  TabBinding* Binding(int id) {
    for (auto& binding : bindings) {
      if (TabId(binding->contents()) == id) return binding.get();
    }
    return nullptr;
  }
  void PresentDevTools(content::WebContents* inspected) {
    if (!inspected) return;
    posted.push_back(base::BindOnce(
        [](base::WeakPtr<ShellHostView> host, base::WeakPtr<content::WebContents> contents) {
          if (!host || !contents) return;
          for (auto& binding : host->bindings) {
            if (binding->contents() == contents.get()) host->LayoutPane(binding.get());
          }
        }, GetWeakPtr(), inspected->GetWeakPtr()));
  }
  views::FocusManager* GetFocusManager() { return &views::focus_manager; }
  template <typename T> T* AddChildView(std::unique_ptr<T> view) {
    T* raw = view.get();
    children.push_back(std::move(view));
    return raw;
  }
  std::optional<size_t> GetIndexOf(const views::View* view) const {
    for (size_t index = 0; index < children.size(); ++index) {
      if (children[index].get() == view) return index;
    }
    return std::nullopt;
  }
  void ReorderChildView(views::View* view, size_t index) {
    auto found = std::find_if(children.begin(), children.end(), [view](const auto& child) { return child.get() == view; });
    auto moved = std::move(*found);
    children.erase(found);
    children.insert(children.begin() + std::min(index, children.size()), std::move(moved));
  }
  Profile* profile() const { return nullptr; }
  Profile* page_profile() const { return nullptr; }
  base::WeakPtr<ShellHostView> GetWeakPtr() { return weak.GetWeakPtr(); }
  TabBinding* Bind(content::WebContents* contents, int id) {
    tab_ids[contents] = id;
    bindings.push_back(std::make_unique<TabBinding>(this, contents));
    auto* binding = bindings.back().get();
    binding->viewport_ = AddChildView(std::make_unique<ViewportView>(nullptr));
    binding->renderer_generation = renderer_generation_;
    return binding;
  }
  void Show(TabBinding* binding, bool visible) {
    binding->pane_bounds = gfx::Rect(100, 50, 800, 600);
    binding->pane_shape = {gfx::Rect(0, 0, 800, 600)};
    binding->pane_input_shape = {gfx::Rect(0, 0, 800, 600)};
    binding->pane_visible = visible;
    LayoutPane(binding);
  }
  std::vector<std::unique_ptr<views::View>> children;
  std::vector<std::unique_ptr<TabBinding>> bindings;
  std::vector<int> closes;
  std::vector<std::pair<int, std::string>> events;
  BrowserView browser_view_storage;
  BrowserView* browser_view_ = &browser_view_storage;
  BrowserWindowInterface member_storage{&browser_view_storage};
  BrowserWindowInterface* OwnerOf(content::WebContents* contents) { return contents ? &member_storage : nullptr; }
  int handler_storage = 0;
  int* handler_ = &handler_storage;
  uint64_t renderer_generation_ = 1;
  int restacks = 0;
  std::vector<views::WebView*> clipped;
  std::vector<desktop_window_corners::Corners> clipped_radii;
  base::WeakPtrFactory<ShellHostView> weak{this};
};

inline std::map<int, ShellHostView*>& Hosts() {
  static std::map<int, ShellHostView*> hosts;
  return hosts;
}

inline ShellHostView::ShellHostView() { Hosts()[static_cast<int>(Hosts().size()) + 1] = this; }
inline ShellHostView::~ShellHostView() {
  std::erase_if(Hosts(), [this](const auto& entry) { return entry.second == this; });
}

inline bool TabBinding::Page::EmitClosed() {
  binding->owner_->closes.push_back(TabId(binding->contents_));
  return true;
}
inline void TabBinding::ReportPresentation(std::string name, base::DictValue) {
  if (page_) owner_->events.emplace_back(TabId(contents_), std::move(name));
}

ARDIA_HOST_METHODS
