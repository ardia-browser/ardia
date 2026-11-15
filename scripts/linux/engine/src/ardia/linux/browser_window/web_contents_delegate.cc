// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/browser_window/web_contents_delegate.h"

#include <utility>

#include "ardia/linux/browser_window/browser_window.h"
#include "ardia/linux/host/host.h"
#include "ardia/win/tab_events.h"
#include "ardia/win/tab_state.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/unload_controller.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "third_party/blink/public/mojom/window_features/window_features.mojom.h"
#include "ui/base/window_open_disposition.h"
#include "ui/gfx/geometry/rect.h"

namespace ardia_linux {

namespace {

class PopupFeatures : public content::WebContentsUserData<PopupFeatures> {
 public:
  ~PopupFeatures() override = default;

  const base::DictValue& features() const { return features_; }
  void set_features(base::DictValue features) {
    features_ = std::move(features);
  }

 private:
  friend class content::WebContentsUserData<PopupFeatures>;
  explicit PopupFeatures(content::WebContents* contents)
      : content::WebContentsUserData<PopupFeatures>(*contents) {}

  base::DictValue features_;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(PopupFeatures);

bool IsWindowDisposition(WindowOpenDisposition disposition) {
  return disposition == WindowOpenDisposition::NEW_POPUP ||
         disposition == WindowOpenDisposition::NEW_WINDOW;
}

}

const base::DictValue* PopupFeaturesOf(content::WebContents* contents) {
  PopupFeatures* popup =
      contents ? PopupFeatures::FromWebContents(contents) : nullptr;
  return popup ? &popup->features() : nullptr;
}

PageContentsDelegate::PageContentsDelegate(
    BrowserWindowInterface* browser,
    ExclusiveAccessManager& exclusive_access_manager,
    chrome::BrowserCommandController& command_controller,
    UnloadController& unload_controller,
    web_app::AppBrowserController* app_browser_controller,
    BrowserWindow& window,
    DesktopBrowserWindowCapabilities& capabilities,
    BrowserUiController& browser_ui_controller)
    : BrowserWebContentsDelegate(browser,
                                 exclusive_access_manager,
                                 command_controller,
                                 unload_controller,
                                 app_browser_controller,
                                 window,
                                 capabilities,
                                 browser_ui_controller) {}

PageContentsDelegate::~PageContentsDelegate() = default;

content::WebContents* PageContentsDelegate::OpenURLFromTab(
    content::WebContents* source,
    const content::OpenURLParams& params,
    base::OnceCallback<void(content::NavigationHandle&)>
        navigation_handle_callback) {
  if (!IsWindowDisposition(params.disposition) &&
      params.disposition != WindowOpenDisposition::NEW_SPLIT_VIEW) {
    return BrowserWebContentsDelegate::OpenURLFromTab(
        source, params, std::move(navigation_handle_callback));
  }
  content::OpenURLParams tab_params(params);
  tab_params.disposition =
      params.disposition == WindowOpenDisposition::NEW_SPLIT_VIEW
          ? WindowOpenDisposition::NEW_BACKGROUND_TAB
          : WindowOpenDisposition::NEW_FOREGROUND_TAB;
  return BrowserWebContentsDelegate::OpenURLFromTab(
      source, tab_params, std::move(navigation_handle_callback));
}

content::WebContents* PageContentsDelegate::AddNewContents(
    content::WebContents* source,
    std::unique_ptr<content::WebContents> new_contents,
    const GURL& target_url,
    WindowOpenDisposition disposition,
    const blink::mojom::WindowFeatures& window_features,
    bool user_gesture,
    bool* was_blocked) {
  if (new_contents && disposition == WindowOpenDisposition::NEW_POPUP) {
    base::DictValue features;
    const gfx::Rect& bounds = window_features.bounds;
    if (window_features.has_x) {
      features.Set("x", bounds.x());
    }
    if (window_features.has_y) {
      features.Set("y", bounds.y());
    }
    if (window_features.has_width) {
      features.Set("width", bounds.width());
    }
    if (window_features.has_height) {
      features.Set("height", bounds.height());
    }
    PopupFeatures::CreateForWebContents(new_contents.get());
    PopupFeatures::FromWebContents(new_contents.get())
        ->set_features(std::move(features));
  }
  if (IsWindowDisposition(disposition)) {
    disposition = WindowOpenDisposition::NEW_FOREGROUND_TAB;
  }
  return BrowserWebContentsDelegate::AddNewContents(
      source, std::move(new_contents), target_url, disposition,
      window_features, user_gesture, was_blocked);
}

void PageContentsDelegate::UpdateTargetURL(content::WebContents* source,
                                           const GURL& url) {
  BrowserWebContentsDelegate::UpdateTargetURL(source, url);
  if (ardia_win::TabEvents* events =
          source ? ardia_win::TabEvents::FromWebContents(source) : nullptr) {
    events->TargetURLChanged(url);
  }
}

void PageContentsDelegate::RendererUnresponsive(
    content::WebContents* source,
    content::RenderWidgetHost* render_widget_host,
    base::RepeatingClosure hang_monitor_restarter) {
  if (ardia_win::TabEvents* events =
          source ? ardia_win::TabEvents::FromWebContents(source) : nullptr) {
    events->RendererUnresponsive(render_widget_host,
                                 std::move(hang_monitor_restarter));
  }
}

void PageContentsDelegate::RendererResponsive(
    content::WebContents* source,
    content::RenderWidgetHost* render_widget_host) {
  if (ardia_win::TabEvents* events =
          source ? ardia_win::TabEvents::FromWebContents(source) : nullptr) {
    events->RendererResponsive(render_widget_host);
  }
}

void PageContentsDelegate::CloseContents(content::WebContents* source) {
  ardia_win::TabState* state =
      source ? ardia_win::TabState::FromWebContents(source) : nullptr;
  if (!state || !state->closing_after_unload()) {
    BrowserWebContentsDelegate::CloseContents(source);
    return;
  }
  BrowserWindowInterface* browser =
      GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(source);
  if (!browser) {
    return;
  }
  if (!UnloadController::From(browser)->CanCloseContents(source)) {
    BrowserWebContentsDelegate::CloseContents(source);
    return;
  }
  Host::Get()->DeleteClosedTab(source);
}

std::unique_ptr<BrowserWebContentsDelegate> CreateWebContentsDelegate(
    BrowserWindowInterface* browser,
    ExclusiveAccessManager& exclusive_access_manager,
    chrome::BrowserCommandController& command_controller,
    UnloadController& unload_controller,
    web_app::AppBrowserController* app_browser_controller,
    BrowserWindow& window,
    DesktopBrowserWindowCapabilities& capabilities,
    BrowserUiController& browser_ui_controller) {
  if (!HostedBrowserWindow::FromWindow(&window)) {
    return nullptr;
  }
  return std::make_unique<PageContentsDelegate>(
      browser, exclusive_access_manager, command_controller,
      unload_controller, app_browser_controller, window, capabilities,
      browser_ui_controller);
}

}
