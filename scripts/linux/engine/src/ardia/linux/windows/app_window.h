// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_WINDOWS_APP_WINDOW_H_
#define ARDIA_LINUX_WINDOWS_APP_WINDOW_H_

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "ardia/linux/host/input_region.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/browser/web_contents_observer.h"
#include "third_party/skia/include/core/SkRegion.h"
#include "ui/events/event_handler.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/views/view.h"
#include "ui/views/view_targeter_delegate.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/widget/widget_observer.h"

namespace views {
class WebView;
}

namespace ardia_linux {

class AppWindow;

class AppWindowView : public views::View, public views::ViewTargeterDelegate {
 public:
  explicit AppWindowView(AppWindow* window);
  AppWindowView(const AppWindowView&) = delete;
  AppWindowView& operator=(const AppWindowView&) = delete;
  ~AppWindowView() override;

  views::WebView* ui_view() const { return ui_view_; }
  views::WebView* PageView(const std::string& key) const;
  views::WebView* AddPage(const std::string& key,
                          content::WebContents* contents);
  void PlacePage(const std::string& key, const gfx::Rect& bounds, int radius);
  void RemovePage(const std::string& key);
  std::vector<std::string> PageKeys() const;

  void set_minimum_size(const gfx::Size& size) { minimum_size_ = size; }
  gfx::Size GetMinimumSize() const override;
  void OnBoundsChanged(const gfx::Rect& previous_bounds) override;
  View* TargetForRect(View* root, const gfx::Rect& rect) override;

 private:
  raw_ptr<AppWindow> window_;
  raw_ptr<views::WebView> ui_view_ = nullptr;
  std::map<std::string, raw_ptr<views::WebView>> pages_;
  gfx::Size minimum_size_;
};

class AppWindow : public views::WidgetDelegate,
                  public views::WidgetObserver,
                  public content::WebContentsDelegate,
                  public content::WebContentsObserver,
                  public ui::EventHandler {
 public:
  AppWindow(std::string id,
            WindowShape shape,
            std::unique_ptr<content::WebContents> ui);
  AppWindow(const AppWindow&) = delete;
  AppWindow& operator=(const AppWindow&) = delete;
  ~AppWindow() override;

  const std::string& id() const { return id_; }
  WindowKind kind() const { return shape_.kind; }
  bool is_browser_kind() const {
    return shape_.kind == WindowKind::kBrowser ||
           shape_.kind == WindowKind::kSmall;
  }
  views::Widget* widget() const { return widget_.get(); }
  content::WebContents* ui_contents() const { return ui_.get(); }
  AppWindowView* view() const { return view_; }
  InputRegion& input_region() { return input_region_; }
  bool closing() const { return closing_; }
  bool shown() const { return shown_; }
  const SkRegion& draggable_region() const { return draggable_region_; }

  void Show();
  void CloseByApp();
  void Focus();
  void Minimize();
  void ToggleMaximize();
  void SetPageFullscreen(bool on);
  void SetTitle(const std::string& title);
  void BeginDrag();
  gfx::Rect Bounds() const;
  int FrameCornerRadius() const;
  base::DictValue DebugState() const;
  void Snapshot(base::OnceCallback<void(base::Value)> done);
  bool KeyboardIsHere() const;

  bool ShouldDescendIntoChildForEventHandling(
      gfx::NativeView child,
      const gfx::Point& location) override;
  std::unique_ptr<views::FrameView> CreateFrameView(
      views::Widget* widget) override;
  bool OnCloseRequested(views::Widget::ClosedReason reason) override;

  void OnWidgetActivationChanged(views::Widget* widget, bool active) override;
  void OnWidgetBoundsChanged(views::Widget* widget,
                             const gfx::Rect& new_bounds) override;
  void OnWidgetShowStateChanged(views::Widget* widget) override;
  void OnWidgetDestroying(views::Widget* widget) override;

  void DraggableRegionsChanged(
      const std::vector<blink::mojom::DraggableRegionPtr>& regions,
      content::WebContents* contents) override;
  content::KeyboardEventProcessingResult PreHandleKeyboardEvent(
      content::WebContents* source,
      const input::NativeWebKeyboardEvent& event) override;
  bool HandleKeyboardEvent(content::WebContents* source,
                           const input::NativeWebKeyboardEvent& event) override;
  void CloseContents(content::WebContents* source) override;
  void ActivateContents(content::WebContents* contents) override;
  content::WebContents* AddNewContents(
      content::WebContents* source,
      std::unique_ptr<content::WebContents> new_contents,
      const GURL& target_url,
      WindowOpenDisposition disposition,
      const blink::mojom::WindowFeatures& window_features,
      bool user_gesture,
      bool* was_blocked) override;
  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)>
          navigation_handle_callback) override;
  bool IsWebContentsCreationOverridden(
      content::RenderFrameHost* opener,
      content::SiteInstance* source_site_instance,
      content::mojom::WindowContainerType window_container_type,
      const GURL& opener_url,
      const std::string& frame_name,
      const GURL& target_url) override;

  void RenderViewReady() override;
  void RenderFrameHostChanged(content::RenderFrameHost* old_host,
                              content::RenderFrameHost* new_host) override;
  void PrimaryMainDocumentElementAvailable() override;

  void OnMouseEvent(ui::MouseEvent* event) override;
  void OnTouchEvent(ui::TouchEvent* event) override;

 private:
  class Frame;

  void MakeTransparent();
  void ApplyShape();
  void StepFade();
  void EmitFrameSoon();
  void EmitFrame();
  void NotePress(const ui::LocatedEvent& event);

  std::string id_;
  WindowShape shape_;
  std::unique_ptr<content::WebContents> ui_;
  std::unique_ptr<views::Widget> widget_;
  raw_ptr<AppWindowView> view_ = nullptr;
  InputRegion input_region_;
  SkRegion draggable_region_;
  bool shown_ = false;
  bool closing_ = false;
  bool closed_by_app_ = false;
  bool maximized_ = false;
  bool fullscreen_ = false;
  base::TimeTicks fade_started_;
  base::TimeDelta fade_length_;
  base::RepeatingTimer fade_timer_;
  base::OneShotTimer frame_timer_;
  base::ScopedObservation<views::Widget, views::WidgetObserver>
      widget_observation_{this};
  base::WeakPtrFactory<AppWindow> weak_factory_{this};
};

}

#endif
