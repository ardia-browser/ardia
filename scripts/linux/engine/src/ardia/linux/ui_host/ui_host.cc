#include <map>
#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/log.h"
#include "ardia/linux/main.h"
#include "ardia/linux/ui_host/app_bridge_host.h"
#include "ardia/linux/ui_host/ardia_app_source.h"
#include "ardia/linux/ui_host/ardia_app_ui.h"
#include "ardia/linux/ui_host/ui_host_parts.h"
#include "ardia/linux/ui_host/ui_navigation_throttle.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/functional/callback_helpers.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/webui_config_map.h"
#include "third_party/blink/public/mojom/window_features/window_features.mojom.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "url/url_constants.h"

namespace ardia_linux {

namespace {

constexpr int kMostReloadsAfterCrash = 3;
constexpr base::TimeDelta kCrashWindow = base::Minutes(1);

base::FilePath UiDirectory() {
  const base::CommandLine& command_line =
      *base::CommandLine::ForCurrentProcess();
  base::FilePath from_switch = command_line.GetSwitchValuePath(kUiDirSwitch);
  if (!from_switch.empty()) {
    return from_switch;
  }
  base::FilePath exe_dir;
  base::PathService::Get(base::DIR_EXE, &exe_dir);
  return exe_dir.Append("ui");
}

bool IsAboutBlank(const GURL& url) {
  return url.IsAboutBlank() || url.is_empty();
}

class UiHost : public content::WebContentsDelegate,
               public content::WebContentsObserver {
 public:
  explicit UiHost(Profile* profile) : profile_(profile) {}
  UiHost(const UiHost&) = delete;
  UiHost& operator=(const UiHost&) = delete;
  ~UiHost() override { Observe(nullptr); }

  static UiHost*& Current() {
    static UiHost* current = nullptr;
    return current;
  }

  void Load() {
    content::WebContents::CreateParams params(profile_);
    contents_ = content::WebContents::Create(params);
    contents_->SetDelegate(this);
    Observe(contents_.get());
    keep_rendering_ = contents_->IncrementCapturerCount(
        gfx::Size(), false, false, false);
    contents_->GetController().LoadURL(
        GURL(kArdiaAppDocumentUrl), content::Referrer(),
        ui::PAGE_TRANSITION_AUTO_TOPLEVEL, std::string());
  }

  void Reload() {
    AppWindows::Get().CloseAll();
    opened_.clear();
    pending_.clear();
    contents_->GetController().Reload(content::ReloadType::BYPASSING_CACHE,
                                      false);
  }

  content::WebContents* contents() { return contents_.get(); }

  bool IsHostDocument(content::RenderFrameHost* frame) const {
    if (!frame || !contents_ ||
        content::WebContents::FromRenderFrameHost(frame) != contents_.get() ||
        frame != contents_->GetPrimaryMainFrame()) {
      return false;
    }
    return frame->GetLastCommittedOrigin().IsSameOriginWith(
        url::Origin::Create(GURL(kArdiaAppUrl)));
  }

  bool OpensAppWindow(content::RenderFrameHost* opener,
                      const GURL& target_url,
                      const std::string& frame_name) {
    if (!IsHostDocument(opener) || !IsAboutBlank(target_url) ||
        frame_name.empty() || opened_.contains(frame_name) ||
        !AppWindows::Get().IsShaped(frame_name)) {
      return false;
    }
    opened_.insert(frame_name);
    return true;
  }

  bool IsAppWindowContents(const content::WebContents* contents) const {
    return contents && contents != contents_.get() &&
           (AppWindows::Get().ForUiContents(contents) ||
            pending_.contains(contents));
  }

  bool IsHostContents(const content::WebContents* contents) const {
    return contents && contents == contents_.get();
  }

  void WebContentsCreated(content::WebContents* source_contents,
                          const content::GlobalRenderFrameHostId& opener_id,
                          const std::string& frame_name,
                          const GURL& target_url,
                          content::WebContents* new_contents) override {
    if (source_contents != contents_.get() || !opened_.contains(frame_name) ||
        !IsAboutBlank(target_url)) {
      return;
    }
    pending_[new_contents] = frame_name;
  }

  content::WebContents* AddNewContents(
      content::WebContents* source,
      std::unique_ptr<content::WebContents> new_contents,
      const GURL& target_url,
      WindowOpenDisposition disposition,
      const blink::mojom::WindowFeatures& window_features,
      bool user_gesture,
      bool* was_blocked) override {
    auto found = pending_.find(new_contents.get());
    if (found == pending_.end()) {
      Note("ui", "refused a window the UI didn't shape");
      return nullptr;
    }
    std::string id = found->second;
    pending_.erase(found);
    content::WebContents* adopted = new_contents.get();
    if (!AppWindows::Get().Adopt(id, std::move(new_contents))) {
      Note("ui", base::StrCat({"window ", id, " could not be adopted"}));
      return nullptr;
    }
    return adopted;
  }

  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)>
          navigation_handle_callback) override {
    Note("ui", base::StrCat({"refused opening a ", params.url.scheme(),
                             " address from the UI host"}));
    return nullptr;
  }

  void CanDownload(const GURL& url,
                   const std::string& request_method,
                   base::OnceCallback<void(bool)> callback) override {
    Note("ui", base::StrCat({"refused a ", url.scheme(),
                             " download from the UI host"}));
    std::move(callback).Run(false);
  }

  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override {
    base::TimeTicks now = base::TimeTicks::Now();
    if (now - crash_window_started_ > kCrashWindow) {
      crash_window_started_ = now;
      reloads_after_crash_ = 0;
    }
    if (++reloads_after_crash_ > kMostReloadsAfterCrash) {
      Note("ui", "the UI's renderer keeps stopping; not reloading it again");
      return;
    }
    Note("ui", "the UI's renderer stopped; reloading the UI");
    Reload();
  }

 private:
  raw_ptr<Profile> profile_;
  std::unique_ptr<content::WebContents> contents_;
  base::ScopedClosureRunner keep_rendering_;
  std::set<std::string> opened_;
  std::map<const content::WebContents*, std::string> pending_;
  base::TimeTicks crash_window_started_;
  int reloads_after_crash_ = 0;
};

}

namespace {

void LoadUiHost(base::FilePath ui_dir,
                std::vector<std::string> script_hashes) {
  UiHost* host = UiHost::Current();
  if (!host) {
    return;
  }
  Note("ui", base::StrCat({"script hashes ",
                           base::NumberToString(script_hashes.size())}));
  content::WebUIConfigMap::GetInstance().AddWebUIConfig(
      std::make_unique<ArdiaAppUIConfig>(
          std::move(ui_dir), DataDirectory().Append("Translations"),
          std::move(script_hashes)));
  host->Load();
}

}

void StartUiHost() {
  if (UiHost::Current()) {
    return;
  }
  Profile* profile =
      ProfileManager::GetLastUsedProfile()->GetOriginalProfile();
  base::FilePath ui_dir = UiDirectory();
  Note("ui", ui_dir.value());
  UiHost* host = new UiHost(profile);
  UiHost::Current() = host;
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce(&ReadScriptHashes, ui_dir),
      base::BindOnce(&LoadUiHost, ui_dir));
}

void StopUiHost() {
  delete std::exchange(UiHost::Current(), nullptr);
}

void ReloadUiHost() {
  if (UiHost* host = UiHost::Current()) {
    host->Reload();
  }
}

content::WebContents* UiHostContents() {
  UiHost* host = UiHost::Current();
  return host ? host->contents() : nullptr;
}

bool IsUiHostDocument(content::RenderFrameHost* frame) {
  UiHost* host = UiHost::Current();
  return host && host->IsHostDocument(frame);
}

bool IsUiHostContents(const content::WebContents* contents) {
  UiHost* host = UiHost::Current();
  return host && host->IsHostContents(contents);
}

bool IsAppWindowContents(const content::WebContents* contents) {
  UiHost* host = UiHost::Current();
  return host && host->IsAppWindowContents(contents);
}

void RegisterUiHostBinders(content::RenderFrameHost& frame,
                           blink::AssociatedInterfaceRegistry& registry) {
  RegisterAppBridgeBinder(frame, registry);
}

void AddUiHostThrottles(content::NavigationThrottleRegistry& registry) {
  UiNavigationThrottle::MaybeAdd(registry);
}

bool UiHostOpensAppWindow(content::RenderFrameHost* opener,
                          const GURL& target_url,
                          const std::string& frame_name) {
  UiHost* host = UiHost::Current();
  return host && host->OpensAppWindow(opener, target_url, frame_name);
}

}
