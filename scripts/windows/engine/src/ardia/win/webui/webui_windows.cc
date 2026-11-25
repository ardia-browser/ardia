#include "ardia/win/webui/webui_windows.h"

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/main.h"
#include "ardia/win/profiles.h"
#include "ardia/win/webui/webui_host_internal.h"
#include "ardia/win/webui/webui_host_view.h"
#include "ardia/win/webui/webui_storage.h"
#include "base/auto_reset.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/ui/tabs/tab_enums.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/profiles/profile_manager_observer.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "ui/base/base_window.h"
#include "ui/base/mojom/window_show_state.mojom.h"
#include "ui/display/display.h"
#include "ui/display/screen.h"
#include "ui/views/widget/widget.h"

namespace ardia_win::webui {

namespace {

webui_window::Rect ToRect(const gfx::Rect& rect) {
  return {rect.x(), rect.y(), rect.width(), rect.height()};
}

gfx::Rect FromRect(const webui_window::Rect& rect) {
  return gfx::Rect(rect.x, rect.y, rect.width, rect.height);
}

std::optional<gfx::Rect> FrameFrom(const base::DictValue* options) {
  const base::ListValue* frame = options ? options->FindList("frame") : nullptr;
  if (!frame || frame->size() != 4 ||
      !std::ranges::all_of(*frame, [](const base::Value& value) {
        return value.is_int() || value.is_double();
      })) {
    return std::nullopt;
  }
  const double x = (*frame)[0].GetDouble();
  const double y = (*frame)[1].GetDouble();
  const double width = (*frame)[2].GetDouble();
  const double height = (*frame)[3].GetDouble();
  if (!webui_window::ValidRect(x, y, width, height) || width < 1 ||
      height < 1) {
    return std::nullopt;
  }
  return gfx::Rect(static_cast<int>(x), static_cast<int>(y),
                   static_cast<int>(width), static_cast<int>(height));
}

bool SeedFits(const base::DictValue* seed) {
  if (!seed) {
    return true;
  }
  const std::optional<std::string> json = base::WriteJson(*seed);
  return json && json->size() <= webui_window::kSeedJsonLimit;
}

class ProfileWatch : public ProfileManagerObserver {
 public:
  ProfileWatch() {
    if (g_browser_process && g_browser_process->profile_manager()) {
      g_browser_process->profile_manager()->AddObserver(this);
      observing_ = true;
    }
  }
  ~ProfileWatch() override { Stop(); }

  void Stop() {
    if (observing_ && g_browser_process &&
        g_browser_process->profile_manager()) {
      g_browser_process->profile_manager()->RemoveObserver(this);
    }
    observing_ = false;
  }

 private:
  void OnProfileAdded(Profile* profile) override {
    WindowRegistry::Get().ProfileLoaded(profile);
  }

  void OnProfileManagerDestroying() override { Stop(); }

  bool observing_ = false;
};

std::unique_ptr<ProfileWatch>& Watch() {
  static base::NoDestructor<std::unique_ptr<ProfileWatch>> watch;
  return *watch;
}

}

WindowRegistry& WindowRegistry::Get() {
  static base::NoDestructor<WindowRegistry> registry;
  return *registry;
}

WindowRegistry::WindowRegistry() = default;

WindowRegistry::~WindowRegistry() = default;

Profile* WindowRegistry::app_profile() const {
  return app_profile_.get();
}

void WindowRegistry::Start(Profile* app_profile, base::ListValue urls) {
  for (base::Value& url : urls) {
    pending_urls_.Append(std::move(url));
  }
  if (!started_) {
    started_ = true;
    app_profile_ = app_profile->GetWeakPtr();
    browsers_observation_.Observe(GlobalBrowserCollection::GetInstance());
    Watch() = std::make_unique<ProfileWatch>();
  }
  if (!placement_loaded_) {
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&ReadPlacement, SessionDirectory()),
        base::BindOnce(
            [](base::WeakPtr<WindowRegistry> registry,
               std::optional<webui_window::Placement> saved) {
              if (!registry) {
                return;
              }
              registry->placement_loaded_ = true;
              if (!registry->saved_placement_) {
                registry->saved_placement_ = saved;
              }
              registry->Start(registry->app_profile(), base::ListValue());
            },
            weak_factory_.GetWeakPtr()));
    return;
  }
  if (Hosts().empty()) {
    WindowConfig config;
    config.window_id = webui_window::kMainWindowId;
    config.startup = true;
    config.page_profile = kAppProfileName;
    if (!Open(app_profile, std::move(config), std::nullopt)) {
      LOG(ERROR) << "Ardia WebUI shell: the main window did not open";
      QuitApp();
      return;
    }
  } else if (ShellHostView* front = FrontHost()) {
    front->FocusWindow();
  }
  DeliverOpenUrls();
}

void WindowRegistry::Stop() {
  hidden_private_handovers_.clear();
  browsers_observation_.Reset();
  Watch().reset();
  started_ = false;
}

ShellHostView* WindowRegistry::Open(Profile* page_profile,
                                    WindowConfig config,
                                    std::optional<gfx::Rect> requested_frame) {
  if (!page_profile || !app_profile() ||
      GetBrowserWindowCreationStatusForProfile(*page_profile) !=
          BrowserWindowInterface::CreationStatus::kOk) {
    return nullptr;
  }
  const bool browser_kind = !webui_window::IsUtility(config.kind);
  std::optional<webui_window::Placement> front;
  ShellHostView* in_front = FrontHost();
  if (browser_kind && !config.startup && in_front && !in_front->is_utility() &&
      in_front->browser()) {
    const ui::BaseWindow* window = in_front->browser()->GetWindow();
    front = webui_window::Placement{ToRect(window->GetRestoredBounds()),
                                    window->IsMaximized()};
  }
  const std::optional<webui_window::Rect> requested =
      requested_frame ? std::make_optional(ToRect(*requested_frame))
                      : std::nullopt;
  const std::optional<webui_window::Placement> saved =
      browser_kind ? saved_placement_ : std::nullopt;
  const std::optional<webui_window::Rect> effective =
      webui_window::EffectivePlacementRect(requested, front, saved);
  const display::Display display =
      effective ? display::Screen::Get()->GetDisplayMatching(FromRect(*effective))
                : display::Screen::Get()->GetPrimaryDisplay();
  const webui_window::PlacementChoice choice = webui_window::ChoosePlacement(
      requested, front, saved, ToRect(display.work_area()), config.maximized);
  BrowserWindowCreateParams params(BrowserWindowInterface::TYPE_NORMAL,
                                   *page_profile, true);
  params.omit_from_session_restore = true;
  params.should_trigger_session_restore = false;
  params.initial_bounds = FromRect(choice.frame);
  params.initial_show_state = choice.maximized
                                  ? ui::mojom::WindowShowState::kMaximized
                                  : ui::mojom::WindowShowState::kNormal;
  BrowserWindowInterface* browser = nullptr;
  {
    base::AutoReset<bool> opening(&opening_window_, true);
    browser = CreateBrowserWindow(std::move(params));
  }
  if (!browser) {
    return nullptr;
  }
  const std::string id = config.window_id;
  const bool focus = config.focus && !ardiacore::BackgroundInstance();
  ShellHostView* host = AttachTo(browser, std::move(config));
  if (!host) {
    browser->GetWindow()->Close();
    return nullptr;
  }
  switch (choice.source) {
    case webui_window::PlacementSource::kFront:
      NoteForTest("webui shell: placed " + id + " like the window in front");
      break;
    case webui_window::PlacementSource::kSaved:
      NoteForTest("webui shell: placed " + id +
                  " where the last browser window was");
      break;
    case webui_window::PlacementSource::kRequested:
    case webui_window::PlacementSource::kDefault:
      break;
  }
  if (choice.maximized) {
    NoteForTest("webui shell: opened " + id + " maximized");
  }
  if (focus) {
    browser->GetWindow()->Show();
  } else {
    browser->GetWindow()->ShowInactive();
  }
  return host;
}

ShellHostView* WindowRegistry::AttachTo(BrowserWindowInterface* browser,
                                        WindowConfig config) {
  BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser);
  if (!view || !view->GetWidget() || !app_profile()) {
    LOG(WARNING) << "Ardia WebUI shell could not attach to a Chromium window";
    return nullptr;
  }
  const bool private_window = ParseProfileName(config.page_profile).off_the_record;
  auto owned = std::make_unique<ShellHostView>(browser, view, app_profile(),
                                               std::move(config));
  ShellHostView* host = view->AddChildView(std::move(owned));
  if (private_window) {
    host->set_private_ordinal(NextPrivateOrdinal());
  }
  hidden_private_handovers_.erase(host->id());
  hosts_[host->id()] = host;
  activation_order_.push_back(host->id());
  host->Initialize();
  if (private_window) {
    PrivateWindowsChanged();
  }
  return host;
}

void WindowRegistry::OpenRequested(ShellHostView* requester,
                                   const std::string& id,
                                   const base::DictValue* options,
                                   Done done) {
  if (!requester || !requester->LiveFor(requester->renderer_generation())) {
    return std::move(done).Run(
        false, Failure("ERR_WINDOW_STALE",
                       "The shell document that asked for this window is gone"));
  }
  const std::string kind_text =
      options && options->FindString("kind") ? *options->FindString("kind")
                                             : std::string();
  const std::optional<webui_window::WindowKind> kind =
      webui_window::ClassifyOpenWindow(id, kind_text);
  if (!kind) {
    return std::move(done).Run(false,
                               base::Value("Invalid native window request"));
  }
  if (ShellHostView* existing = HostByWindowId(id)) {
    if (existing->is_utility() && options) {
      std::optional<base::DictValue> navigation;
      if (const base::DictValue* settings = options->FindDict("settings")) {
        navigation = settings->Clone();
      }
      if (const std::string* source = options->FindString("importSource")) {
        if (!navigation) {
          navigation.emplace();
        }
        navigation->Set("importSource", *source);
      }
      if (navigation) {
        existing->NavigateUtility(std::move(*navigation));
      }
    }
    if (!options || options->FindBool("focus").value_or(true)) {
      existing->FocusWindow();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (hosts_.size() >= webui_window::kOpenWindowLimit) {
    return std::move(done).Run(
        false, Failure("ERR_WINDOW_LIMIT", "Too many windows are open"));
  }
  const bool utility = webui_window::IsUtility(*kind);
  const std::string requested_profile =
      options && options->FindString("profile") ? *options->FindString("profile")
                                                : std::string();
  const std::string profile =
      utility ? std::string(kAppProfileName)
              : (requested_profile.empty() ? requester->page_profile_id()
                                           : requested_profile);
  const base::DictValue* private_seed =
      options ? options->FindDict("privateWindow") : nullptr;
  const base::DictValue* small_seed =
      *kind == webui_window::WindowKind::kSmall && options
          ? options->FindDict("smallWindow")
          : nullptr;
  const bool incognito =
      options && options->FindBool("incognito").value_or(false);
  if (!webui_window::OpenWindowProfileAllowed(
          *kind, {.incognito = incognito,
                  .private_profile = ParseProfileName(profile).off_the_record,
                  .has_private_seed = private_seed != nullptr,
                  .has_small_seed = small_seed != nullptr}) ||
      !SeedFits(private_seed) || !SeedFits(small_seed)) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_INVALID", "Invalid window profile"));
  }
  WindowConfig config;
  config.window_id = id;
  config.kind = *kind;
  config.page_profile = profile;
  config.opener = requester->id();
  config.focus = !options || options->FindBool("focus").value_or(true);
  if (options && !utility) {
    config.maximized = options->FindBool("maximized");
  }
  if (private_seed) {
    config.private_window = private_seed->Clone();
  }
  if (small_seed) {
    config.small_window = small_seed->Clone();
  }
  if (utility) {
    if (const base::DictValue* navigation =
            options ? options->FindDict("settings") : nullptr) {
      config.utility = navigation->Clone();
    }
    if (const std::string* source =
            options ? options->FindString("importSource") : nullptr) {
      config.utility.Set("importSource", *source);
    }
  }
  const std::optional<gfx::Rect> frame = utility ? std::nullopt : FrameFrom(options);
  WithProfile(profile, base::BindOnce(&WindowRegistry::OpenInProfile,
                                      weak_factory_.GetWeakPtr(),
                                      requester->GetWeakPtr(),
                                      requester->renderer_generation(),
                                      std::move(config), frame, std::move(done)));
}

void WindowRegistry::OpenInProfile(base::WeakPtr<ShellHostView> requester,
                                   uint64_t generation,
                                   WindowConfig config,
                                   std::optional<gfx::Rect> frame,
                                   Done done,
                                   Profile* profile) {
  if (!requester || !requester->LiveFor(generation)) {
    return std::move(done).Run(
        false, Failure("ERR_WINDOW_STALE",
                       "The shell document that asked for this window is gone"));
  }
  if (!profile) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_UNAVAILABLE", "The window's profile did "
                                                  "not load"));
  }
  if (HostByWindowId(config.window_id)) {
    return std::move(done).Run(true, base::Value());
  }
  const std::string id = config.window_id;
  ShellHostView* host = Open(profile, std::move(config), frame);
  if (!host) {
    return std::move(done).Run(
        false, Failure("ERR_WINDOW_OPEN", "The window did not open"));
  }
  NoteForTest("webui shell: opened window " + id);
  std::move(done).Run(true, base::Value());
}

bool WindowRegistry::FocusWindow(ShellHostView* requester,
                                 const std::string& id) {
  ShellHostView* host = HostByWindowId(id);
  if (!host) {
    return false;
  }
  host->FocusWindow();
  return true;
}

ShellHostView* WindowRegistry::HostForShell(
    const content::WebContents* shell) const {
  for (const auto& [id, host] : hosts_) {
    if (shell && host->shell_contents() == shell) {
      return host;
    }
  }
  return nullptr;
}

ShellHostView* WindowRegistry::HostByWindowId(
    const std::string& window_id) const {
  for (const auto& [id, host] : hosts_) {
    if (host->window_id() == window_id && host->browser()) {
      return host;
    }
  }
  return nullptr;
}

ShellHostView* WindowRegistry::HostOf(
    const BrowserWindowInterface* browser) const {
  if (!browser) {
    return nullptr;
  }
  const int session = browser->GetSessionID().id();
  if (const auto found = hosts_.find(session); found != hosts_.end()) {
    return found->second;
  }
  if (const auto owner = companion_owners_.find(session);
      owner != companion_owners_.end()) {
    const auto found = hosts_.find(owner->second);
    return found == hosts_.end() ? nullptr : found->second.get();
  }
  return nullptr;
}

std::vector<ShellHostView*> WindowRegistry::Hosts() const {
  std::vector<ShellHostView*> hosts;
  for (const auto& [id, host] : hosts_) {
    if (host->browser()) {
      hosts.push_back(host);
    }
  }
  return hosts;
}

ShellHostView* WindowRegistry::FrontHost() const {
  for (auto it = activation_order_.rbegin(); it != activation_order_.rend();
       ++it) {
    const auto found = hosts_.find(*it);
    if (found != hosts_.end() && found->second->browser() &&
        !found->second->closing()) {
      return found->second;
    }
  }
  return nullptr;
}

void WindowRegistry::Attached(ShellHostView* host) {
  hosts_[host->id()] = host;
}

void WindowRegistry::Detached(ShellHostView* host) {
  std::erase_if(hosts_, [host](const auto& entry) { return entry.second == host; });
  std::erase_if(companion_owners_,
                [host](const auto& entry) { return entry.second == host->id(); });
  std::erase(activation_order_, host->id());
}

void WindowRegistry::RegisterCompanion(const BrowserWindowInterface* companion,
                                       ShellHostView* owner) {
  companion_owners_[companion->GetSessionID().id()] = owner->id();
  hidden_private_handovers_.erase(companion->GetSessionID().id());
}

bool WindowRegistry::IsCompanion(const BrowserWindowInterface* browser) const {
  return browser && companion_owners_.contains(browser->GetSessionID().id());
}

bool WindowRegistry::KeepsWindowWithoutTabs(
    const BrowserWindowInterface* browser) const {
  if (!browser) {
    return false;
  }
  const int session = browser->GetSessionID().id();
  const auto hosted = hosts_.find(session);
  const bool companion = companion_owners_.contains(session);
  const bool closing =
      hosted != hosts_.end() ? hosted->second->closing() : false;
  return webui_window::KeepsWindowWithoutTabs(hosted != hosts_.end(), companion,
                                              closing);
}

BrowserWindowInterface* WindowRegistry::CompanionOwner(
    const BrowserWindowInterface* browser) const {
  ShellHostView* host = IsCompanion(browser) ? HostOf(browser) : nullptr;
  return host ? host->browser() : nullptr;
}

bool WindowRegistry::PresentCompanion(const BrowserWindowInterface* browser,
                                      bool activate) {
  if (browser &&
      hidden_private_handovers_.contains(browser->GetSessionID().id())) {
    return true;
  }
  if (!IsCompanion(browser)) {
    return false;
  }
  ShellHostView* host = HostOf(browser);
  if (host && activate) {
    host->FocusWindow();
  }
  return true;
}

int WindowRegistry::WindowTabCount(const BrowserWindowInterface* browser) const {
  ShellHostView* host = HostOf(browser);
  if (!host || host->browser() != browser) {
    return -1;
  }
  int count = 0;
  for (BrowserWindowInterface* member : host->Members()) {
    count += member->GetTabStripModel()->count();
  }
  return count;
}

bool WindowRegistry::ShellPassesPoint(gfx::NativeView child,
                                      const gfx::Point& location) const {
  return std::ranges::any_of(Hosts(), [&](ShellHostView* host) {
    return host->PassesShellPoint(child, location);
  });
}

bool WindowRegistry::PreTranslate(const MSG& msg) {
  bool consumed = false;
  for (ShellHostView* host : Hosts()) {
    consumed |= host->PreTranslate(msg);
  }
  return consumed;
}

void WindowRegistry::Relaunched(base::ListValue urls) {
  if (!app_profile()) {
    for (base::Value& url : urls) {
      pending_urls_.Append(std::move(url));
    }
    return;
  }
  Start(app_profile(), std::move(urls));
}

void WindowRegistry::DeliverOpenUrls() {
  if (pending_urls_.empty()) {
    return;
  }
  ShellHostView* chosen = nullptr;
  for (auto it = activation_order_.rbegin(); it != activation_order_.rend();
       ++it) {
    const auto found = hosts_.find(*it);
    if (found != hosts_.end() && found->second->TakesOpenUrls() &&
        found->second->OpenUrlsListening()) {
      chosen = found->second;
      break;
    }
  }
  if (!chosen) {
    return;
  }
  base::ListValue urls = std::move(pending_urls_);
  pending_urls_ = base::ListValue();
  chosen->OpenUrls(std::move(urls));
}

void WindowRegistry::BroadcastWindowEvent(const base::DictValue& event) {
  for (ShellHostView* host : Hosts()) {
    if (!host->is_utility()) {
      host->Emit("ArdiaShell", "onWindowEvent", base::Value(event.Clone()));
    }
  }
}

void WindowRegistry::BroadcastSession(const std::string& source_window,
                                      const base::DictValue& source_base,
                                      base::DictValue previous,
                                      base::DictValue session) {
  if (previous == session) {
    return;
  }
  const base::DictValue event = base::DictValue()
                                    .Set("base", std::move(previous))
                                    .Set("session", std::move(session))
                                    .Set("sourceWindowId", source_window);
  for (ShellHostView* host : Hosts()) {
    if (host->private_window()) {
      continue;
    }
    base::DictValue update = event.Clone();
    if (host->window_id() == source_window) {
      update.Set("base", source_base.Clone());
    }
    host->Emit("ArdiaHost", "session", base::Value(std::move(update)));
  }
}

ShellHostView* WindowRegistry::ReachableHost(const std::string& window_id) const {
  return window_id.empty() ? nullptr : HostByWindowId(window_id);
}

base::ListValue WindowRegistry::PrivateWindows() const {
  base::ListValue windows;
  for (ShellHostView* host : Hosts()) {
    if (host->private_window() && !host->closing()) {
      windows.Append(base::DictValue()
                         .Set("id", host->window_id())
                         .Set("ordinal", host->private_ordinal()));
    }
  }
  return windows;
}

void WindowRegistry::PrivateWindowsChanged() {
  for (ShellHostView* host : Hosts()) {
    host->PrivateWindowsChanged();
  }
}

void WindowRegistry::ProfileLoaded(Profile* profile) {
  if (!profile || profile->IsOffTheRecord()) {
    return;
  }
  const std::string name = profile == app_profile()
                               ? std::string(kAppProfileName)
                               : NameOfProfile(profile);
  for (ShellHostView* host : Hosts()) {
    host->BroadcastProfileLoaded(name);
  }
}

base::ListValue WindowRegistry::WindowIds() const {
  base::ListValue ids;
  for (ShellHostView* host : Hosts()) {
    ids.Append(host->window_id());
  }
  return ids;
}

void WindowRegistry::RememberPlacement(const webui_window::Placement& placement) {
  if (saved_placement_ == placement) {
    return;
  }
  saved_placement_ = placement;
  FileRunner()->PostTask(
      FROM_HERE, base::BindOnce(base::IgnoreResult(&WritePlacement),
                                SessionDirectory(), placement));
}

std::optional<webui_window::Placement> WindowRegistry::SavedPlacement() const {
  return saved_placement_;
}

void WindowRegistry::OnBrowserCreated(BrowserWindowInterface* browser) {
  if (webui_window::HidesUntilHandedOver(
          started_, opening_window_,
          browser->GetType() == BrowserWindowInterface::TYPE_NORMAL,
          browser->GetProfile() && browser->GetProfile()->IsOffTheRecord())) {
    hidden_private_handovers_.insert(browser->GetSessionID().id());
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&WindowRegistry::Attach,
                                weak_factory_.GetWeakPtr(),
                                browser->GetWeakPtr()));
}

void WindowRegistry::Attach(base::WeakPtr<BrowserWindowInterface> browser) {
  if (!browser) {
    return;
  }
  Profile* profile = browser->GetProfile();
  if (!started_ || hosts_.contains(browser->GetSessionID().id()) ||
      IsCompanion(browser.get()) ||
      browser->GetType() != BrowserWindowInterface::TYPE_NORMAL || !profile ||
      !profile->IsOffTheRecord()) {
    hidden_private_handovers_.erase(browser->GetSessionID().id());
  }
  if (!started_ || hosts_.contains(browser->GetSessionID().id()) ||
      IsCompanion(browser.get()) ||
      browser->GetType() != BrowserWindowInterface::TYPE_NORMAL || !profile) {
    return;
  }
  if (profile->IsOffTheRecord()) {
    return HandOverPrivateWindow(browser.get());
  }
  WindowConfig config;
  config.window_id = NextWindowId();
  config.chrome_made = true;
  config.page_profile = profile == app_profile() ? std::string(kAppProfileName)
                                                 : NameOfProfile(profile);
  if (ShellHostView* host = AttachTo(browser.get(), std::move(config))) {
    NoteForTest("webui shell: adopted a window Chromium opened as " +
                host->window_id());
  }
}

void WindowRegistry::HandOverPrivateWindow(BrowserWindowInterface* browser) {
  browser->GetWindow()->Hide();
  ContinueHandOver(browser->GetWeakPtr(), 0);
}

void WindowRegistry::ContinueHandOver(
    base::WeakPtr<BrowserWindowInterface> browser,
    int tries) {
  if (!browser) {
    return;
  }
  ShellHostView* same_session = nullptr;
  ShellHostView* front = nullptr;
  for (auto it = activation_order_.rbegin(); it != activation_order_.rend();
       ++it) {
    const auto found = hosts_.find(*it);
    if (found == hosts_.end() || !found->second->browser() ||
        found->second->is_utility() || found->second->closing()) {
      continue;
    }
    ShellHostView* host = found->second;
    if (!same_session && host->page_profile() == browser->GetProfile()) {
      same_session = host;
    }
    if (!front && !host->private_window()) {
      front = host;
    }
  }
  TabStripModel* model = browser->GetTabStripModel();
  bool waiting = false;
  size_t handed = 0;
  size_t moved = 0;
  for (int index = model->count() - 1; index >= 0; --index) {
    content::WebContents* contents = model->GetWebContentsAt(index);
    const GURL url = contents->GetVisibleURL();
    const bool blank = !url.is_valid() || url.IsAboutBlank();
    ShellHostView* target = same_session ? same_session : front;
    const bool accepted =
        !blank && target && target->RequestPrivateWindow(url);
    switch (webui_window::NextHandOverStep(accepted || blank,
                                           same_session != nullptr, tries)) {
      case webui_window::HandOverStep::kHanded:
        if (!blank) {
          ++handed;
        }
        model->DetachAndDeleteWebContentsAt(index);
        break;
      case webui_window::HandOverStep::kMove: {
        std::unique_ptr<content::WebContents> taken =
            model->DetachWebContentsAtForInsertion(index);
        TabStripModel* into = same_session->browser()->GetTabStripModel();
        into->InsertWebContentsAt(into->count(), std::move(taken),
                                  AddTabTypes::ADD_NONE);
        ++moved;
        break;
      }
      case webui_window::HandOverStep::kRetry:
        waiting = true;
        break;
      case webui_window::HandOverStep::kDrop:
        model->DetachAndDeleteWebContentsAt(index);
        break;
    }
  }
  if (handed || moved) {
    NoteForTest("webui shell: a private window Chromium opened handed " +
                base::NumberToString(handed) + " pages to the shell and moved " +
                base::NumberToString(moved) + " into its private window");
  }
  if (waiting) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&WindowRegistry::ContinueHandOver,
                       weak_factory_.GetWeakPtr(), std::move(browser),
                       tries + 1),
        base::Milliseconds(250));
    return;
  }
  browser->GetWindow()->Close();
}

void WindowRegistry::ResetAllCompanionConfirmations() {
  for (ShellHostView* host : Hosts()) {
    host->ResetUnloadConfirmations();
  }
}

void WindowRegistry::NotifyWindowClosed(ShellHostView* closed) {
  const base::DictValue event =
      base::DictValue().Set("type", "close").Set("id", closed->window_id());
  if (closed->private_window()) {
    const auto opener = hosts_.find(closed->opener());
    if (opener != hosts_.end() && opener->second != closed &&
        opener->second->browser()) {
      opener->second->Emit("ArdiaShell", "onWindowEvent",
                           base::Value(event.Clone()));
    }
    return;
  }
  for (ShellHostView* host : Hosts()) {
    if (host != closed && !host->is_utility()) {
      host->Emit("ArdiaShell", "onWindowEvent", base::Value(event.Clone()));
    }
  }
}

bool WindowRegistry::OffTheRecordNavigation(content::WebContents* contents,
                                            const GURL& url) {
  if (!contents || !url.is_valid()) {
    return false;
  }
  for (ShellHostView* host : Hosts()) {
    if (host->OpenPrivateLink(contents, url)) {
      return true;
    }
  }
  LOG(WARNING) << "Ardia WebUI shell refused a private link: its tab has no "
                  "live shell page";
  return true;
}

void WindowRegistry::OnBrowserClosed(BrowserWindowInterface* browser) {
  const int session = browser->GetSessionID().id();
  hidden_private_handovers_.erase(session);
  if (const auto owner = companion_owners_.find(session);
      owner != companion_owners_.end()) {
    const int host_id = owner->second;
    companion_owners_.erase(owner);
    if (const auto found = hosts_.find(host_id); found != hosts_.end()) {
      found->second->CompanionClosed(browser);
    }
    return;
  }
  const auto found = hosts_.find(session);
  if (found == hosts_.end()) {
    return;
  }
  ShellHostView* host = found->second;
  const bool private_window = host->private_window();
  if (!host->is_utility()) {
    NotifyWindowClosed(host);
  }
  host->DetachBrowser();
  std::erase(activation_order_, session);
  if (private_window) {
    PrivateWindowsChanged();
  }
  const std::vector<ShellHostView*> remaining = Hosts();
  const bool browser_left = std::ranges::any_of(
      remaining, [](ShellHostView* other) { return !other->is_utility(); });
  if (!browser_left) {
    ResetAllCompanionConfirmations();
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&QuitApp));
  }
}

void WindowRegistry::OnBrowserActivated(BrowserWindowInterface* browser) {
  const int session = browser->GetSessionID().id();
  if (!hosts_.contains(session)) {
    return;
  }
  std::erase(activation_order_, session);
  activation_order_.push_back(session);
}

std::string WindowRegistry::NextWindowId() {
  for (;;) {
    std::string id = "w-" + base::NumberToString(next_window_++);
    if (!HostByWindowId(id)) {
      return id;
    }
  }
}

int WindowRegistry::NextPrivateOrdinal() const {
  int ordinal = 1;
  for (;;) {
    bool taken = false;
    for (const auto& [id, host] : hosts_) {
      taken |= host->private_ordinal() == ordinal;
    }
    if (!taken) {
      return ordinal;
    }
    ++ordinal;
  }
}

}
