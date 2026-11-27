#include "ardia/mac/ac_mac_page_delegate.h"

#include <memory>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include "ardia/core/ac_hooks.h"
#include "ardia/mac/ac_mac_link_gesture.h"
#include "ardia/mac/ac_mac_page_events.h"
#include "ardia/mac/ac_mac_page_policy.h"
#include "ardia/mac/ac_mac_shell_host.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/ui/browser_web_contents_delegate/browser_web_contents_delegate.h"
#include "components/permissions/permission_prompt.h"
#include "components/permissions/permission_request.h"
#include "components/permissions/resolvers/permission_prompt_options.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/file_select_listener.h"
#include "content/public/browser/javascript_dialog_manager.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/javascript_dialog_type.h"
#include "third_party/blink/public/mojom/choosers/file_chooser.mojom.h"
#include "third_party/blink/public/mojom/window_features/window_features.mojom.h"
#include "ui/base/window_open_disposition.h"
#include "ui/gfx/geometry/rect.h"

namespace ardia_mac {

namespace {

PageBinding* BindingFor(const content::WebContents* contents) {
  for (ShellHostView* host : Hosts()) {
    if (PageBinding* binding = host->BindingForContents(contents)) {
      return binding;
    }
  }
  return nullptr;
}

PageEvents* EventsFor(const content::WebContents* contents) {
  PageBinding* binding = BindingFor(contents);
  return binding ? binding->events() : nullptr;
}

const char* DialogKind(content::JavaScriptDialogType type) {
  switch (type) {
    case content::JAVASCRIPT_DIALOG_TYPE_ALERT:
      return "alert";
    case content::JAVASCRIPT_DIALOG_TYPE_CONFIRM:
      return "confirm";
    case content::JAVASCRIPT_DIALOG_TYPE_PROMPT:
      return "prompt";
  }
  return "dialog";
}

class BackgroundDialogs : public content::JavaScriptDialogManager {
 public:
  void RunJavaScriptDialog(content::WebContents* web_contents,
                           content::RenderFrameHost* render_frame_host,
                           content::JavaScriptDialogType dialog_type,
                           const std::u16string& message_text,
                           const std::u16string& default_prompt_text,
                           DialogClosedCallback callback,
                           bool* did_suppress_message) override {
    Trace(std::string("JavaScript ") + DialogKind(dialog_type) +
          " (background run, not shown): " +
          base::NumberToString(message_text.size()) + " characters");
    const bool accepted = dialog_type == content::JAVASCRIPT_DIALOG_TYPE_ALERT;
    std::move(callback).Run(accepted, std::u16string());
  }

  void RunBeforeUnloadDialog(content::WebContents* web_contents,
                             content::RenderFrameHost* render_frame_host,
                             bool is_reload,
                             DialogClosedCallback callback) override {
    Trace(std::string("leave-page dialog (background run, not shown): ") +
          (is_reload ? "reload" : "leave"));
    std::move(callback).Run(true, std::u16string());
  }

  void CancelDialogs(content::WebContents* web_contents,
                     bool reset_state) override {}
};

content::JavaScriptDialogManager* Dialogs() {
  static base::NoDestructor<BackgroundDialogs> dialogs;
  return dialogs.get();
}

class PageDelegate : public BrowserWebContentsDelegate {
 public:
  PageDelegate(BrowserWindowInterface* browser,
               ExclusiveAccessManager& exclusive_access_manager,
               chrome::BrowserCommandController& command_controller,
               UnloadController& unload_controller,
               web_app::AppBrowserController* app_browser_controller,
               BrowserWindow& window,
               DesktopBrowserWindowCapabilities& capabilities,
               BrowserUiController& browser_ui_controller)
      : BrowserWebContentsDelegate(browser, exclusive_access_manager, command_controller,
                                   unload_controller, app_browser_controller, window, capabilities,
                                   browser_ui_controller),
        browser_(browser) {}

  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)> navigation_handle_callback) override {
    if (source && InterceptLinkOpen(source, params)) {
      return nullptr;
    }
    const WindowOpenDisposition disposition = OpeningDisposition(source, params);
    if (disposition == params.disposition) {
      return BrowserWebContentsDelegate::OpenURLFromTab(source, params,
                                                        std::move(navigation_handle_callback));
    }
    content::OpenURLParams as_tab = params;
    as_tab.disposition = disposition;
    return BrowserWebContentsDelegate::OpenURLFromTab(source, as_tab,
                                                      std::move(navigation_handle_callback));
  }

  content::WebContents* AddNewContents(content::WebContents* source,
                                       std::unique_ptr<content::WebContents> new_contents,
                                       const GURL& target_url,
                                       WindowOpenDisposition disposition,
                                       const blink::mojom::WindowFeatures& window_features,
                                       bool user_gesture,
                                       bool* was_blocked) override {
    return BrowserWebContentsDelegate::AddNewContents(
        source, std::move(new_contents), target_url, PopupDisposition(source, disposition),
        window_features, user_gesture, was_blocked);
  }

  void UpdateTargetURL(content::WebContents* source, const GURL& url) override {
    NoteLinkTarget(source, url);
    if (PageEvents* events = EventsFor(source); events && events->TargetURL(url)) {
      return;
    }
    BrowserWebContentsDelegate::UpdateTargetURL(source, url);
  }

  void RendererUnresponsive(content::WebContents* source,
                            content::RenderWidgetHost* render_widget_host,
                            base::RepeatingClosure hang_monitor_restarter) override {
    if (PageEvents* events = EventsFor(source);
        events && events->Unresponsive(render_widget_host, hang_monitor_restarter)) {
      return;
    }
    BrowserWebContentsDelegate::RendererUnresponsive(
        source, render_widget_host, std::move(hang_monitor_restarter));
  }

  void RendererResponsive(content::WebContents* source,
                          content::RenderWidgetHost* render_widget_host) override {
    if (PageEvents* events = EventsFor(source);
        events && events->Responsive(render_widget_host)) {
      return;
    }
    BrowserWebContentsDelegate::RendererResponsive(source, render_widget_host);
  }

  content::JavaScriptDialogManager* GetJavaScriptDialogManager(
      content::WebContents* source) override {
    if (BackgroundInstance() && BindingFor(source)) {
      return Dialogs();
    }
    return BrowserWebContentsDelegate::GetJavaScriptDialogManager(source);
  }

  void RunFileChooser(content::RenderFrameHost* render_frame_host,
                      scoped_refptr<content::FileSelectListener> listener,
                      const blink::mojom::FileChooserParams& params) override {
    if (BackgroundInstance()) {
      Trace(std::string(params.mode == blink::mojom::FileChooserParams::Mode::kSave
                            ? "save"
                            : "open") +
            " file dialog (background run, not shown)");
      listener->FileSelectionCanceled();
      return;
    }
    BrowserWebContentsDelegate::RunFileChooser(render_frame_host,
                                               std::move(listener), params);
  }

  bool HandleContextMenu(content::RenderFrameHost& render_frame_host,
                         const content::ContextMenuParams& params) override {
    if (!BackgroundInstance()) {
      return BrowserWebContentsDelegate::HandleContextMenu(render_frame_host,
                                                           params);
    }
    Trace("page context menu (background run, not shown) at " +
          base::NumberToString(params.x) + "," + base::NumberToString(params.y));
    return true;
  }

 private:
  raw_ptr<BrowserWindowInterface> browser_;
};

std::unique_ptr<BrowserWebContentsDelegate> CreatePageDelegate(
    BrowserWindowInterface* browser,
    ExclusiveAccessManager& exclusive_access_manager,
    chrome::BrowserCommandController& command_controller,
    UnloadController& unload_controller,
    web_app::AppBrowserController* app_browser_controller,
    BrowserWindow& window,
    DesktopBrowserWindowCapabilities& capabilities,
    BrowserUiController& browser_ui_controller) {
  return std::make_unique<PageDelegate>(
      browser, exclusive_access_manager, command_controller, unload_controller,
      app_browser_controller, window, capabilities, browser_ui_controller);
}

class BackgroundPermissionPrompt : public permissions::PermissionPrompt {
 public:
  explicit BackgroundPermissionPrompt(permissions::PermissionPrompt::Delegate* delegate)
      : delegate_(delegate) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&BackgroundPermissionPrompt::Dismiss,
                                  weak_factory_.GetWeakPtr()));
  }
  BackgroundPermissionPrompt(const BackgroundPermissionPrompt&) = delete;
  BackgroundPermissionPrompt& operator=(const BackgroundPermissionPrompt&) = delete;
  ~BackgroundPermissionPrompt() override = default;

  bool UpdateAnchor() override { return true; }
  TabSwitchingBehavior GetTabSwitchingBehavior() override {
    return TabSwitchingBehavior::kKeepPromptAlive;
  }
  permissions::PermissionPromptDisposition GetPromptDisposition() const override {
    return permissions::PermissionPromptDisposition::NONE_VISIBLE;
  }
  bool IsAskPrompt() const override { return false; }
  std::optional<gfx::Rect> GetViewBoundsInScreen() const override {
    return std::nullopt;
  }
  std::vector<permissions::ElementAnchoredBubbleVariant> GetPromptVariants()
      const override {
    return {};
  }
  std::optional<permissions::feature_params::PermissionElementPromptPosition>
  GetPromptPosition() const override {
    return std::nullopt;
  }

 private:
  void Dismiss() {
    if (delegate_->GetCurrentPrompt() != this || delegate_->Requests().empty()) {
      return;
    }
    delegate_->Dismiss(PromptOptions(std::monostate()));
  }

  raw_ptr<permissions::PermissionPrompt::Delegate> delegate_;
  base::WeakPtrFactory<BackgroundPermissionPrompt> weak_factory_{this};
};

std::unique_ptr<permissions::PermissionPrompt> CreatePermissionPrompt(
    content::WebContents* web_contents,
    permissions::PermissionPrompt::Delegate* delegate,
    bool* default_handling) {
  if (!delegate || page_policy::PromptHandlingFor(BackgroundInstance(),
                                                  BindingFor(web_contents) != nullptr) !=
                       page_policy::PromptHandling::kDismissWithoutUi) {
    return nullptr;
  }
  Trace("permission prompt (background run, not shown): " +
        base::NumberToString(delegate->Requests().size()) + " requests dismissed");
  return std::make_unique<BackgroundPermissionPrompt>(delegate);
}

}

void AssertPageHooks() {
  if (g_ardia_create_web_contents_delegate != &CreatePageDelegate) {
    g_ardia_create_web_contents_delegate = &CreatePageDelegate;
  }
  if (g_ardia_create_permission_prompt != &CreatePermissionPrompt) {
    g_ardia_create_permission_prompt = &CreatePermissionPrompt;
  }
}

void InstallPageDelegate() {
  AssertPageHooks();
  InstallLinkHooks();
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce([] {
        base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
            FROM_HERE, base::BindOnce(&AssertPageHooks));
      }));
}

}
