// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/browser_window/browser_window.h"

#include <algorithm>
#include <set>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/host/host.h"
#include "ardia/linux/host/key_map.h"
#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/devtools/devtools_ui_controller.h"
#include "chrome/browser/lifetime/browser_shutdown.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_window/public/browser_window_features.h"
#include "chrome/browser/ui/exclusive_access/exclusive_access_manager.h"
#include "chrome/browser/ui/exclusive_access/fullscreen_controller.h"
#include "chrome/browser/ui/find_bar/find_bar.h"
#include "chrome/browser/ui/unload_controller.h"
#include "chrome/browser/ui/views/exclusive_access/exclusive_access_bubble_views.h"
#include "chrome/browser/ui/views/eye_dropper/eye_dropper.h"
#include "chrome/browser/ui/views/frame/contents_container_view.h"
#include "components/input/native_web_keyboard_event.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/eye_dropper.h"
#include "content/public/browser/eye_dropper_listener.h"
#include "content/public/browser/keyboard_event_processing_result.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/accelerators/accelerator.h"
#include "ui/base/mojom/window_show_state.mojom.h"
#include "ui/base/ui_base_features.h"
#include "ui/color/color_provider_manager.h"
#include "ui/display/types/display_constants.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/native_theme/native_theme.h"
#include "ui/views/widget/widget.h"

namespace ardia_linux {

namespace {

std::set<const BrowserWindow*>& LiveWindows() {
  static base::NoDestructor<std::set<const BrowserWindow*>> windows;
  return *windows;
}

std::set<const BrowserWindowInterface*>& OurBrowsers() {
  static base::NoDestructor<std::set<const BrowserWindowInterface*>> browsers;
  return *browsers;
}

gfx::Rect PageRectIn(AppWindow* window, content::WebContents* contents) {
  if (!window || !window->widget()) {
    return gfx::Rect();
  }
  const gfx::Rect whole(window->widget()->GetWindowBoundsInScreen().size());
  std::optional<gfx::Rect> place =
      contents ? Host::Get()->PlaceOf(contents) : std::nullopt;
  if (!place || place->IsEmpty()) {
    return whole;
  }
  gfx::Rect page = *place;
  page.Intersect(whole);
  return page.IsEmpty() ? whole : page;
}

gfx::Point DialogPosition(AppWindow* window,
                          const gfx::Rect& page,
                          const gfx::Size& size) {
  const int width = window && window->widget()
                        ? window->widget()->GetWindowBoundsInScreen().width()
                        : page.right();
  int x = page.x() + (page.width() - size.width()) / 2;
  x = std::min(x, width - size.width());
  x = std::max(x, 0);
  return gfx::Point(x, page.y());
}

class TabDialogHost : public web_modal::WebContentsModalDialogHost,
                      public content::WebContentsUserData<TabDialogHost> {
 public:
  TabDialogHost(const TabDialogHost&) = delete;
  TabDialogHost& operator=(const TabDialogHost&) = delete;
  ~TabDialogHost() override {
    for (auto& observer : observers_) {
      observer.OnHostDestroying();
    }
  }

  gfx::NativeView GetHostView() const override {
    AppWindow* window = Window();
    return window && window->widget() ? window->widget()->GetNativeView()
                                      : gfx::NativeView();
  }

  gfx::Point GetDialogPosition(const gfx::Size& size) override {
    AppWindow* window = Window();
    return DialogPosition(window, PageRectIn(window, &GetWebContents()),
                          size);
  }

  bool ShouldActivateDialog() const override {
    AppWindow* window = Window();
    return window && window->KeyboardIsHere();
  }

  gfx::Size GetMaximumDialogSize() override {
    return PageRectIn(Window(), &GetWebContents()).size();
  }

  void AddObserver(web_modal::ModalDialogHostObserver* observer) override {
    if (!observers_.HasObserver(observer)) {
      observers_.AddObserver(observer);
    }
  }

  void RemoveObserver(web_modal::ModalDialogHostObserver* observer) override {
    observers_.RemoveObserver(observer);
  }

  void NotifyPositionRequiresUpdate() override {
    observers_.Notify(
        &web_modal::ModalDialogHostObserver::OnPositionRequiresUpdate);
  }

 private:
  friend class content::WebContentsUserData<TabDialogHost>;
  explicit TabDialogHost(content::WebContents* contents)
      : content::WebContentsUserData<TabDialogHost>(*contents) {}

  AppWindow* Window() const {
    return AppWindows::Get().Find(Host::Get()->WindowOfContents(
        const_cast<content::WebContents*>(&GetWebContents())));
  }

  base::ObserverList<web_modal::ModalDialogHostObserver> observers_;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(TabDialogHost);

class BackgroundEyeDropper : public content::EyeDropper {
 public:
  explicit BackgroundEyeDropper(content::EyeDropperListener* listener)
      : listener_(listener) {
    LOG(WARNING) << "[ardia linux] eye dropper (background run: picks #123456)";
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&BackgroundEyeDropper::Pick,
                                  weak_factory_.GetWeakPtr()));
  }

 private:
  void Pick() { listener_->ColorSelected(SkColorSetRGB(0x12, 0x34, 0x56)); }

  raw_ptr<content::EyeDropperListener> listener_;
  base::WeakPtrFactory<BackgroundEyeDropper> weak_factory_{this};
};

}

web_modal::WebContentsModalDialogHost* TabDialogHostFor(
    content::WebContents* contents) {
  return TabDialogHost::GetOrCreateForWebContents(contents);
}

HostedBrowserWindow* HostedBrowserWindow::FromWindow(
    const BrowserWindow* window) {
  if (!window || !LiveWindows().contains(window)) {
    return nullptr;
  }
  return static_cast<HostedBrowserWindow*>(const_cast<BrowserWindow*>(window));
}

bool HostedBrowserWindow::IsOurs(const BrowserWindowInterface* browser) {
  return browser && OurBrowsers().contains(browser);
}

HostedBrowserWindow::HostedBrowserWindow(std::string window)
    : window_(std::move(window)),
      location_bar_(std::make_unique<LocationBarStandIn>()) {
  LiveWindows().insert(this);
}

HostedBrowserWindow::~HostedBrowserWindow() {
  LiveWindows().erase(this);
  for (auto& observer : modal_observers_) {
    observer.OnHostDestroying();
  }
  DestroyAnyExclusiveAccessBubble();
  devtools_ui_controller_.reset();
  autofill_bubble_handler_registration_.reset();
  if (browser_) {
    OurBrowsers().erase(browser_);
    browser_->GetFeatures().TearDownPreBrowserWindowDestruction();
    Host::Get()->BrowserWindowGone(browser_);
  }
}

void HostedBrowserWindow::AttachBrowser(Browser* browser) {
  browser_ = browser;
  OurBrowsers().insert(browser);
  autofill_bubble_handler_registration_.emplace(
      browser->GetUnownedUserDataHost(), autofill_bubble_handler_);
  location_bar_->set_browser(browser);
  devtools_ui_controller_ = std::make_unique<DevtoolsUIController>(
      browser,
      std::vector<raw_ptr<ContentsContainerView, DanglingUntriaged>>());
}

std::string HostedBrowserWindow::window_id() const {
  if (browser_) {
    std::string hosted = Host::Get()->WindowOfBrowser(browser_);
    if (!hosted.empty()) {
      return hosted;
    }
  }
  return window_;
}

AppWindow* HostedBrowserWindow::app_window() const {
  return AppWindows::Get().Find(window_id());
}

void HostedBrowserWindow::DeleteBrowserWindow() {
  delete this;
}

bool HostedBrowserWindow::IsActive() const {
  AppWindow* window = app_window();
  return window && window->KeyboardIsHere();
}

bool HostedBrowserWindow::IsMaximized() const {
  AppWindow* window = app_window();
  return window && window->widget() && window->widget()->IsMaximized();
}

bool HostedBrowserWindow::IsMinimized() const {
  AppWindow* window = app_window();
  return window && window->widget() && window->widget()->IsMinimized();
}

bool HostedBrowserWindow::IsFullscreen() const {
  AppWindow* window = app_window();
  if (tab_fullscreen_ ||
      (window && window->widget() && window->widget()->IsFullscreen())) {
    return true;
  }
  ExclusiveAccessManager* manager =
      browser_ ? ExclusiveAccessManager::From(browser_) : nullptr;
  return manager && manager->fullscreen_controller()->IsTabFullscreen();
}

gfx::NativeWindow HostedBrowserWindow::GetNativeWindow() const {
  AppWindow* window = app_window();
  return window && window->widget() ? window->widget()->GetNativeWindow()
                                    : gfx::NativeWindow();
}

gfx::Rect HostedBrowserWindow::GetRestoredBounds() const {
  AppWindow* window = app_window();
  return window && window->widget() ? window->widget()->GetRestoredBounds()
                                    : gfx::Rect();
}

ui::mojom::WindowShowState HostedBrowserWindow::GetRestoredState() const {
  return ui::mojom::WindowShowState::kNormal;
}

gfx::Rect HostedBrowserWindow::GetBounds() const {
  AppWindow* window = app_window();
  return window ? window->Bounds() : gfx::Rect();
}

void HostedBrowserWindow::Show() {
  if (AppWindow* window = app_window()) {
    window->Focus();
  }
}

bool HostedBrowserWindow::IsVisible() const {
  AppWindow* window = app_window();
  return window && window->widget() && window->widget()->IsVisible();
}

void HostedBrowserWindow::ShowInactive() {}

void HostedBrowserWindow::Close() {
  if (!browser_) {
    return;
  }
  UnloadController* unload = UnloadController::From(browser_);
  if (unload) {
    unload->OnWindowClosing();
  }
}

void HostedBrowserWindow::Activate() {
  if (AppWindow* window = app_window()) {
    window->Focus();
  }
}

void HostedBrowserWindow::SetBounds(const gfx::Rect& bounds) {}

ui::ZOrderLevel HostedBrowserWindow::GetZOrderLevel() const {
  return ui::ZOrderLevel::kNormal;
}

bool HostedBrowserWindow::IsOnCurrentWorkspace() const {
  return true;
}

bool HostedBrowserWindow::IsVisibleOnScreen() const {
  return IsVisible();
}

bool HostedBrowserWindow::DoBrowserControlsShrinkRendererSize(
    const content::WebContents* contents) const {
  return false;
}

ui::NativeTheme* HostedBrowserWindow::GetNativeTheme() {
  return ui::NativeTheme::GetInstanceForNativeUi();
}

const ui::ThemeProvider* HostedBrowserWindow::GetThemeProvider() const {
  return browser_ ? &ThemeService::GetThemeProviderForProfile(
                        browser_->GetProfile())
                  : nullptr;
}

const ui::ColorProvider* HostedBrowserWindow::GetColorProvider() const {
  AppWindow* window = app_window();
  if (window && window->widget()) {
    return window->widget()->GetColorProvider();
  }
  return ui::ColorProviderManager::Get().GetColorProviderFor(
      ui::ColorProviderKey());
}

int HostedBrowserWindow::GetTopControlsHeight() const {
  return 0;
}

std::vector<StatusBubble*> HostedBrowserWindow::GetStatusBubbles() {
  return {};
}

void HostedBrowserWindow::OnActiveTabChanged(content::WebContents* old_contents,
                                             content::WebContents* new_contents,
                                             int index,
                                             int reason) {}

gfx::Size HostedBrowserWindow::GetContentsSize() const {
  AppWindow* window = app_window();
  return window ? window->Bounds().size() : gfx::Size();
}

autofill::AutofillBubbleHandler*
HostedBrowserWindow::GetAutofillBubbleHandler() {
  return &autofill_bubble_handler_;
}

LocationBar* HostedBrowserWindow::GetLocationBar() const {
  return location_bar_.get();
}

bool HostedBrowserWindow::UpdateToolbarSecurityState() {
  return false;
}

bool HostedBrowserWindow::IsTabStripEditable() const {
  return true;
}

bool HostedBrowserWindow::IsToolbarVisible() const {
  return false;
}

bool HostedBrowserWindow::IsToolbarShowing() const {
  return false;
}

bool HostedBrowserWindow::IsLocationBarVisible() const {
  return false;
}

ShowTranslateBubbleResult HostedBrowserWindow::ShowTranslateBubble(
    content::WebContents* contents,
    translate::TranslateStep step,
    const std::string& source_language,
    const std::string& target_language,
    translate::TranslateErrors error_type,
    bool is_user_gesture) {
  return ShowTranslateBubbleResult::kBrowserWindowNotValid;
}

DownloadBubbleUIController*
HostedBrowserWindow::GetDownloadBubbleUIController() {
  return nullptr;
}

void HostedBrowserWindow::ConfirmBrowserCloseWithPendingDownloads(
    int download_count,
    DownloadCloseType dialog_type,
    base::OnceCallback<void(bool)> callback) {
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(std::move(callback), true));
}

content::KeyboardEventProcessingResult
HostedBrowserWindow::PreHandleKeyboardEvent(
    const input::NativeWebKeyboardEvent& event) {
  content::WebContents* contents =
      browser_ ? browser_->GetTabStripModel()->GetActiveWebContents()
               : nullptr;
  return KeyMap::Get().PreHandle(window_id(), contents, event);
}

bool HostedBrowserWindow::HandleKeyboardEvent(
    const input::NativeWebKeyboardEvent& event) {
  content::WebContents* contents =
      browser_ ? browser_->GetTabStripModel()->GetActiveWebContents()
               : nullptr;
  return KeyMap::Get().Handle(window_id(), contents, event);
}

std::unique_ptr<FindBar> HostedBrowserWindow::CreateFindBar() {
  return std::make_unique<FindBarStandIn>();
}

web_modal::WebContentsModalDialogHost*
HostedBrowserWindow::GetWebContentsModalDialogHost() {
  return this;
}

web_modal::WebContentsModalDialogHost*
HostedBrowserWindow::GetWebContentsModalDialogHostFor(
    content::WebContents* web_contents) {
  if (web_contents && tabs::TabInterface::MaybeGetFromContents(web_contents)) {
    return TabDialogHostFor(web_contents);
  }
  return this;
}

gfx::NativeView HostedBrowserWindow::GetHostView() const {
  AppWindow* window = app_window();
  return window && window->widget() ? window->widget()->GetNativeView()
                                    : gfx::NativeView();
}

gfx::Point HostedBrowserWindow::GetDialogPosition(const gfx::Size& size) {
  AppWindow* window = app_window();
  return DialogPosition(window, PageRectIn(window, nullptr), size);
}

bool HostedBrowserWindow::ShouldActivateDialog() const {
  return IsActive();
}

gfx::Size HostedBrowserWindow::GetMaximumDialogSize() {
  return PageRectIn(app_window(), nullptr).size();
}

void HostedBrowserWindow::AddObserver(
    web_modal::ModalDialogHostObserver* observer) {
  if (!modal_observers_.HasObserver(observer)) {
    modal_observers_.AddObserver(observer);
  }
}

void HostedBrowserWindow::RemoveObserver(
    web_modal::ModalDialogHostObserver* observer) {
  modal_observers_.RemoveObserver(observer);
}

void HostedBrowserWindow::NotifyPositionRequiresUpdate() {
  modal_observers_.Notify(
      &web_modal::ModalDialogHostObserver::OnPositionRequiresUpdate);
}

void HostedBrowserWindow::ShowEmojiPanel() {
  AppWindow* window = app_window();
  if (window && window->widget()) {
    window->widget()->ShowEmojiPanel();
  }
}

std::unique_ptr<content::EyeDropper> HostedBrowserWindow::OpenEyeDropper(
    content::RenderFrameHost* frame,
    content::EyeDropperListener* listener) {
  if (ardiacore::BackgroundInstance() && listener) {
    return features::IsEyeDropperEnabled()
               ? std::make_unique<BackgroundEyeDropper>(listener)
               : nullptr;
  }
  return ShowEyeDropper(frame, listener);
}

bool HostedBrowserWindow::IsUnframedModeEnabled() const {
  return false;
}

bool HostedBrowserWindow::GetCanResize() {
  return true;
}

ui::mojom::WindowShowState HostedBrowserWindow::GetWindowShowState() const {
  if (IsMinimized()) {
    return ui::mojom::WindowShowState::kMinimized;
  }
  if (IsFullscreen()) {
    return ui::mojom::WindowShowState::kFullscreen;
  }
  if (IsMaximized()) {
    return ui::mojom::WindowShowState::kMaximized;
  }
  return ui::mojom::WindowShowState::kNormal;
}

BrowserView* HostedBrowserWindow::AsBrowserView() {
  return nullptr;
}

ExclusiveAccessContext* HostedBrowserWindow::GetExclusiveAccessContext() {
  return this;
}

Profile* HostedBrowserWindow::GetProfile() {
  return browser_ ? browser_->GetProfile() : nullptr;
}

void HostedBrowserWindow::EnterFullscreen(
    const url::Origin& origin,
    ExclusiveAccessBubbleType bubble_type,
    FullscreenTabParams fullscreen_tab_params) {
  tab_fullscreen_ = true;
  base::WeakPtr<HostedBrowserWindow> self = weak_factory_.GetWeakPtr();
  ReportFullscreenTab();
  if (self) {
    PostWindowFullscreenStateChanged();
  }
}

void HostedBrowserWindow::ExitFullscreen() {
  tab_fullscreen_ = false;
  ReportFullscreenTab();
}

void HostedBrowserWindow::PostWindowFullscreenStateChanged() {
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<HostedBrowserWindow> window) {
                       ExclusiveAccessManager* manager =
                           window ? window->GetExclusiveAccessManager()
                                  : nullptr;
                       if (manager && window->tab_fullscreen_) {
                         manager->fullscreen_controller()
                             ->WindowFullscreenStateChanged();
                       }
                     },
                     weak_factory_.GetWeakPtr()));
}

void HostedBrowserWindow::UpdateExclusiveAccessBubble(
    const ExclusiveAccessBubbleParams& params,
    ExclusiveAccessBubbleHideCallback first_hide_callback) {
  base::WeakPtr<HostedBrowserWindow> self = weak_factory_.GetWeakPtr();
  ReportFullscreenTab();
  if (!self) {
    return;
  }
  AppWindow* window = app_window();
  const bool can_show = window && window->widget() && browser_ &&
                        GetExclusiveAccessManager();
  const bool should_close_bubble =
      !can_show || (!params.has_download &&
                    params.type == EXCLUSIVE_ACCESS_BUBBLE_TYPE_NONE);
  if (should_close_bubble) {
    if (first_hide_callback) {
      std::move(first_hide_callback)
          .Run(ExclusiveAccessBubbleHideReason::kNotShown);
    }
    if (!exclusive_access_bubble_ ||
        exclusive_access_bubble_destruction_task_id_) {
      return;
    }
    exclusive_access_bubble_->HideImmediately();
    exclusive_access_bubble_destruction_task_id_ =
        exclusive_access_bubble_task_tracker_.PostTask(
            base::SingleThreadTaskRunner::GetCurrentDefault().get(),
            FROM_HERE,
            base::BindOnce(
                &HostedBrowserWindow::DestroyAnyExclusiveAccessBubble,
                weak_factory_.GetWeakPtr()));
    return;
  }
  if (exclusive_access_bubble_) {
    if (exclusive_access_bubble_destruction_task_id_) {
      exclusive_access_bubble_task_tracker_.TryCancel(
          *exclusive_access_bubble_destruction_task_id_);
      exclusive_access_bubble_destruction_task_id_.reset();
    }
    exclusive_access_bubble_->Update(params, std::move(first_hide_callback));
    return;
  }
  exclusive_access_bubble_ = std::make_unique<ExclusiveAccessBubbleViews>(
      this, params, std::move(first_hide_callback));
}

void HostedBrowserWindow::OnExclusiveAccessUserInput() {
  if (exclusive_access_bubble_) {
    exclusive_access_bubble_->OnUserInput();
  }
}

ExclusiveAccessManager* HostedBrowserWindow::GetExclusiveAccessManager() {
  return browser_ ? ExclusiveAccessManager::From(browser_) : nullptr;
}

ui::AcceleratorProvider* HostedBrowserWindow::GetAcceleratorProvider() {
  return this;
}

bool HostedBrowserWindow::GetAcceleratorForCommandId(
    int command_id,
    ui::Accelerator* accelerator) const {
  if (command_id != IDC_FULLSCREEN) {
    return false;
  }
  *accelerator = ui::Accelerator(ui::VKEY_F11, ui::EF_NONE);
  return true;
}

gfx::NativeView HostedBrowserWindow::GetBubbleParentView() const {
  AppWindow* window = app_window();
  return window && window->widget() ? window->widget()->GetNativeView()
                                    : gfx::NativeView();
}

gfx::Rect HostedBrowserWindow::GetClientAreaBoundsInScreen() const {
  AppWindow* window = app_window();
  return window && window->widget()
             ? window->widget()->GetClientAreaBoundsInScreen()
             : gfx::Rect();
}

bool HostedBrowserWindow::IsImmersiveModeEnabled() const {
  return false;
}

gfx::Rect HostedBrowserWindow::GetTopContainerBoundsInScreen() {
  return gfx::Rect();
}

void HostedBrowserWindow::RepositionExclusiveAccessBubble() {
  if (exclusive_access_bubble_) {
    exclusive_access_bubble_->RepositionIfVisible();
  }
}

void HostedBrowserWindow::DestroyAnyExclusiveAccessBubble() {
  exclusive_access_bubble_.reset();
  exclusive_access_bubble_destruction_task_id_.reset();
}

void HostedBrowserWindow::ReportFullscreenTab() {
  ExclusiveAccessManager* manager =
      browser_ ? ExclusiveAccessManager::From(browser_) : nullptr;
  FullscreenController* controller =
      manager ? manager->fullscreen_controller() : nullptr;
  content::WebContents* now = controller && controller->IsTabFullscreen()
                                  ? controller->exclusive_access_tab()
                                  : nullptr;
  content::WebContents* was = fullscreen_tab_.get();
  if (now == was) {
    return;
  }
  fullscreen_tab_ = now ? now->GetWeakPtr() : nullptr;
  if (was) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::WeakPtr<content::WebContents> left) {
                         content::RenderWidgetHostView* view =
                             left ? left->GetRenderWidgetHostView() : nullptr;
                         if (view && !left->IsFullscreen()) {
                           view->GetRenderWidgetHost()
                               ->SynchronizeVisualProperties();
                         }
                       },
                       was->GetWeakPtr()));
  }
}

bool HostedBrowserWindow::IsExclusiveAccessBubbleDisplayed() const {
  return exclusive_access_bubble_ && (exclusive_access_bubble_->IsShowing() ||
                                      exclusive_access_bubble_->IsVisible());
}

content::WebContents* HostedBrowserWindow::GetWebContentsForExclusiveAccess() {
  return browser_ ? browser_->GetTabStripModel()->GetActiveWebContents()
                  : nullptr;
}

bool HostedBrowserWindow::CanUserEnterFullscreen() const {
  return true;
}

bool HostedBrowserWindow::CanUserExitFullscreen() const {
  return true;
}

std::string HostedBrowserWindow::GetWorkspace() const {
  return std::string();
}

bool HostedBrowserWindow::IsVisibleOnAllWorkspaces() const {
  return false;
}

}
