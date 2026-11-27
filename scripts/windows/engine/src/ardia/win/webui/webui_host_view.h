#ifndef ARDIA_WIN_WEBUI_WEBUI_HOST_VIEW_H_
#define ARDIA_WIN_WEBUI_WEBUI_HOST_VIEW_H_

#include <windows.h>

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "ardia/desktop/ac_desktop_webui_process_policy.h"
#include "ardia/win/webui/desktop_platform_win.h"
#include "ardia/win/webui/webui_documents.h"
#include "ardia/win/webui/webui_frame.h"
#include "ardia/win/webui/webui_telemetry.h"
#include "ardia/win/webui/webui_window_policy.h"
#include "base/callback_list.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/base/accelerators/accelerator.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/native_ui_types.h"
#include "ui/views/controls/webview/unhandled_keyboard_event_handler.h"
#include "ui/views/view.h"
#include "ui/views/view_observer.h"
#include "ui/views/view_targeter_delegate.h"
#include "ui/views/widget/widget_observer.h"

class BrowserView;
class BrowserWindowInterface;
class GURL;
class Profile;

namespace aura {
class Window;
class WindowTargeter;
}

namespace content {
class WebContents;
class WebUI;
}

namespace views {
class FocusManager;
class WebView;
}

namespace ardia_win::webui {

class FilePicker;
class ShellBridge;
class ShellHostView;
class ShellRecovery;
class ShellTransparency;

struct WindowConfig {
  WindowConfig();
  WindowConfig(WindowConfig&&);
  WindowConfig& operator=(WindowConfig&&);
  ~WindowConfig();

  std::string window_id;
  webui_window::WindowKind kind = webui_window::WindowKind::kBrowser;
  bool startup = false;
  bool chrome_made = false;
  bool focus = true;
  std::optional<bool> maximized;
  std::string page_profile;
  base::DictValue private_window;
  base::DictValue small_window;
  base::DictValue utility;
  int opener = 0;
};

class PageBinding : public content::WebContentsObserver {
 public:
  PageBinding(ShellHostView* owner,
              content::WebContents* contents,
              std::string key,
              std::string profile);
  PageBinding(const PageBinding&) = delete;
  PageBinding& operator=(const PageBinding&) = delete;
  ~PageBinding() override;

  int id() const { return id_; }
  const std::string& key() const { return key_; }
  const std::string& profile() const { return profile_; }
  content::WebContents* contents() const { return web_contents(); }
  void MoveTo(ShellHostView* owner);

  std::string claim;
  uint64_t renderer_generation = 0;
  uint64_t sequence = 1;
  uint64_t binding_generation = 1;
  raw_ptr<views::WebView> viewport = nullptr;
  bool visible = false;
  bool presented = false;
  bool transferable = false;

  void Rebind(content::WebContents* contents);
  bool ReportOpenPrivateWindow(const GURL& url, const std::string& profile);
  base::DictValue NavigationEvent() const;
  base::DictValue Envelope(std::string_view type);
  void ReportNavigation();
  void ReportClosed();

 private:
  void DidFinishNavigation(content::NavigationHandle* handle) override;
  void TitleWasSet(content::NavigationEntry* entry) override;
  void DidStartLoading() override;
  void DidStopLoading() override;
  void WebContentsDestroyed() override;

  raw_ptr<ShellHostView> owner_;
  int id_ = 0;
  std::string key_;
  std::string profile_;
};

class ShellHostView : public views::View,
                      public views::ViewTargeterDelegate,
                      public views::ViewObserver,
                      public views::WidgetObserver,
                      public TabStripModelObserver,
                      public content::WebContentsDelegate {
  METADATA_HEADER(ShellHostView, views::View)

 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;

  ShellHostView(BrowserWindowInterface* browser,
                BrowserView* browser_view,
                Profile* app_profile,
                WindowConfig config);
  ShellHostView(const ShellHostView&) = delete;
  ShellHostView& operator=(const ShellHostView&) = delete;
  ~ShellHostView() override;

  void Initialize();
  void DetachBrowser();

  int id() const { return id_; }
  const std::string& window_id() const { return config_.window_id; }
  webui_window::WindowKind kind() const { return config_.kind; }
  bool is_utility() const { return webui_window::IsUtility(config_.kind); }
  bool private_window() const;
  bool chrome_made() const { return config_.chrome_made; }
  const std::string& page_profile_id() const { return config_.page_profile; }
  int opener() const { return config_.opener; }
  int private_ordinal() const { return private_ordinal_; }
  void set_private_ordinal(int ordinal) { private_ordinal_ = ordinal; }
  bool closing() const { return closing_; }
  BrowserWindowInterface* browser() const { return browser_; }
  Profile* app_profile() const { return app_profile_; }
  Profile* page_profile() const;
  content::WebContents* shell_contents() const;
  base::WeakPtr<ShellHostView> GetWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

  std::vector<BrowserWindowInterface*> Members() const;
  BrowserWindowInterface* MemberFor(const Profile* profile) const;
  BrowserWindowInterface* OwnerOf(const content::WebContents* contents) const;
  bool OwnsCompanion(const BrowserWindowInterface* browser) const;
  void CompanionClosed(BrowserWindowInterface* companion);
  bool BindsTab(const content::WebContents* contents) const;
  PageBinding* BindingForKey(std::string_view key) const;
  PageBinding* BindingForContents(const content::WebContents* contents) const;
  std::unique_ptr<PageBinding> TakeBinding(int id);

  bool Trusted(content::WebUI* ui) const;
  uint64_t SetHandler(ShellBridge* handler, content::WebUI* ui);
  bool OwnsHandler(const ShellBridge* handler, uint64_t generation) const;
  void ClearHandler(ShellBridge* handler);
  uint64_t renderer_generation() const { return renderer_generation_; }
  void DeliverReply(base::WeakPtr<ShellBridge> handler,
                    uint64_t generation,
                    std::string id,
                    bool success,
                    base::Value response);
  void Emit(std::string_view module, std::string_view event, base::Value payload);
  void NoteRequest(base::WeakPtr<ShellBridge> handler, uint64_t generation);

  std::string BootstrapJson() const;
  void NoteAssetServed(std::string_view asset) {
    launch_bootstrap_.Served(asset);
  }
  void Invoke(const std::string& method, const base::DictValue& args, Done done);
  void EngineCall(const std::string& name,
                  const std::string& profile,
                  const base::Value* args,
                  Done done);
  bool PreTranslate(const MSG& msg);
  void Note(const std::string& line) const;

  void BindingGone(PageBinding* binding);
  void FocusWindow();
  void BroadcastProfileLoaded(const std::string& profile);
  void PrivateWindowsChanged();
  void OpenUrls(base::ListValue urls);
  bool TakesOpenUrls() const;
  bool OpenUrlsListening() const;
  void RequestClose();
  bool InterceptSystemClose();
  bool OpenPrivateLink(content::WebContents* contents, const GURL& url);
  void NavigateUtility(base::DictValue utility);
  void ResetUnloadConfirmations();
  bool RequestPrivateWindow(const GURL& url);
  bool LiveFor(uint64_t generation) const;
  void RememberPlacement();

  bool HasPassRegions() const;
  bool IsPageChildWindow(aura::Window* window) const;
  bool PassesShellPoint(gfx::NativeView child, const gfx::Point& location) const;

  bool AcceleratorPressed(const ui::Accelerator& accelerator) override;
  bool CanHandleAccelerators() const override;

  bool HandleKeyboardEvent(content::WebContents* source,
                           const input::NativeWebKeyboardEvent& event) override;
  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)>
          navigation_handle_callback) override;

 private:
  friend class PageBinding;
  friend class ShellBridge;

  struct CompanionConfirmation {
    CompanionConfirmation();
    ~CompanionConfirmation();
    std::vector<base::WeakPtr<BrowserWindowInterface>> browsers;
    size_t next = 0;
    base::OnceCallback<void(bool)> done;
  };

  bool CompanionsHoldTabs() const;
  void ConfirmWindowUnload(base::OnceCallback<void(bool)> done);
  static void ConfirmNextCompanion(
      std::shared_ptr<CompanionConfirmation> confirmation,
      std::weak_ptr<base::RepeatingClosure> self);
  static void FinishCompanionConfirmation(
      std::shared_ptr<CompanionConfirmation> confirmation,
      bool proceed);
  void ReplaceTabContents(content::WebContents* old_contents,
                          content::WebContents* contents);

  static bool CommandFocusesShell(const std::string& command);
  aura::Window* ChildWindowOf(views::WebView* view) const;
  void LayoutOverlay();
  void ApplyShellInput();
  void Restack();
  void ReattachViewports();
  void FocusShell();
  void RetireRenderer();
  void Decorate();
  base::DictValue DecorationReport() const;
  void EmitMaximizeButtonState(const MaximizeButtonVisualState& state);
  void ToggleMaximize();
  base::DictValue WindowState() const;
  base::ListValue WindowFrame() const;
  void ReportWindowState();
  void WatchSystemState();
  void NoteUnhandled(const std::string& method);
  views::Widget* widget() const;
  HWND Hwnd() const;

  BrowserWindowInterface* EnsureMember(Profile* profile);
  void ObserveMember(BrowserWindowInterface* member);
  void CloseCompanions();
  void SelectProfile(Profile* profile);

  PageBinding* ClaimedBinding(const base::DictValue& args) const;
  void CreateTab(const base::DictValue& args, Done done);
  void StartTab(base::DictValue args,
                Done done,
                base::WeakPtr<ShellBridge> origin,
                uint64_t generation);
  void CreateTabIn(base::DictValue args,
                   Done done,
                   base::WeakPtr<ShellBridge> origin,
                   uint64_t generation,
                   Profile* profile);
  base::DictValue Identity(PageBinding* binding) const;
  void SetViewport(const base::DictValue& args, Done done);
  void SetPresentations(const base::DictValue& args, Done done);
  void TabCommand(const base::DictValue& args, Done done);
  void ReleaseTab(const base::DictValue& args, Done done);
  void CloseTab(const base::DictValue& args, Done done);
  void CloseContents(content::WebContents* contents) override;
  void SetInputRegions(const base::DictValue& args, Done done);
  void SetKeyboardShortcuts(const base::ListValue* values, Done done);
  void SetActiveProfile(const base::ListValue* values, Done done);
  void ListUnclaimedTabs(Done done);
  void ClaimLaunchTab(const base::ListValue* values, Done done);
  void PrepareTransfer(const base::ListValue* values, bool transferable, Done done);
  void CopyText(const base::ListValue* values, Done done);
  void ReadText(Done done);
  void DocumentCall(webui_window::DocumentVerb verb,
                    base::DictValue request,
                    Done done);
  bool EnsureDocumentClient();
  void RetireDocuments();

  void NoteUnclaimedTab(content::WebContents* contents, bool active);
  void AnnounceUnclaimedTab(int id, int tries);
  base::DictValue UnclaimedOffer(content::WebContents* contents, bool active) const;

  void OnViewBoundsChanged(views::View* observed_view) override;
  void OnViewIsDeleting(views::View* observed_view) override;
  bool DoesIntersectRect(const views::View* target,
                         const gfx::Rect& rect) const override;

  void OnWidgetBoundsChanged(views::Widget* widget,
                             const gfx::Rect& bounds) override;
  void OnWidgetShowStateChanged(views::Widget* widget) override;
  void OnWidgetActivationChanged(views::Widget* widget, bool active) override;
  void OnWidgetThemeChanged(views::Widget* widget) override;
  void OnWidgetClosing(views::Widget* widget) override;
  void OnWidgetDestroying(views::Widget* widget) override;

  void OnTabStripModelChanged(TabStripModel* tab_strip_model,
                              const TabStripModelChange& change,
                              const TabStripSelectionChange& selection) override;

  raw_ptr<BrowserWindowInterface> browser_;
  raw_ptr<BrowserView> browser_view_;
  raw_ptr<Profile> app_profile_;
  WindowConfig config_;
  ardia::desktop_webui_process::LaunchBootstrap launch_bootstrap_;
  int id_ = 0;
  int private_ordinal_ = 0;
  bool closing_ = false;
  bool utility_ready_ = false;
  bool close_confirming_ = false;
  std::vector<std::shared_ptr<base::RepeatingClosure>> confirmation_steps_;
  bool creating_tab_ = false;
  bool painted_ = false;
  std::vector<base::WeakPtr<BrowserWindowInterface>> companions_;
  base::WeakPtr<Profile> active_profile_;
  webui_window::SelectionSequence selection_;

  raw_ptr<views::WebView> shell_ = nullptr;
  std::unique_ptr<ShellTransparency> transparency_;
  std::unique_ptr<ShellRecovery> recovery_;
  std::vector<gfx::Rect> pass_;
  size_t logged_pass_regions_ = static_cast<size_t>(-1);
  std::map<int, std::unique_ptr<PageBinding>> bindings_;

  raw_ptr<ShellBridge> handler_ = nullptr;
  content::WeakDocumentPtr renderer_document_;
  uint64_t renderer_generation_ = 1;
  base::WeakPtr<ShellBridge> request_handler_;
  uint64_t request_generation_ = 0;
  size_t dropped_replies_ = 0;

  raw_ptr<views::FocusManager> focus_manager_ = nullptr;
  std::map<ui::Accelerator, base::DictValue> shortcuts_;
  views::UnhandledKeyboardEventHandler unhandled_keys_;

  std::unique_ptr<aura::WindowTargeter> original_targeter_;
  std::unique_ptr<CaptionInput> caption_;
  ShellDecorations decorations_;
  std::optional<bool> reported_maximized_;
  std::optional<bool> reported_full_screen_;
  base::CallbackListSubscription system_state_subscription_;
  WinTelemetryClient telemetry_;
  std::unique_ptr<FilePicker> file_picker_;

  std::shared_ptr<DocumentAuthority> documents_;
  ardia::LinuxDocumentClient document_client_;
  uint64_t document_client_generation_ = 0;
  webui_window::DocumentSubscription document_subscription_;

  std::map<int, base::WeakPtr<content::WebContents>> unclaimed_;
  std::map<int, base::WeakPtr<content::WebContents>> announced_;
  std::optional<uint64_t> unclaimed_listener_;
  int pending_active_offer_ = 0;
  std::optional<uint64_t> open_urls_listener_;

  std::vector<std::string> unhandled_;

  base::ScopedObservation<views::View, views::ViewObserver> view_observation_{
      this};
  base::ScopedObservation<views::Widget, views::WidgetObserver>
      widget_observation_{this};
  base::WeakPtrFactory<ShellHostView> weak_factory_{this};
};

}

#endif
