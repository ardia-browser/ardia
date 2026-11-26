#ifndef ARDIA_WIN_WEBUI_WEBUI_WINDOWS_H_
#define ARDIA_WIN_WEBUI_WEBUI_WINDOWS_H_

#include <windows.h>

#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "ardia/win/webui/webui_window_policy.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/values.h"
#include "base/scoped_observation.h"
#include "chrome/browser/ui/browser_window/public/browser_collection_observer.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/native_ui_types.h"

class BrowserWindowInterface;
class GURL;
class Profile;

namespace content {
class WebContents;
}

namespace ardia_win::webui {

class ShellHostView;
struct WindowConfig;

class WindowRegistry : public BrowserCollectionObserver {
 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;

  static WindowRegistry& Get();

  WindowRegistry(const WindowRegistry&) = delete;
  WindowRegistry& operator=(const WindowRegistry&) = delete;

  void Start(Profile* app_profile, base::ListValue urls);
  void Stop();
  bool started() const { return started_; }
  Profile* app_profile() const;

  ShellHostView* Open(Profile* page_profile,
                      WindowConfig config,
                      std::optional<gfx::Rect> requested_frame);
  void OpenRequested(ShellHostView* requester,
                     const std::string& id,
                     const base::DictValue* options,
                     Done done);
  bool FocusWindow(ShellHostView* requester, const std::string& id);

  ShellHostView* HostForShell(const content::WebContents* shell) const;
  ShellHostView* HostByWindowId(const std::string& window_id) const;
  ShellHostView* HostOf(const BrowserWindowInterface* browser) const;
  std::vector<ShellHostView*> Hosts() const;
  ShellHostView* FrontHost() const;

  void Attached(ShellHostView* host);
  void Detached(ShellHostView* host);
  void RegisterCompanion(const BrowserWindowInterface* companion,
                         ShellHostView* owner);
  bool IsCompanion(const BrowserWindowInterface* browser) const;
  bool KeepsWindowWithoutTabs(const BrowserWindowInterface* browser) const;
  BrowserWindowInterface* CompanionOwner(
      const BrowserWindowInterface* browser) const;
  bool PresentCompanion(const BrowserWindowInterface* browser, bool activate);
  int WindowTabCount(const BrowserWindowInterface* browser) const;
  bool ShellPassesPoint(gfx::NativeView child, const gfx::Point& location) const;

  bool PreTranslate(const MSG& msg);
  void Relaunched(base::ListValue urls);
  void DeliverOpenUrls();
  void ResetAllCompanionConfirmations();
  bool OffTheRecordNavigation(content::WebContents* contents, const GURL& url);
  void BroadcastWindowEvent(const base::DictValue& event);
  void BroadcastSession(const std::string& source_window,
                        const base::DictValue& source_base,
                        base::DictValue previous,
                        base::DictValue session);
  ShellHostView* ReachableHost(const std::string& window_id) const;
  base::ListValue PrivateWindows() const;
  void PrivateWindowsChanged();
  void ProfileLoaded(Profile* profile);
  base::ListValue WindowIds() const;

  void RememberPlacement(const webui_window::Placement& placement);
  std::optional<webui_window::Placement> SavedPlacement() const;

 private:
  friend class base::NoDestructor<WindowRegistry>;

  WindowRegistry();
  ~WindowRegistry() override;

  void OnBrowserCreated(BrowserWindowInterface* browser) override;
  void OnBrowserClosed(BrowserWindowInterface* browser) override;
  void OnBrowserActivated(BrowserWindowInterface* browser) override;

  void Attach(base::WeakPtr<BrowserWindowInterface> browser);
  ShellHostView* AttachTo(BrowserWindowInterface* browser, WindowConfig config);
  void OpenInProfile(base::WeakPtr<ShellHostView> requester,
                     uint64_t generation,
                     WindowConfig config,
                     std::optional<gfx::Rect> frame,
                     Done done,
                     Profile* profile);
  std::string NextWindowId();
  void HandOverPrivateWindow(BrowserWindowInterface* browser);
  void ContinueHandOver(base::WeakPtr<BrowserWindowInterface> browser,
                        int tries);
  void NotifyWindowClosed(ShellHostView* closed);
  int NextPrivateOrdinal() const;
  ShellHostView* FindOpenUrlsRecipient() const;

  bool started_ = false;
  base::ScopedObservation<GlobalBrowserCollection, BrowserCollectionObserver>
      browsers_observation_{this};
  base::WeakPtr<Profile> app_profile_;
  std::map<int, raw_ptr<ShellHostView>> hosts_;
  std::map<int, int> companion_owners_;
  std::vector<int> activation_order_;
  base::ListValue pending_urls_;
  bool pending_bare_relaunch_ = false;
  std::set<int> hidden_private_handovers_;
  bool opening_window_ = false;
  std::optional<webui_window::Placement> saved_placement_;
  bool placement_loaded_ = false;
  bool placement_loading_ = false;
  int next_window_ = 1;
  base::WeakPtrFactory<WindowRegistry> weak_factory_{this};
};

}

#endif
