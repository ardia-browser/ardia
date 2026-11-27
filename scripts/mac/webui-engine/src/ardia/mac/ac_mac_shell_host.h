#ifndef ARDIA_MAC_AC_MAC_SHELL_HOST_H_
#define ARDIA_MAC_AC_MAC_SHELL_HOST_H_

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "ardia/mac/ac_mac_documents.h"
#include "ardia/mac/ac_mac_glass_layout.h"
#include "ardia/mac/ac_mac_menu.h"
#include "ardia/mac/ac_mac_shell_policy.h"
#include "ardia/mac/ac_mac_window_events.h"
#include "ardia/mac/ac_mac_window_policy.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/base/accelerators/accelerator.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/native_ui_types.h"
#include "ui/views/controls/webview/unhandled_keyboard_event_handler.h"
#include "ui/views/view.h"
#include "ui/views/view_observer.h"

namespace base {
class SequencedTaskRunner;
}

class BrowserView;
class BrowserWindowInterface;
class GURL;
class Profile;

namespace content {
class WebContents;
class WebUI;
}

namespace views {
class FocusManager;
class WebView;
}

namespace ardia_mac {

class DialogSheets;
class ExtensionViews;
class GlassRegions;
class PageCommands;
class PageEvents;
class PageLinks;
class PipPresenter;
class PopoverHost;
class ScrollGestures;
class SystemServices;

namespace shared_folders {
class Watcher;
}

class ShellBridge;
class ShellHostView;

std::string Text(const base::DictValue& value, std::string_view key);
const base::ListValue* Arguments(const base::DictValue& value);
base::Value Failure(std::string_view code, std::string_view message);
std::optional<gfx::Rect> RectFrom(const base::DictValue* rect);
std::optional<glass::Rect> GlassRectFrom(const base::DictValue* rect);
std::optional<GURL> AllowedPageUrl(const std::string& requested);
int TabId(const content::WebContents* contents);
void WithProfile(std::string_view name,
                 base::OnceCallback<void(Profile*)> callback);
std::string ProfileName(const Profile* profile);
base::FilePath DataDirectory();
base::FilePath AssetDirectory();
struct WindowSpec {
  std::string id = "main";
  std::string kind = "browser";
  std::string title;
  std::string page_profile;
  bool startup = true;
  base::DictValue utility;
};

struct MergedSession {
  bool ok = false;
  bool blocked = false;
  base::DictValue previous;
  base::DictValue session;
};

scoped_refptr<base::SequencedTaskRunner> SessionFiles();
MergedSession MergeAndWriteSession(base::DictValue base, base::DictValue local);
void BroadcastSession(const MergedSession& merged,
                      const std::string& source_window,
                      const base::DictValue* source_base);

std::vector<ShellHostView*>& Hosts();
ShellHostView* HostForWindow(std::string_view id);
struct OpenPlacement {
  bool focus = true;
  bool maximized = false;
  std::string behind;
};

ShellHostView* OpenShellWindow(Profile* profile,
                               WindowSpec spec,
                               std::optional<gfx::Rect> frame,
                               const OpenPlacement& placement = OpenPlacement());
ShellHostView* HostForShell(content::WebContents* contents);
ShellHostView* HostForPopover(content::WebContents* contents);
MenuCommandHandler MainMenuHandler();
MenuWindowResolver ShellMenuWindows();
bool BackgroundInstance();
std::optional<std::string> BootstrapScript(const std::string& bootstrap_json,
                                           const char* host_bootstrap);
void Trace(const std::string& line);
std::vector<std::string_view> LifecycleCapabilities();
void QuitWithoutShell();

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
  ShellHostView* host() const { return owner_; }
  PageEvents* events() const { return events_.get(); }
  PageCommands* commands() const { return commands_.get(); }
  PageLinks* links() const { return links_.get(); }

  std::string claim;
  uint64_t renderer_generation = 0;
  uint64_t sequence = 1;
  uint64_t binding_generation = 1;
  raw_ptr<views::WebView> viewport = nullptr;
  bool visible = false;
  bool presented = false;

  base::DictValue NavigationEvent() const;
  base::DictValue Envelope(std::string_view type);
  base::DictValue CreationState();
  void Rebind(content::WebContents* contents);
  void ReportNavigation();
  void ReportClosed();
  void Report(std::string_view name, base::Value data);

 private:
  void DidFinishNavigation(content::NavigationHandle* handle) override;
  void TitleWasSet(content::NavigationEntry* entry) override;
  void DidStartLoading() override;
  void DidStopLoading() override;
  void DidChangeThemeColor() override;
  void WebContentsDestroyed() override;

  raw_ptr<ShellHostView> owner_;
  int id_ = 0;
  std::string key_;
  std::string profile_;
  std::unique_ptr<PageEvents> events_;
  std::unique_ptr<PageCommands> commands_;
  std::unique_ptr<PageLinks> links_;
};

class ShellHostView : public views::View,
                      public views::ViewObserver,
                      public TabStripModelObserver,
                      public content::WebContentsDelegate {
  METADATA_HEADER(ShellHostView, views::View)

 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;

  ShellHostView(BrowserWindowInterface* browser,
                BrowserView* browser_view,
                Profile* app_profile,
                WindowSpec spec);
  ShellHostView(const ShellHostView&) = delete;
  ShellHostView& operator=(const ShellHostView&) = delete;
  ~ShellHostView() override;

  void Initialize();
  void DetachBrowser();

  const std::string& window_id() const { return window_id_; }
  bool is_utility() const { return shell_policy::UtilityKind(kind_); }
  bool is_small() const { return kind_ == shell_policy::kSmallWindowKind; }
  std::optional<gfx::PointF> ShellPointFor(const PageBinding* binding, gfx::PointF page_point) const;
  PageBinding* BindingHit(gfx::NativeView hit) const;
  void NavigateUtility(base::DictValue utility);
  void ActivateWindow();
  void ForwardRecordedKey(const input::NativeWebKeyboardEvent& event);
  BrowserWindowInterface* browser() const { return browser_; }
  Profile* app_profile() const { return app_profile_; }
  content::WebContents* shell_contents() const;
  base::WeakPtr<ShellHostView> GetWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

  std::vector<BrowserWindowInterface*> Members() const;
  BrowserWindowInterface* OwnerOf(const content::WebContents* contents) const;
  bool OwnsCompanion(const BrowserWindowInterface* browser) const;
  PageBinding* BindingForKey(std::string_view key) const;
  PageBinding* BindingForContents(const content::WebContents* contents) const;

  bool Trusted(content::WebUI* ui) const;
  uint64_t SetHandler(ShellBridge* handler, content::WebUI* ui);
  bool OwnsHandler(const ShellBridge* handler, uint64_t generation) const;
  void ClearHandler(ShellBridge* handler);
  void DeliverReply(base::WeakPtr<ShellBridge> handler,
                    uint64_t generation,
                    std::string id,
                    bool success,
                    base::Value response);
  void Emit(std::string_view module, std::string_view event, base::Value payload);
  void NoteRequest(base::WeakPtr<ShellBridge> handler, uint64_t generation);

  std::string BootstrapJson() const;
  std::optional<std::string> PopoverBootstrapJson(
      const content::WebContents* contents) const;
  PopoverHost* popovers() const { return popovers_.get(); }
  std::unique_ptr<shared_folders::Watcher>& shared_folder_watcher() {
    return shared_folder_watcher_;
  }
  SystemServices* system() const { return system_.get(); }
  ExtensionViews* extension_views() const { return extension_views_.get(); }
  PipPresenter* pip() const { return pip_.get(); }
  void EmitShellEvent(std::string_view name, base::Value data);
  void OnMenuCommand(const std::string& command, const std::string& argument);
  void Invoke(const std::string& method, const base::DictValue& args, Done done);
  void EngineCall(const std::string& name,
                  const std::string& profile,
                  const base::Value* args,
                  Done done);

  void BindingGone(PageBinding* binding);
  BrowserWindowInterface* EnsureMember(Profile* profile);
  bool OwnsShellNativeView(gfx::NativeView view) const;
  bool PassesShellPoint(double x, double y) const;
  gfx::NativeView LiveShellView(const content::WeakDocumentPtr& document,
                                uint64_t generation) const;
  void Note(const std::string& line) const;

  bool HandlesLifecycleCall(const std::string& method) const;
  void LifecycleCall(const std::string& method, const base::DictValue& args, Done done);
  base::DictValue RequestWindowClose(std::uint64_t quit_generation);
  bool RendererLive() const;
  bool shortcut_recording() const { return shortcut_recording_; }

  bool AcceleratorPressed(const ui::Accelerator& accelerator) override;
  bool CanHandleAccelerators() const override;
  bool HandleKeyboardEvent(content::WebContents* source,
                           const input::NativeWebKeyboardEvent& event) override;

 private:
  friend class ExtensionViews;
  friend class PageBinding;
  friend class PipPresenter;
  friend class ScrollGestures;
  friend class SystemServices;

  void LayoutOverlay();
  void Restack();
  void ReattachViewports();
  void FocusShell();
  void RetireRenderer();
  void NoteUnhandled(const std::string& method);
  void CloseCompanions();

  PageBinding* ClaimedBinding(const base::DictValue& args) const;
  void CreateTab(const base::DictValue& args, Done done);
  void CreateTabIn(base::DictValue args,
                   Done done,
                   base::WeakPtr<ShellBridge> origin,
                   uint64_t generation,
                   Profile* profile);
  base::DictValue Identity(PageBinding* binding) const;
  void ReplaceBinding(content::WebContents* old_contents,
                      content::WebContents* contents);
  void DropDetachedBinding(int id, base::WeakPtr<content::WebContents> contents);
  void SetViewport(const base::DictValue& args, Done done);
  void SetPresentations(const base::DictValue& args, Done done);
  void TabCommand(const base::DictValue& args, Done done);
  void ReleaseTab(const base::DictValue& args, Done done);
  void CloseTab(const base::DictValue& args, Done done);
  void CloseContents(content::WebContents* contents) override;
  void SetInputRegions(const base::DictValue& args, Done done);
  void SetKeyboardShortcuts(const base::ListValue* values, Done done);
  void SetGlassRegions(const base::DictValue& args, Done done);
  void SetBackdropRegions(const base::DictValue& args, Done done);
  void UpdateGlassSurface();
  double ShellZoom() const;
  void PopoverCall(const std::string& method, const base::DictValue& args, Done done);
  void SetMainMenu(const base::DictValue& args, Done done);
  void ShowShellContextMenu(const base::DictValue& args, Done done);
  void SetTrafficLights(const base::DictValue& args, Done done);
  void OpenWindow(const base::ListValue* values, Done done);
  void WriteSession(const base::DictValue& args, Done done);
  void WatchRecordedKeys(bool recording);
  void CommitHeldDeparture();
  void StartWindowMove(Done done);
  void CaptionDoubleClick(Done done);
  void WatchWindowDrag();
  void StopWatchingWindowDrag();
  void StartLifecycle();
  void StopLifecycle();
  void RetireLifecycle();
  void DialogCall(const std::string& method, const base::ListValue* values, Done done);
  void WindowCall(const std::string& method, const base::ListValue* values, Done done);
  void KeyboardCall(const std::string& method, const base::ListValue* values, Done done);
  void SidebarEdgeCall(const base::ListValue* values, bool left_only, Done done);
  void BeginWindowCloseDrain(const base::DictValue& request, Done done);
  void AcknowledgeWindowClose(const base::DictValue& request, Done done);
  void RejectWindowClose(const base::DictValue& request, Done done);
  void CancelWindowClose(const window_policy::CloseIdentity& identity, std::string_view reason);
  void CloseAcknowledgedWindow(window_policy::CloseIdentity identity);
  void SettleClose(window_policy::CloseIdentity identity);
  bool ClosingEndsSession() const;
  void OnWindowChanged(WindowEvents::Kind kind);
  void OnPointerMoved(const WindowEvents::Pointer& pointer);
  void ReportSidebarEdge(std::optional<window_policy::EdgeReport> report);
  void ReconcilePointerPoll(const std::optional<WindowEvents::Pointer>& pointer);
  void ReportWindowState();
  base::DictValue WindowStateValue() const;
  base::DictValue WindowGeometryValue() const;
  void EmitWindowEvent(base::DictValue event);
  void NoteSwitcherSource();
  void RestoreSwitcherSource();
  void NoteUnclaimedTab(content::WebContents* contents, bool active);
  void AnnounceUnclaimedTab(int id, int tries);
  base::DictValue OfferTab(content::WebContents* contents, bool active);
  void ListUnclaimedTabs(Done done);
  bool BindsContents(const content::WebContents* contents) const;
  content::WebContents* MemberTab(int id, Profile* profile) const;

  void OnViewBoundsChanged(views::View* observed_view) override;
  void OnViewIsDeleting(views::View* observed_view) override;
  void OnTabStripModelChanged(TabStripModel* tab_strip_model,
                              const TabStripModelChange& change,
                              const TabStripSelectionChange& selection) override;

  raw_ptr<BrowserWindowInterface> browser_;
  raw_ptr<BrowserView> browser_view_;
  raw_ptr<Profile> app_profile_;
  std::string window_id_;
  std::string kind_;
  std::string title_;
  std::string page_profile_;
  bool startup_ = true;
  base::DictValue utility_;
  bool utility_ready_ = false;
  struct HeldDeparture {
    window_policy::CloseIdentity identity;
    base::DictValue base;
    base::DictValue session;
  };
  std::optional<HeldDeparture> held_departure_;
  bool closing_ = false;
  bool painted_ = false;
  uint64_t shell_ready_generation_ = 0;
  std::vector<base::WeakPtr<BrowserWindowInterface>> companions_;

  raw_ptr<views::WebView> shell_ = nullptr;
  raw_ptr<views::View> under_shell_ = nullptr;
  std::vector<glass::Rect> pass_;
  std::map<int, std::unique_ptr<PageBinding>> bindings_;
  std::unique_ptr<GlassRegions> glass_;
  std::unique_ptr<PopoverHost> popovers_;
  std::unique_ptr<shared_folders::Watcher> shared_folder_watcher_;
  std::unique_ptr<SystemServices> system_;
  std::unique_ptr<ExtensionViews> extension_views_;
  std::unique_ptr<PipPresenter> pip_;
  struct WindowDrag;
  std::unique_ptr<WindowDrag> drag_;
  struct PendingTab {
    base::WeakPtr<content::WebContents> contents;
    bool active = false;
  };
  std::map<int, PendingTab> unclaimed_;
  shell_policy::OfferBook<base::WeakPtr<content::WebContents>> offered_;
  std::optional<uint64_t> unclaimed_listener_;

  raw_ptr<ShellBridge> handler_ = nullptr;
  content::WeakDocumentPtr renderer_document_;
  uint64_t renderer_generation_ = 1;
  base::WeakPtr<ShellBridge> request_handler_;
  uint64_t request_generation_ = 0;

  std::unique_ptr<DocumentSession> documents_;
  std::unique_ptr<DialogSheets> dialogs_;
  std::unique_ptr<WindowEvents> window_events_;
  std::unique_ptr<ScrollGestures> scroll_gestures_;
  window_policy::CloseBook close_;
  std::uint64_t quit_generation_ = 0;
  std::map<std::string, std::uint64_t> close_dialogs_;
  window_policy::EdgeWatch edge_;
  std::string edge_id_;
  std::optional<window_policy::WindowState> reported_state_;
  bool full_screen_restored_ = false;
  bool shortcut_recording_ = false;
  struct RecordingKeys;
  std::unique_ptr<RecordingKeys> recording_keys_;
  bool switcher_capture_ = false;
  base::WeakPtr<content::WebContents> switcher_source_;

  raw_ptr<views::FocusManager> focus_manager_ = nullptr;
  std::map<ui::Accelerator, base::DictValue> shortcuts_;
  views::UnhandledKeyboardEventHandler unhandled_keys_;
  std::vector<std::string> unhandled_;

  base::ScopedObservation<views::View, views::ViewObserver> view_observation_{
      this};
  base::WeakPtrFactory<ShellHostView> weak_factory_{this};
};

}

#endif
