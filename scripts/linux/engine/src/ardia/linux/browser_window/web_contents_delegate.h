// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_BROWSER_WINDOW_WEB_CONTENTS_DELEGATE_H_
#define ARDIA_LINUX_BROWSER_WINDOW_WEB_CONTENTS_DELEGATE_H_

#include <memory>

#include "base/values.h"
#include "chrome/browser/ui/browser_web_contents_delegate/browser_web_contents_delegate.h"

namespace ardia_linux {

class PageContentsDelegate : public BrowserWebContentsDelegate {
 public:
  PageContentsDelegate(BrowserWindowInterface* browser,
                       ExclusiveAccessManager& exclusive_access_manager,
                       chrome::BrowserCommandController& command_controller,
                       UnloadController& unload_controller,
                       web_app::AppBrowserController* app_browser_controller,
                       BrowserWindow& window,
                       DesktopBrowserWindowCapabilities& capabilities,
                       BrowserUiController& browser_ui_controller);
  PageContentsDelegate(const PageContentsDelegate&) = delete;
  PageContentsDelegate& operator=(const PageContentsDelegate&) = delete;
  ~PageContentsDelegate() override;

  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)>
          navigation_handle_callback) override;
  content::WebContents* AddNewContents(
      content::WebContents* source,
      std::unique_ptr<content::WebContents> new_contents,
      const GURL& target_url,
      WindowOpenDisposition disposition,
      const blink::mojom::WindowFeatures& window_features,
      bool user_gesture,
      bool* was_blocked) override;
  content::KeyboardEventProcessingResult PreHandleKeyboardEvent(
      content::WebContents* source,
      const input::NativeWebKeyboardEvent& event) override;
  bool HandleKeyboardEvent(content::WebContents* source,
                           const input::NativeWebKeyboardEvent& event) override;
  void UpdateTargetURL(content::WebContents* source, const GURL& url) override;
  void RendererUnresponsive(
      content::WebContents* source,
      content::RenderWidgetHost* render_widget_host,
      base::RepeatingClosure hang_monitor_restarter) override;
  void RendererResponsive(
      content::WebContents* source,
      content::RenderWidgetHost* render_widget_host) override;
  void CloseContents(content::WebContents* source) override;
};

std::unique_ptr<BrowserWebContentsDelegate> CreateWebContentsDelegate(
    BrowserWindowInterface* browser,
    ExclusiveAccessManager& exclusive_access_manager,
    chrome::BrowserCommandController& command_controller,
    UnloadController& unload_controller,
    web_app::AppBrowserController* app_browser_controller,
    BrowserWindow& window,
    DesktopBrowserWindowCapabilities& capabilities,
    BrowserUiController& browser_ui_controller);

const base::DictValue* PopupFeaturesOf(content::WebContents* contents);

}

#endif
