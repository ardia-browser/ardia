#include "ardia/mac/ac_mac_shell_host.h"

#import <AppKit/AppKit.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <set>
#include <utility>

#include "ardia/mac/ac_mac_dialog.h"
#include "ardia/linux/ac_linux_session.h"
#include "ardia/mac/ac_mac_extension_view.h"
#include "ardia/mac/ac_mac_glass.h"
#include "ardia/mac/ac_mac_link_gesture.h"
#include "ardia/mac/ac_mac_menu.h"
#include "ardia/mac/ac_mac_page_commands.h"
#include "ardia/mac/ac_mac_page_delegate.h"
#include "ardia/mac/ac_mac_page_events.h"
#include "ardia/mac/ac_mac_page_policy.h"
#include "ardia/mac/ac_mac_pip.h"
#include "ardia/mac/ac_mac_popover.h"
#include "ardia/mac/ac_mac_share.h"
#include "ardia/mac/ac_mac_shared_folders.h"
#include "ardia/mac/ac_mac_swipe.h"
#include "ardia/mac/ac_mac_system.h"
#include "ardia/mac/ac_mac_window.h"
#include "ardia/mac/ac_mac_window_policy.h"
#include "ardia/mac/ac_mac_window_events.h"
#include "ardia/mac/ac_mac_shell_bridge.h"
#include "ardia/mac/ac_mac_shell_policy.h"
#include "ardia/mac/ac_mac_webui_policy.h"
#include "base/auto_reset.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "ui/compositor/layer.h"
#include "content/public/browser/render_widget_host.h"
#include "components/input/native_web_keyboard_event.h"
#include "base/apple/owned_objc.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/sys_string_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "components/zoom/zoom_controller.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/tabs/tab_enums.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/page.h"
#include "content/public/browser/reload_type.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/common/referrer.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/accelerators/accelerator_manager.h"
#include "ui/base/base_window.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/mojom/window_show_state.mojom.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "ui/gfx/geometry/rect_conversions.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/focus/focus_manager.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia_mac {

namespace {

constexpr char kShellUrl[] = "chrome://ardia/";
constexpr size_t kUnhandledLimit = 400;
constexpr char kDirectoryPrefix[] = "Profile ";

class ShellTransparency : public content::WebContentsObserver {
 public:
  explicit ShellTransparency(content::WebContents* shell)
      : content::WebContentsObserver(shell) {
    Apply();
  }

  void PrimaryPageChanged(content::Page& page) override { Apply(); }
  void RenderViewReady() override { Apply(); }

 private:
  void Apply() {
    web_contents()->SetPageBaseBackgroundColor(SK_ColorTRANSPARENT);
    if (content::RenderWidgetHostView* view =
            web_contents()->GetRenderWidgetHostView()) {
      view->SetBackgroundColor(SK_ColorTRANSPARENT);
    }
  }
};

std::map<content::WebContents*, std::unique_ptr<ShellTransparency>>&
Transparencies() {
  static base::NoDestructor<
      std::map<content::WebContents*, std::unique_ptr<ShellTransparency>>>
      transparencies;
  return *transparencies;
}

}

std::string Text(const base::DictValue& value, std::string_view key) {
  const std::string* found = value.FindString(key);
  return found ? *found : std::string();
}

const base::ListValue* Arguments(const base::DictValue& value) {
  return value.FindList("args");
}

int TabId(const content::WebContents* contents) {
  return contents ? sessions::SessionTabHelper::IdForTab(contents).id() : 0;
}

base::Value Failure(std::string_view code, std::string_view message) {
  return base::Value(
      base::DictValue().Set("code", code).Set("message", message));
}

std::optional<gfx::Rect> RectFrom(const base::DictValue* rect) {
  if (!rect) {
    return std::nullopt;
  }
  const double x = rect->FindDouble("x").value_or(NAN);
  const double y = rect->FindDouble("y").value_or(NAN);
  const double width = rect->FindDouble("width").value_or(NAN);
  const double height = rect->FindDouble("height").value_or(NAN);
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) ||
      !std::isfinite(height) || width < 0 || height < 0 ||
      std::abs(x) > 1e6 || std::abs(y) > 1e6 || width > 1e6 || height > 1e6) {
    return std::nullopt;
  }
  return gfx::ToEnclosingRect(gfx::RectF(x, y, width, height));
}

std::optional<glass::Rect> GlassRectFrom(const base::DictValue* rect) {
  if (!rect) {
    return std::nullopt;
  }
  const double x = rect->FindDouble("x").value_or(NAN);
  const double y = rect->FindDouble("y").value_or(NAN);
  const double width = rect->FindDouble("width").value_or(NAN);
  const double height = rect->FindDouble("height").value_or(NAN);
  const glass::Rect parsed{x, y, width, height};
  return glass::ValidRect(parsed) ? std::optional<glass::Rect>(parsed)
                                  : std::nullopt;
}

std::optional<GURL> AllowedPageUrl(const std::string& requested) {
  std::string text = requested.empty() ? "about:blank" : requested;
  if (base::StartsWith(text, "ardia://", base::CompareCase::INSENSITIVE_ASCII)) {
    text.replace(0, 8, "chrome://");
  }
  const GURL url(text);
  if (!url.is_valid() || url.SchemeIs("javascript")) {
    return std::nullopt;
  }
  const GURL inner = url.SchemeIs("view-source") ? GURL(url.GetContent()) : url;
  if (inner.SchemeIs("javascript") || inner.SchemeIs("view-source") ||
      (inner.SchemeIs("chrome") &&
       base::TrimString(inner.host(), ".", base::TRIM_TRAILING) == "ardia")) {
    return std::nullopt;
  }
  return url;
}

base::FilePath DataDirectory() {
  const base::CommandLine* command = base::CommandLine::ForCurrentProcess();
  if (command->HasSwitch("ardia-data-dir")) {
    return command->GetSwitchValuePath("ardia-data-dir");
  }
  if (const char* data = getenv("ARDIA_DATA_DIR"); data && *data) {
    return base::FilePath(data);
  }
  return g_browser_process->profile_manager()->user_data_dir().DirName();
}

base::FilePath AssetDirectory() {
  const base::CommandLine* command = base::CommandLine::ForCurrentProcess();
  if (const char* bundle = getenv("ARDIA_WEBUI_BUNDLE"); bundle && *bundle) {
    return base::FilePath(bundle);
  }
  if (command->HasSwitch("ardia-ui-dir")) {
    return command->GetSwitchValuePath("ardia-ui-dir");
  }
  return base::FilePath(base::SysNSStringToUTF8(
                            [[NSBundle mainBundle] resourcePath]))
      .Append("ardia-ui");
}

bool BackgroundInstance() {
  const char* environment =
      getenv(std::string(webui_policy::kBackgroundEnvironment).c_str());
  return webui_policy::Background(
      base::CommandLine::ForCurrentProcess()->HasSwitch(
          std::string(webui_policy::kBackgroundSwitch)),
      environment ? std::optional<std::string_view>(environment) : std::nullopt);
}

void Trace(const std::string& line) {
  LOG(WARNING) << "Ardia Mac WebUI: " << line;
}

void WithProfile(std::string_view name,
                 base::OnceCallback<void(Profile*)> callback) {
  ProfileManager* manager = g_browser_process->profile_manager();
  const bool app_profile = name.empty() || name == "default";
  if (!app_profile && !shell_policy::ValidProfileId(name)) {
    std::move(callback).Run(nullptr);
    return;
  }
  const base::FilePath path =
      app_profile
          ? manager->user_data_dir().Append(ProfileManager::GetInitialProfileDir())
          : manager->user_data_dir().Append(std::string(kDirectoryPrefix) +
                                             std::string(name));
  if (Profile* loaded = manager->GetProfileByPath(path)) {
    std::move(callback).Run(loaded);
    return;
  }
  manager->CreateProfileAsync(
      path, base::BindOnce(
                [](std::string name, base::OnceCallback<void(Profile*)> callback,
                   Profile* profile) {
                  if (profile) {
                    for (ShellHostView* host : Hosts()) {
                      host->Emit("ArdiaProfiles", "profiles",
                                 base::Value(base::DictValue()
                                                 .Set("name", "profiles.loaded")
                                                 .Set("data", base::DictValue().Set(
                                                                  "profile", name))));
                    }
                  }
                  std::move(callback).Run(profile);
                },
                std::string(app_profile ? "default" : name), std::move(callback)));
}

std::string ProfileName(const Profile* profile) {
  const std::string directory =
      profile->GetOriginalProfile()->GetPath().BaseName().value();
  return directory.starts_with(kDirectoryPrefix)
             ? directory.substr(sizeof(kDirectoryPrefix) - 1)
             : "default";
}

std::vector<ShellHostView*>& Hosts() {
  static base::NoDestructor<std::vector<ShellHostView*>> hosts;
  return *hosts;
}

ShellHostView* HostForWindow(std::string_view id) {
  for (ShellHostView* host : Hosts()) {
    if (host->window_id() == id) {
      return host;
    }
  }
  return nullptr;
}

ShellHostView* HostForShell(content::WebContents* contents) {
  for (ShellHostView* host : Hosts()) {
    if (contents && host->shell_contents() == contents) {
      return host;
    }
  }
  return nullptr;
}

MenuCommandHandler MainMenuHandler() {
  return base::BindRepeating([](const MenuChoice& choice) {
    const std::optional<std::string> key = KeyMenuWindowId();
    ShellHostView* target = nullptr;
    for (ShellHostView* host : Hosts()) {
      if (!target) {
        target = host;
      }
      if (key && host->window_id() == *key) {
        target = host;
        break;
      }
    }
    if (target) {
      target->OnMenuCommand(choice.command, choice.argument);
    } else if (choice.command == "quit") {
      QuitWithoutShell();
    }
  });
}

MenuWindowResolver ShellMenuWindows() {
  return base::BindRepeating([](gfx::NativeWindow window) -> std::optional<std::string> {
    NSWindow* wanted = window.GetNativeNSWindow();
    for (ShellHostView* host : Hosts()) {
      views::Widget* widget = host->GetWidget();
      if (wanted && widget && widget->GetNativeWindow().GetNativeNSWindow() == wanted) {
        return host->window_id();
      }
    }
    return std::nullopt;
  });
}

ShellHostView* HostForPopover(content::WebContents* contents) {
  for (ShellHostView* host : Hosts()) {
    if (contents && host->popovers() && host->popovers()->Owns(contents)) {
      return host;
    }
  }
  return nullptr;
}

PageBinding::PageBinding(ShellHostView* owner,
                         content::WebContents* contents,
                         std::string key,
                         std::string profile)
    : content::WebContentsObserver(contents),
      owner_(owner),
      id_(TabId(contents)),
      key_(std::move(key)),
      profile_(std::move(profile)) {
  events_ = std::make_unique<PageEvents>(
      contents, base::BindRepeating(&PageBinding::Report, base::Unretained(this)));
  commands_ = std::make_unique<PageCommands>(this);
  links_ = std::make_unique<PageLinks>(this, contents);
}

PageBinding::~PageBinding() {
  links_.reset();
  if (owner_) {
    share::RetireBinding(owner_->window_id(), id_);
  }
  commands_.reset();
  events_.reset();
  if (viewport && owner_) {
    viewport->SetWebContents(nullptr);
    owner_->RemoveChildViewT(viewport.get());
  }
  viewport = nullptr;
}

base::DictValue PageBinding::NavigationEvent() const {
  content::WebContents* contents = web_contents();
  base::DictValue data;
  if (contents) {
    data.Set("url", contents->GetVisibleURL().spec());
    data.Set("title", base::UTF16ToUTF8(contents->GetTitle()));
    data.Set("canGoBack", contents->GetController().CanGoBack());
    data.Set("canGoForward", contents->GetController().CanGoForward());
    data.Set("isLoading", contents->IsLoading());
    data.Set("committedUrl", contents->GetLastCommittedURL().spec());
  }
  const std::optional<std::string> theme = PageThemeColor(contents);
  data.Set("themeColor", theme ? base::Value(*theme) : base::Value());
  data.Set("themeColorSource", theme ? base::Value("meta") : base::Value());
  return base::DictValue().Set("name", "navigation").Set("data", std::move(data));
}

base::DictValue PageBinding::Envelope(std::string_view type) {
  return base::DictValue()
      .Set("type", type)
      .Set("claim", claim)
      .Set("rendererGeneration", base::NumberToString(renderer_generation))
      .Set("bindingGeneration", base::NumberToString(binding_generation))
      .Set("documentEpoch", "1")
      .Set("sequence", static_cast<double>(++sequence));
}

base::DictValue PageBinding::CreationState() {
  base::DictValue lease;
  lease.Set("claim", claim);
  lease.Set("rendererGeneration", base::NumberToString(renderer_generation));
  lease.Set("bindingGeneration", base::NumberToString(binding_generation));
  lease.Set("documentEpoch", "1");
  base::ListValue events = base::ListValue().Append(NavigationEvent());
  if (events_) {
    events_->AppendSnapshot(events);
  }
  base::DictValue snapshot;
  snapshot.Set("watermark", static_cast<double>(sequence));
  snapshot.Set("events", std::move(events));
  return base::DictValue()
      .Set("browserId", id_)
      .Set("chromeTabId", id_)
      .Set("lease", std::move(lease))
      .Set("snapshot", std::move(snapshot));
}

void PageBinding::Rebind(content::WebContents* contents) {
  commands_->Reset();
  links_.reset();
  events_.reset();
  Observe(contents);
  id_ = TabId(contents);
  events_ = std::make_unique<PageEvents>(
      contents, base::BindRepeating(&PageBinding::Report, base::Unretained(this)));
  links_ = std::make_unique<PageLinks>(this, contents);
}

void PageBinding::ReportNavigation() {
  if (!owner_ || claim.empty() || !web_contents()) {
    return;
  }
  base::DictValue delivery = Envelope("pageEvent");
  delivery.Set("event", NavigationEvent());
  owner_->Emit("ArdiaWebView", base::NumberToString(id_),
               base::Value(std::move(delivery)));
}

void PageBinding::Report(std::string_view name, base::Value data) {
  if (!owner_ || claim.empty() || !web_contents()) {
    return;
  }
  base::DictValue delivery = Envelope("pageEvent");
  delivery.Set("event", PageEvent(name, std::move(data)));
  owner_->Emit("ArdiaWebView", base::NumberToString(id_),
               base::Value(std::move(delivery)));
}

void PageBinding::ReportClosed() {
  if (!owner_ || claim.empty()) {
    return;
  }
  base::DictValue delivery = Envelope("pageEvent");
  delivery.Set("event", base::DictValue()
                            .Set("name", "windowClose")
                            .Set("data", base::DictValue()));
  owner_->Emit("ArdiaWebView", base::NumberToString(id_),
               base::Value(std::move(delivery)));
}

void PageBinding::DidFinishNavigation(content::NavigationHandle* handle) {
  if (handle->IsInPrimaryMainFrame()) {
    ReportNavigation();
  }
}

void PageBinding::TitleWasSet(content::NavigationEntry* entry) {
  ReportNavigation();
}

void PageBinding::DidStartLoading() {
  ReportNavigation();
}

void PageBinding::DidStopLoading() {
  ReportNavigation();
}

void PageBinding::DidChangeThemeColor() {
  ReportNavigation();
}

void PageBinding::WebContentsDestroyed() {
  ReportClosed();
  commands_->Reset();
  events_->Reset();
  if (viewport) {
    viewport->SetWebContents(nullptr);
  }
  Observe(nullptr);
  if (owner_) {
    owner_->BindingGone(this);
  }
}

struct ShellHostView::RecordingKeys {
  id monitor = nil;
  ~RecordingKeys() {
    if (monitor) {
      [NSEvent removeMonitor:monitor];
    }
  }
};

struct ShellHostView::WindowDrag {
  NSEvent* mouse_down = nil;
  id monitor = nil;
  NSMutableArray* observers = [NSMutableArray array];
};

ShellHostView::ShellHostView(BrowserWindowInterface* browser,
                             BrowserView* browser_view,
                             Profile* app_profile,
                             WindowSpec spec)
    : browser_(browser),
      browser_view_(browser_view),
      app_profile_(app_profile),
      window_id_(std::move(spec.id)),
      kind_(std::move(spec.kind)),
      title_(std::move(spec.title)),
      page_profile_(std::move(spec.page_profile)),
      startup_(spec.startup),
      utility_(std::move(spec.utility)) {
  Hosts().push_back(this);
}

ShellHostView::~ShellHostView() {
  DetachBrowser();
  std::erase(Hosts(), this);
}

void ShellHostView::Initialize() {
  documents_ = std::make_unique<DocumentSession>(
      window_id_, base::BindRepeating(
                      [](base::WeakPtr<ShellHostView> host, base::Value payload) {
                        if (host) {
                          host->Emit("ArdiaDocuments", "documents",
                                     base::Value(base::DictValue()
                                                     .Set("name", "documents.changed")
                                                     .Set("data", std::move(payload))));
                        }
                      },
                      GetWeakPtr()));
  view_observation_.Observe(browser_view_.get());
  focus_manager_ = GetFocusManager();
  under_shell_ = AddChildView(std::make_unique<views::View>());
  under_shell_->SetPaintToLayer(ui::LAYER_NOT_DRAWN);
  under_shell_->layer()->SetFillsBoundsOpaquely(false);
  under_shell_->SetCanProcessEventsWithinSubtree(false);
  shell_ = AddChildView(std::make_unique<views::WebView>(app_profile_.get()));
  content::WebContents* shell = shell_->GetWebContents();
  shell->SetDelegate(this);
  Transparencies()[shell] = std::make_unique<ShellTransparency>(shell);
  glass_ = std::make_unique<GlassRegions>(
      browser_view_->GetWidget(), under_shell_.get(),
      base::BindRepeating(
          [](base::WeakPtr<ShellHostView> host, int generation) {
            if (host) {
              host->Emit("ArdiaGlass", "presented",
                         base::Value(base::DictValue().Set("generation", generation)));
            }
          },
          GetWeakPtr()));
  popovers_ = std::make_unique<PopoverHost>(
      browser_view_->GetWidget(), app_profile_.get(), window_id_,
      BackgroundInstance(),
      base::BindRepeating(
          [](base::WeakPtr<ShellHostView> host, const std::string& key,
             std::string_view reason) {
            if (!host) {
              return;
            }
            base::DictValue data;
            data.Set("id", key);
            data.Set("windowId", host->window_id());
            data.Set("reason", reason);
            host->EmitShellEvent("shell.popoverDismissed",
                                 base::Value(std::move(data)));
          },
          GetWeakPtr()));
  system_ = std::make_unique<SystemServices>(this);
  extension_views_ = std::make_unique<ExtensionViews>(this);
  pip_ = std::make_unique<PipPresenter>(this);
  StartLifecycle();
  browser_->GetTabStripModel()->AddObserver(this);
  WatchWindowDrag();
  LayoutOverlay();
  shell_->LoadInitialURL(GURL(kShellUrl));
  Note("window " + window_id_ + " attached");
}

void ShellHostView::DetachBrowser() {
  if (!browser_) {
    return;
  }
  CommitHeldDeparture();
  closing_ = true;
  recording_keys_.reset();
  RetireRenderer();
  ForgetWindowMenu(window_id_);
  TabStripModelObserver::StopObservingAll(this);
  CloseCompanions();
  pip_.reset();
  extension_views_.reset();
  system_.reset();
  for (auto& [id, binding] : bindings_) {
    if (binding->viewport) {
      binding->viewport->SetWebContents(nullptr);
    }
  }
  bindings_.clear();
  StopWatchingWindowDrag();
  shared_folder_watcher_.reset();
  share::Retire(window_id_);
  StopLifecycle();
  popovers_.reset();
  glass_.reset();
  if (focus_manager_) {
    focus_manager_->UnregisterAccelerators(this);
    focus_manager_ = nullptr;
  }
  if (shell_ && shell_->web_contents()) {
    Transparencies().erase(shell_->web_contents());
    shell_->web_contents()->SetDelegate(nullptr);
  }
  view_observation_.Reset();
  browser_ = nullptr;
}

content::WebContents* ShellHostView::shell_contents() const {
  return shell_ ? shell_->web_contents() : nullptr;
}

void ShellHostView::Note(const std::string& line) const {
  Trace(line);
}

std::vector<BrowserWindowInterface*> ShellHostView::Members() const {
  std::vector<BrowserWindowInterface*> members;
  if (!browser_) {
    return members;
  }
  members.push_back(browser_);
  for (const auto& companion : companions_) {
    if (companion) {
      members.push_back(companion.get());
    }
  }
  return members;
}

BrowserWindowInterface* ShellHostView::OwnerOf(
    const content::WebContents* contents) const {
  if (!contents) {
    return nullptr;
  }
  for (BrowserWindowInterface* member : Members()) {
    if (member->GetTabStripModel()->GetIndexOfWebContents(contents) !=
        TabStripModel::kNoTab) {
      return member;
    }
  }
  return nullptr;
}

bool ShellHostView::OwnsCompanion(const BrowserWindowInterface* browser) const {
  return std::ranges::any_of(companions_, [browser](const auto& companion) {
    return companion && companion.get() == browser;
  });
}

BrowserWindowInterface* ShellHostView::EnsureMember(Profile* profile) {
  if (!browser_ || !profile || closing_) {
    return nullptr;
  }
  for (BrowserWindowInterface* member : Members()) {
    if (member->GetProfile() == profile) {
      return member;
    }
  }
  if (profile->ShutdownStarted() ||
      GetBrowserWindowCreationStatusForProfile(*profile) !=
          BrowserWindowInterface::CreationStatus::kOk) {
    return nullptr;
  }
  BrowserWindowCreateParams params(BrowserWindowInterface::TYPE_NORMAL,
                                   *profile, false);
  params.omit_from_session_restore = true;
  params.should_trigger_session_restore = false;
  params.initial_bounds = browser_->GetWindow()->GetBounds();
  params.initial_show_state = ui::mojom::WindowShowState::kNormal;
  BrowserWindowInterface* created = CreateBrowserWindow(std::move(params));
  if (!created) {
    return nullptr;
  }
  companions_.push_back(created->GetWeakPtr());
  created->GetTabStripModel()->AddObserver(this);
  if (system_) {
    system_->SyncWatches();
  }
  Note("companion window joined " + window_id_);
  return created;
}

void ShellHostView::CloseCompanions() {
  std::vector<base::WeakPtr<BrowserWindowInterface>> companions =
      std::move(companions_);
  companions_.clear();
  for (const auto& companion : companions) {
    if (!companion) {
      continue;
    }
    TabStripModel* model = companion->GetTabStripModel();
    model->RemoveObserver(this);
    while (model->count() > 0) {
      model->DetachAndDeleteWebContentsAt(model->count() - 1);
    }
    companion->GetWindow()->Close();
  }
}

PageBinding* ShellHostView::BindingForKey(std::string_view key) const {
  for (auto it = bindings_.rbegin(); it != bindings_.rend(); ++it) {
    if (it->second->key() == key && it->second->contents()) {
      return it->second.get();
    }
  }
  return nullptr;
}

PageBinding* ShellHostView::BindingForContents(
    const content::WebContents* contents) const {
  if (!contents) {
    return nullptr;
  }
  for (const auto& [id, binding] : bindings_) {
    if (binding->contents() == contents) {
      return binding.get();
    }
  }
  return nullptr;
}

void ShellHostView::BindingGone(PageBinding* binding) {
  const int id = binding->id();
  if (pip_) {
    pip_->CheckSource();
  }
  if (scroll_gestures_) {
    scroll_gestures_->Revalidate();
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<ShellHostView> host, int id) {
                       if (!host) {
                         return;
                       }
                       auto found = host->bindings_.find(id);
                       if (found != host->bindings_.end() &&
                           !found->second->contents()) {
                         host->bindings_.erase(found);
                       }
                     },
                     GetWeakPtr(), id));
}

bool ShellHostView::OwnsShellNativeView(gfx::NativeView view) const {
  content::WebContents* shell = shell_contents();
  return shell && view && shell->GetNativeView() == view;
}

std::optional<gfx::PointF> ShellHostView::ShellPointFor(const PageBinding* binding,
                                                        gfx::PointF page_point) const {
  if (!binding || binding->host() != this || !binding->viewport || !binding->visible) {
    return std::nullopt;
  }
  const gfx::Rect bounds = binding->viewport->bounds();
  const double zoom = ShellZoom();
  const double x = std::clamp<double>(page_point.x(), 0, bounds.width()) + bounds.x();
  const double y = std::clamp<double>(page_point.y(), 0, bounds.height()) + bounds.y();
  return gfx::PointF(static_cast<float>(x / zoom), static_cast<float>(y / zoom));
}

PageBinding* ShellHostView::BindingHit(gfx::NativeView hit) const {
  NSView* view = hit.GetNativeNSView();
  if (!view || closing_) {
    return nullptr;
  }
  for (const auto& [id, binding] : bindings_) {
    content::WebContents* contents = binding->contents();
    NSView* page = contents ? contents->GetNativeView().GetNativeNSView() : nil;
    if (page && binding->visible && binding->viewport && binding->viewport->GetVisible() &&
        [view isDescendantOf:page]) {
      return binding.get();
    }
  }
  return nullptr;
}

bool ShellHostView::PassesShellPoint(double x, double y) const {
  const double zoom = ShellZoom();
  return glass::Passes(pass_, glass::Point{x / zoom, y / zoom});
}

gfx::NativeView ShellHostView::LiveShellView(
    const content::WeakDocumentPtr& document,
    uint64_t generation) const {
  content::WebContents* shell = shell_contents();
  content::RenderFrameHost* frame = document.AsRenderFrameHostIfValid();
  const bool current = shell && frame && frame == shell->GetPrimaryMainFrame() &&
                       frame->IsActive();
  if (!menu::ContextMenuLive(true, generation, renderer_generation_, current) ||
      closing_) {
    return gfx::NativeView();
  }
  return shell->GetNativeView();
}

double ShellHostView::ShellZoom() const {
  content::WebContents* shell = shell_contents();
  if (!shell) {
    return 1;
  }
  return glass::SanitizedScale(blink::ZoomLevelToZoomFactor(
      zoom::ZoomController::GetZoomLevelForWebContents(shell)));
}

void ShellHostView::UpdateGlassSurface() {
  if (!glass_ || !shell_) {
    return;
  }
  const gfx::Rect shell_in_widget =
      shell_->ConvertRectToWidget(shell_->GetLocalBounds());
  std::vector<GlassPage> pages;
  for (const auto& [id, binding] : bindings_) {
    views::WebView* page = binding->viewport;
    content::WebContents* contents = binding->contents();
    if (!page || !contents || !binding->visible || !page->GetVisible()) {
      continue;
    }
    const gfx::Rect bounds = page->bounds();
    pages.push_back(GlassPage{
        glass::Page{binding->id(),
                    glass::Rect{static_cast<double>(bounds.x()),
                                static_cast<double>(bounds.y()),
                                static_cast<double>(bounds.width()),
                                static_cast<double>(bounds.height())}},
        contents->GetNativeView()});
  }
  glass_->SetSurface(
      glass::Rect{static_cast<double>(shell_in_widget.x()),
                  static_cast<double>(shell_in_widget.y()),
                  static_cast<double>(shell_in_widget.width()),
                  static_cast<double>(shell_in_widget.height())},
      std::move(pages));
}

void ShellHostView::LayoutOverlay() {
  if (!browser_view_) {
    return;
  }
  SetBoundsRect(browser_view_->GetLocalBounds());
  if (shell_) {
    shell_->SetBoundsRect(GetLocalBounds());
  }
  if (under_shell_) {
    under_shell_->SetBoundsRect(GetLocalBounds());
  }
  if (views::WebView* chrome_view = browser_view_->GetActiveContentsWebView()) {
    chrome_view->SetVisible(false);
  }
  Restack();
  UpdateGlassSurface();
  if (extension_views_) {
    extension_views_->Relayout();
  }
}

void ShellHostView::Restack() {
  if (!shell_ || !browser_view_) {
    return;
  }
  browser_view_->ReorderChildView(this, browser_view_->children().size());
  if (under_shell_) {
    ReorderChildView(under_shell_, children().size());
  }
  ReorderChildView(shell_, children().size());
  if (extension_views_) {
    extension_views_->RaisePopups();
  }
}

void ShellHostView::ReattachViewports() {
  if (scroll_gestures_) {
    scroll_gestures_->Revalidate();
  }
  std::set<content::WebContents*> taken;
  for (BrowserWindowInterface* member : Members()) {
    BrowserView* view = BrowserView::GetBrowserViewForBrowser(member);
    if (!view) {
      continue;
    }
    if (views::WebView* chrome_view = view->GetActiveContentsWebView()) {
      if (content::WebContents* held = chrome_view->web_contents()) {
        taken.insert(held);
      }
      chrome_view->SetWebContents(nullptr);
      chrome_view->SetVisible(false);
    }
  }
  for (auto& [id, binding] : bindings_) {
    views::WebView* page = binding->viewport;
    content::WebContents* contents = binding->contents();
    if (!page || !contents || !binding->visible) {
      continue;
    }
    if (taken.contains(contents) || page->web_contents() != contents) {
      page->SetWebContents(nullptr);
      page->SetWebContents(contents);
    }
  }
  Restack();
  UpdateGlassSurface();
}

void ShellHostView::OnViewBoundsChanged(views::View* observed_view) {
  LayoutOverlay();
}

void ShellHostView::OnViewIsDeleting(views::View* observed_view) {
  view_observation_.Reset();
  browser_view_ = nullptr;
}

void ShellHostView::FocusShell() {
  if (!shell_) {
    return;
  }
  shell_->RequestFocus();
  if (content::WebContents* contents = shell_contents()) {
    contents->Focus();
  }
}

bool ShellHostView::Trusted(content::WebUI* ui) const {
  content::WebContents* shell = shell_contents();
  if (!ui || !shell || ui->GetWebContents() != shell) {
    return false;
  }
  content::RenderFrameHost* frame = shell->GetPrimaryMainFrame();
  return frame && frame->IsRenderFrameLive() &&
         ui->GetRenderFrameHost() == frame && frame->GetWebUI() == ui &&
         frame->GetLastCommittedOrigin() ==
             url::Origin::Create(GURL(kShellUrl)) &&
         shell->GetLastCommittedURL().host() == "ardia";
}

uint64_t ShellHostView::SetHandler(ShellBridge* handler, content::WebUI* ui) {
  if (!Trusted(ui)) {
    return 0;
  }
  content::RenderFrameHost* frame = ui->GetRenderFrameHost();
  if (handler_ == handler &&
      renderer_document_.AsRenderFrameHostIfValid() == frame) {
    return renderer_generation_;
  }
  RetireRenderer();
  handler_ = handler;
  renderer_document_ = frame->GetWeakDocumentPtr();
  return renderer_generation_;
}

bool ShellHostView::OwnsHandler(const ShellBridge* handler,
                                uint64_t generation) const {
  content::RenderFrameHost* frame =
      renderer_document_.AsRenderFrameHostIfValid();
  return handler && handler_ == handler && generation &&
         renderer_generation_ == generation && frame && shell_contents() &&
         frame == shell_contents()->GetPrimaryMainFrame();
}

void ShellHostView::ClearHandler(ShellBridge* handler) {
  if (!handler || handler_ != handler) {
    return;
  }
  RetireRenderer();
}

void ShellHostView::NoteRequest(base::WeakPtr<ShellBridge> handler,
                                uint64_t generation) {
  request_handler_ = std::move(handler);
  request_generation_ = generation;
}

void ShellHostView::RetireRenderer() {
  const bool had_document = handler_ != nullptr;
  handler_ = nullptr;
  renderer_document_ = content::WeakDocumentPtr();
  ++renderer_generation_;
  if (documents_) {
    documents_->RendererRetired();
  }
  shared_folder_watcher_.reset();
  share::Retire(window_id_);
  SetMenuKeysSuppressed(window_id_, false);
  if (!had_document) {
    return;
  }
  for (auto& [id, binding] : bindings_) {
    binding->claim.clear();
    binding->commands()->CancelEvaluations();
    binding->renderer_generation = 0;
    binding->visible = false;
    if (binding->viewport) {
      binding->viewport->SetVisible(false);
      binding->viewport->SetWebContents(nullptr);
    }
  }
  if (scroll_gestures_) {
    scroll_gestures_->Revalidate();
  }
  pass_.clear();
  unclaimed_listener_.reset();
  if (extension_views_) {
    extension_views_->RetireOlderThan(renderer_generation_);
  }
  if (pip_) {
    pip_->RendererRetired();
  }
  if (system_) {
    system_->RendererRetired();
  }
  if (popovers_) {
    popovers_->CloseAll(popover::Event::kShellReloaded);
  }
  if (glass_) {
    glass_->Clear();
  }
  if (focus_manager_) {
    focus_manager_->UnregisterAccelerators(this);
  }
  shortcuts_.clear();
  RetireLifecycle();
  recording_keys_.reset();
}

void ShellHostView::DeliverReply(base::WeakPtr<ShellBridge> handler,
                                 uint64_t generation,
                                 std::string id,
                                 bool success,
                                 base::Value response) {
  if (!handler || !OwnsHandler(handler.get(), generation)) {
    return;
  }
  handler->Reply(id, success, std::move(response));
}

void ShellHostView::Emit(std::string_view module,
                         std::string_view event,
                         base::Value payload) {
  if (handler_ && OwnsHandler(handler_, handler_->generation())) {
    handler_->Send(module, event, payload);
  }
}

void ShellHostView::EmitShellEvent(std::string_view name, base::Value data) {
  Emit("ArdiaShell", "shell",
       base::Value(base::DictValue().Set("name", name).Set("data", std::move(data))));
}

void ShellHostView::NoteUnhandled(const std::string& method) {
  if (unhandled_.size() >= kUnhandledLimit ||
      std::ranges::find(unhandled_, method) != unhandled_.end()) {
    return;
  }
  unhandled_.push_back(method);
  Note("unhandled host call " + method);
}

PageBinding* ShellHostView::ClaimedBinding(const base::DictValue& args) const {
  const std::optional<int> id = args.FindInt("id");
  const auto found = id ? bindings_.find(*id) : bindings_.end();
  if (found == bindings_.end() || !found->second->contents() ||
      found->second->claim.empty() ||
      found->second->claim != Text(args, "claim")) {
    return nullptr;
  }
  return found->second.get();
}

base::DictValue ShellHostView::Identity(PageBinding* binding) const {
  return binding->CreationState();
}

void ShellHostView::ReplaceBinding(content::WebContents* old_contents,
                                   content::WebContents* contents) {
  PageBinding* binding = BindingForContents(old_contents);
  const int old_id = binding ? binding->id() : 0;
  const int id = TabId(contents);
  if (!binding || !contents ||
      !page_policy::RebindAllowed(old_id, id, id != old_id && bindings_.contains(id))) {
    return;
  }
  const std::optional<uint64_t> generation =
      page_policy::NextBindingGeneration(binding->binding_generation);
  if (!generation) {
    return;
  }
  base::DictValue delivery = binding->Envelope("pageLifecycle");
  share::RetireBinding(window_id_, old_id);
  binding->Rebind(contents);
  binding->binding_generation = *generation;
  if (id != old_id) {
    std::unique_ptr<PageBinding> owned = std::move(bindings_[old_id]);
    bindings_.erase(old_id);
    bindings_[id] = std::move(owned);
  }
  if (binding->claim.empty()) {
    return;
  }
  delivery.Set("action", "rebind");
  delivery.Set("creation", binding->CreationState());
  Emit("ArdiaWebView", base::NumberToString(old_id), base::Value(std::move(delivery)));
}

void ShellHostView::DropDetachedBinding(int id,
                                        base::WeakPtr<content::WebContents> contents) {
  const auto found = bindings_.find(id);
  if (!contents || found == bindings_.end() ||
      found->second->contents() != contents.get() ||
      page_policy::StripExitFor(false, OwnerOf(contents.get()) != nullptr) !=
          page_policy::StripExit::kDrop) {
    return;
  }
  bindings_.erase(found);
  ReattachViewports();
}

void ShellHostView::CreateTab(const base::DictValue& args, Done done) {
  const std::string key = Text(args, "key");
  const std::string claim = Text(args, "claim");
  if (key.empty() || key.size() > 256 || claim.empty() || claim.size() > 256) {
    return std::move(done).Run(false,
                               base::Value("A key and a claim are required"));
  }
  if (!AllowedPageUrl(Text(args, "url"))) {
    return std::move(done).Run(false, base::Value("Invalid or reserved tab URL"));
  }
  if (!browser_) {
    return std::move(done).Run(false, base::Value("This window has no tabs"));
  }
  const std::string profile = Text(args, "profile");
  WithProfile(profile,
              base::BindOnce(&ShellHostView::CreateTabIn, GetWeakPtr(),
                             args.Clone(), std::move(done), request_handler_,
                             request_generation_));
}

void ShellHostView::CreateTabIn(base::DictValue args,
                                Done done,
                                base::WeakPtr<ShellBridge> origin,
                                uint64_t generation,
                                Profile* profile) {
  if (!origin || !OwnsHandler(origin.get(), generation)) {
    return std::move(done).Run(
        false, base::Value("The shell document that asked for this tab is gone"));
  }
  AssertPageHooks();
  if (!profile || !browser_) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_UNAVAILABLE", "The tab's profile did not load"));
  }
  const std::optional<GURL> url = AllowedPageUrl(Text(args, "url"));
  const std::string key = Text(args, "key");
  const std::string claim = Text(args, "claim");
  BrowserWindowInterface* member =
      profile == browser_->GetProfile() ? browser_.get() : EnsureMember(profile);
  if (!member || !url) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_UNAVAILABLE",
                       "The tab's profile has no window to live in"));
  }
  PageBinding* existing = BindingForKey(key);
  const base::Value* adopt_value = args.Find("adoptId");
  const std::string* adopt_text = adopt_value ? adopt_value->GetIfString() : nullptr;
  shell_policy::CreateRequest request;
  request.adopt = shell_policy::ClassifyAdoptField(
      adopt_value != nullptr, adopt_text != nullptr,
      adopt_text ? std::string_view(*adopt_text) : std::string_view());
  content::WebContents* adoptable = nullptr;
  if (request.adopt == shell_policy::AdoptField::kId) {
    request.adopt_id = *shell_policy::ParseAdoptId(*adopt_text);
    const auto* offer = offered_.Find(request.adopt_id);
    content::WebContents* offered = offer ? offer->handle.get() : nullptr;
    content::WebContents* present = MemberTab(request.adopt_id, profile);
    request.adoption = shell_policy::CheckAdoption(
        true, offered != nullptr,
        offered && offered->GetBrowserContext() == profile,
        present && present == offered, BindsContents(present));
    adoptable = present;
  }
  content::WebContents* old_contents = existing ? existing->contents() : nullptr;
  request.key_bound = existing != nullptr;
  request.same_profile =
      old_contents && old_contents->GetBrowserContext() == profile;
  request.bound_id = existing ? existing->id() : 0;
  const shell_policy::CreatePlan plan = shell_policy::PlanCreate(request);
  if (plan == shell_policy::CreatePlan::kRefuse) {
    return std::move(done).Run(
        false, base::Value(request.adopt == shell_policy::AdoptField::kInvalid
                               ? "Invalid tab adoption id"
                               : "This tab can't be adopted"));
  }
  if (plan == shell_policy::CreatePlan::kReclaim) {
    existing->commands()->CancelEvaluations();
    share::RetireBinding(window_id_, existing->id());
    existing->claim = claim;
    existing->renderer_generation = renderer_generation_;
    ReattachViewports();
    return std::move(done).Run(true, base::Value(Identity(existing)));
  }
  const bool replacing = plan == shell_policy::CreatePlan::kReplace ||
                         plan == shell_policy::CreatePlan::kAdoptReplacing;
  content::WebContents* contents = nullptr;
  if (plan == shell_policy::CreatePlan::kAdopt ||
      plan == shell_policy::CreatePlan::kAdoptReplacing) {
    offered_.Forget(request.adopt_id);
    contents = adoptable;
  } else {
    NavigateParams params(member, *url, ui::PAGE_TRANSITION_AUTO_TOPLEVEL);
    params.disposition = WindowOpenDisposition::kNewBackgroundTab;
    params.window_action = NavigateParams::WindowAction::kNoAction;
    Navigate(&params);
    contents = params.navigated_or_inserted_contents;
  }
  if (!contents) {
    return std::move(done).Run(false, base::Value("The tab did not open"));
  }
  if (replacing && old_contents) {
    BrowserWindowInterface* old_owner = OwnerOf(old_contents);
    TabStripModel* old_model = old_owner ? old_owner->GetTabStripModel() : nullptr;
    const int old_index = old_model ? old_model->GetIndexOfWebContents(old_contents)
                                    : TabStripModel::kNoTab;
    bindings_.erase(existing->id());
    existing = nullptr;
    if (old_index != TabStripModel::kNoTab) {
      base::WeakPtr<ShellHostView> alive = GetWeakPtr();
      old_model->DetachAndDeleteWebContentsAt(old_index);
      if (!alive) {
        return;
      }
    }
  }
  auto binding = std::make_unique<PageBinding>(this, contents, key,
                                               Text(args, "profile"));
  binding->claim = claim;
  binding->renderer_generation = renderer_generation_;
  PageBinding* created = binding.get();
  bindings_[created->id()] = std::move(binding);
  ReattachViewports();
  std::move(done).Run(true, base::Value(Identity(created)));
}

void ShellHostView::SetViewport(const base::DictValue& args, Done done) {
  PageBinding* binding = ClaimedBinding(args);
  if (!binding) {
    return std::move(done).Run(false, base::Value("No owned live tab"));
  }
  const bool visible = args.FindBool("visible").value_or(false);
  const std::optional<gfx::Rect> rect = RectFrom(args.FindDict("rect"));
  if (!binding->viewport) {
    binding->viewport = AddChildViewAt(
        std::make_unique<views::WebView>(binding->contents()->GetBrowserContext()),
        0);
    binding->viewport->SetVisible(false);
  }
  if (visible && rect && !rect->IsEmpty()) {
    binding->viewport->SetBoundsRect(*rect);
    binding->viewport->SetVisible(true);
    binding->visible = true;
  } else {
    binding->viewport->SetVisible(false);
    binding->viewport->SetWebContents(nullptr);
    binding->visible = false;
  }
  ReattachViewports();
  std::move(done).Run(true, base::Value());
}

void ShellHostView::SetPresentations(const base::DictValue& args, Done done) {
  const base::ListValue* tabs = args.FindList("tabs");
  if (!tabs || tabs->size() > 64) {
    return std::move(done).Run(false,
                               base::Value("A tab presentation list is required"));
  }
  std::map<BrowserWindowInterface*, content::WebContents*> activate;
  for (const base::Value& tab : *tabs) {
    const base::DictValue* item = tab.GetIfDict();
    PageBinding* binding = item ? ClaimedBinding(*item) : nullptr;
    const std::optional<bool> visible =
        item ? item->FindBool("visible") : std::nullopt;
    if (!binding || !visible) {
      continue;
    }
    binding->presented = *visible;
    if (*visible) {
      if (BrowserWindowInterface* owner = OwnerOf(binding->contents())) {
        activate[owner] = binding->contents();
      }
    }
  }
  for (const auto& [owner, contents] : activate) {
    TabStripModel* model = owner->GetTabStripModel();
    const int index = model->GetIndexOfWebContents(contents);
    if (index != TabStripModel::kNoTab && index != model->active_index()) {
      model->ActivateTabAt(index);
    }
  }
  ReattachViewports();
  std::move(done).Run(true, base::Value());
}

void ShellHostView::TabCommand(const base::DictValue& args, Done done) {
  PageBinding* binding = ClaimedBinding(args);
  const std::string command = Text(args, "command");
  if (!binding) {
    if (PageCommands::Handles(command)) {
      return std::move(done).Run(
          false, Failure("ERR_PAGE_STALE_TARGET", "No such live tab"));
    }
    return std::move(done).Run(false, base::Value("No owned live tab"));
  }
  content::WebContents* contents = binding->contents();
  const base::ListValue* values = Arguments(args);
  if (PageCommands::Handles(command)) {
    static const base::NoDestructor<base::ListValue> kNoArguments;
    return binding->commands()->Run(command, values ? *values : *kNoArguments,
                                    std::move(done));
  }
  content::NavigationController& controller = contents->GetController();
  if (command == "loadUrl") {
    const std::optional<GURL> url =
        values && !values->empty() && (*values)[0].is_string()
            ? AllowedPageUrl((*values)[0].GetString())
            : std::nullopt;
    if (!url) {
      return std::move(done).Run(false, base::Value("Invalid or reserved URL"));
    }
    controller.LoadURL(*url, content::Referrer(), ui::PAGE_TRANSITION_TYPED,
                       std::string());
    return std::move(done).Run(true, base::Value());
  }
  if (command == "goBack" && controller.CanGoBack()) {
    controller.GoBack();
  } else if (command == "goForward" && controller.CanGoForward()) {
    controller.GoForward();
  } else if (command == "reload" || command == "forceReload") {
    controller.Reload(command == "reload" ? content::ReloadType::NORMAL
                                          : content::ReloadType::BYPASSING_CACHE,
                      true);
  } else if (command == "stopLoading") {
    contents->Stop();
  } else if (command == "focus") {
    if (binding->viewport) {
      binding->viewport->RequestFocus();
    }
    contents->Focus();
  } else if (command == "blur") {
    FocusShell();
  } else if (command == "setMuted" && values && !values->empty() &&
             (*values)[0].is_bool()) {
    contents->SetAudioMuted((*values)[0].GetBool());
  } else if (command == "close") {
    std::move(done).Run(true, base::Value());
    return CloseContents(contents);
  } else if (command == extension_policy::kExecuteAction) {
    return std::move(done).Run(true, base::Value(ExtensionViews::ExecuteAction(contents, values)));
  } else if (command == "navigationEntries") {
    base::ListValue entries;
    const int current = controller.GetCurrentEntryIndex();
    for (int index = 0; index < std::min(controller.GetEntryCount(), 1000);
         ++index) {
      content::NavigationEntry* entry = controller.GetEntryAtIndex(index);
      entries.Append(base::DictValue()
                         .Set("url", entry->GetVirtualURL().spec())
                         .Set("title", base::UTF16ToUTF8(entry->GetTitle()))
                         .Set("current", index == current));
    }
    return std::move(done).Run(true, base::Value(std::move(entries)));
  } else {
    NoteUnhandled("tab.command " + command);
  }
  std::move(done).Run(true, base::Value());
}

void ShellHostView::ReleaseTab(const base::DictValue& args, Done done) {
  const std::optional<int> id = args.FindInt("id");
  auto found = id ? bindings_.find(*id) : bindings_.end();
  if (found == bindings_.end()) {
    return std::move(done).Run(true, base::Value());
  }
  PageBinding* binding = found->second.get();
  if (binding->claim != Text(args, "claim")) {
    return std::move(done).Run(false, base::Value("No owned live tab"));
  }
  binding->claim.clear();
  binding->commands()->CancelEvaluations();
  share::RetireBinding(window_id_, binding->id());
  binding->visible = false;
  binding->presented = false;
  if (binding->viewport) {
    binding->viewport->SetVisible(false);
    binding->viewport->SetWebContents(nullptr);
  }
  if (scroll_gestures_) {
    scroll_gestures_->Revalidate();
  }
  UpdateGlassSurface();
  std::move(done).Run(true, base::Value());
}

void ShellHostView::CloseTab(const base::DictValue& args, Done done) {
  PageBinding* binding = BindingForKey(Text(args, "key"));
  std::move(done).Run(true, base::Value());
  if (binding) {
    CloseContents(binding->contents());
  }
}

void ShellHostView::CloseContents(content::WebContents* contents) {
  BrowserWindowInterface* owner = OwnerOf(contents);
  if (!owner) {
    return;
  }
  TabStripModel* model = owner->GetTabStripModel();
  const int index = model->GetIndexOfWebContents(contents);
  if (index != TabStripModel::kNoTab) {
    model->CloseWebContentsAt(index, TabCloseTypes::CLOSE_USER_GESTURE);
  }
}

void ShellHostView::SetInputRegions(const base::DictValue& args, Done done) {
  const auto read = [](const base::ListValue* list,
                       std::vector<glass::Rect>& out) {
    if (!list || list->size() > 64) {
      return false;
    }
    for (const base::Value& entry : *list) {
      const std::optional<glass::Rect> rect = GlassRectFrom(entry.GetIfDict());
      if (!rect) {
        return false;
      }
      if (!rect->empty()) {
        out.push_back(*rect);
      }
    }
    return true;
  };
  std::vector<glass::Rect> pages;
  std::vector<glass::Rect> overlays;
  if (!read(args.FindList("pages"), pages) ||
      !read(args.FindList("overlays"), overlays)) {
    return std::move(done).Run(
        false, base::Value("Input regions need pages and overlays as lists"));
  }
  pass_ = glass::PassThrough(pages, overlays);
  std::move(done).Run(true, base::Value());
}

void ShellHostView::SetGlassRegions(const base::DictValue& args, Done done) {
  if (!glass_) {
    return std::move(done).Run(
        false, base::Value("Glass regions are unavailable in this window"));
  }
  UpdateGlassSurface();
  base::Value reply = glass_->Apply(args, ShellZoom());
  std::move(done).Run(true, std::move(reply));
}

void ShellHostView::SetBackdropRegions(const base::DictValue& args, Done done) {
  if (!glass_) {
    return std::move(done).Run(
        false, base::Value("Backdrop regions are unavailable in this window"));
  }
  base::Value reply = glass_->ApplyBackdrops(args, ShellZoom());
  if (!reply.is_int()) {
    return std::move(done).Run(false,
                               base::Value("Backdrop regions are a list"));
  }
  UpdateGlassSurface();
  std::move(done).Run(true, base::Value());
}

void ShellHostView::PopoverCall(const std::string& method,
                                const base::DictValue& args,
                                Done done) {
  if (!popovers_ || !shell_contents()) {
    return std::move(done).Run(false,
                               base::Value("Popovers are unavailable"));
  }
  std::optional<std::string> error;
  if (method == "shell.popover.open" && !popover::kPopoverRendererShipped) {
    error = "Native popover panels wait for a popover renderer in apps/desktop";
  } else if (method == "shell.popover.open") {
    error = popovers_->Open(args, shell_contents()->GetNativeView(), ShellZoom());
  } else if (method == "shell.popover.update") {
    error = popovers_->Update(args, shell_contents()->GetNativeView(), ShellZoom());
  } else {
    error = popovers_->Close(args);
  }
  if (error) {
    return std::move(done).Run(false, base::Value(*error));
  }
  std::move(done).Run(true, base::Value());
}

std::optional<std::string> ShellHostView::PopoverBootstrapJson(
    const content::WebContents* contents) const {
  return popovers_ ? popovers_->BootstrapJson(contents) : std::nullopt;
}

void ShellHostView::OnMenuCommand(const std::string& command,
                                  const std::string& argument) {
  if (command.empty() || shortcut_recording_) {
    return;
  }
  if (command == "quit" && !shell_policy::ShellTakesQuit(RendererLive(), shell_ready_generation_, renderer_generation_)) {
    return QuitWithoutShell();
  }
  if (command == "focusCommandBar" || command == "newTab") {
    FocusShell();
  }
  base::DictValue payload;
  payload.Set("command", command);
  payload.Set("arg", argument.empty() ? base::Value() : base::Value(argument));
  payload.Set("windowId", window_id_);
  payload.Set("source", "menu");
  Emit("ArdiaShell", "onCommand", base::Value(std::move(payload)));
}

void ShellHostView::SetMainMenu(const base::DictValue& args, Done done) {
  const base::Value* items = args.Find("items");
  if (!items) {
    return std::move(done).Run(false, base::Value("A menu needs items"));
  }
  ParsedMenu parsed = ParseMenu(*items);
  if (!parsed.problems.empty()) {
    return std::move(done).Run(
        false, base::Value("Invalid menu at " + parsed.problems[0].path + ": " +
                           parsed.problems[0].reason));
  }
  SetWindowMainMenu(window_id_, std::move(parsed.root), MainMenuHandler());
  std::move(done).Run(true, base::Value());
}

void ShellHostView::ShowShellContextMenu(const base::DictValue& args, Done done) {
  const base::Value* items = args.Find("items");
  const base::DictValue* point = args.FindDict("point");
  const double zoom = ShellZoom();
  const double x = point ? point->FindDouble("x").value_or(NAN) : NAN;
  const double y = point ? point->FindDouble("y").value_or(NAN) : NAN;
  if (!items || !std::isfinite(x) || !std::isfinite(y) || !shell_contents()) {
    return std::move(done).Run(
        false, base::Value("A context menu needs items and a point"));
  }
  ParsedMenu parsed = ParseMenu(*items);
  if (!parsed.problems.empty()) {
    return std::move(done).Run(
        false, base::Value("Invalid menu at " + parsed.problems[0].path + ": " +
                           parsed.problems[0].reason));
  }
  ardia_mac::ShowContextMenu(
      base::BindOnce(
          [](base::WeakPtr<ShellHostView> host, content::WeakDocumentPtr document,
             uint64_t generation) {
            return host ? host->LiveShellView(document, generation)
                        : gfx::NativeView();
          },
          GetWeakPtr(), renderer_document_, renderer_generation_),
      gfx::Point(glass::ClampToInt(x * zoom), glass::ClampToInt(y * zoom)),
      parsed.root, BackgroundInstance(),
      base::BindOnce(
          [](Done done, std::optional<MenuChoice> choice) {
            if (!choice) {
              return std::move(done).Run(true, base::Value());
            }
            std::move(done).Run(
                true, base::Value(base::DictValue()
                                      .Set("command", choice->command)
                                      .Set("arg", choice->argument)));
          },
          std::move(done)));
}

void ShellHostView::SetTrafficLights(const base::DictValue& args, Done done) {
  views::Widget* widget = browser_view_ ? browser_view_->GetWidget() : nullptr;
  if (!widget) {
    return std::move(done).Run(false, base::Value("No window"));
  }
  const gfx::Size size = widget->GetWindowBoundsInScreen().size();
  const base::DictValue* center = args.FindDict("center");
  const std::optional<window::Lights> lights = window::LightsFrom(
      center ? center->FindDouble("x") : std::nullopt,
      center ? center->FindDouble("y") : std::nullopt,
      args.FindBool("hidden").value_or(false),
      window::Size{static_cast<double>(size.width()),
                   static_cast<double>(size.height())},
      ShellZoom());
  if (!lights) {
    return std::move(done).Run(false,
                               base::Value("Traffic light centers must be finite"));
  }
  ardia_mac::SetTrafficLights(widget, *lights);
  std::move(done).Run(true, base::Value());
}

void ShellHostView::NavigateUtility(base::DictValue utility) {
  utility_ = std::move(utility);
  if (utility_ready_) {
    Emit("ArdiaShell", "onUtilityNavigation", base::Value(utility_.Clone()));
  }
}

void ShellHostView::ActivateWindow() {
  if (browser_ && !BackgroundInstance()) {
    browser_->GetWindow()->Activate();
  }
}

void ShellHostView::OpenWindow(const base::ListValue* values, Done done) {
  const std::string id = values && !values->empty() && (*values)[0].is_string()
                             ? (*values)[0].GetString()
                             : std::string();
  const base::DictValue* options =
      values && values->size() > 1 ? (*values)[1].GetIfDict() : nullptr;
  const std::string kind = options ? Text(*options, "kind") : std::string();
  const std::string profile = options ? Text(*options, "profile") : std::string();
  const shell_policy::WindowRefusal refusal = shell_policy::CheckWindowRequest(
      {id, kind, profile,
       options && options->FindBool("incognito").value_or(false),
       options && options->FindDict("privateWindow")});
  if (refusal == shell_policy::WindowRefusal::kInvalid) {
    return std::move(done).Run(
        false, Failure("ERR_WINDOW_REQUEST", "Invalid native window request"));
  }
  if (refusal == shell_policy::WindowRefusal::kPrivateUnavailable) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_UNAVAILABLE",
                       "Private windows are not in the Mac WebUI shell yet"));
  }
  if (refusal == shell_policy::WindowRefusal::kProfile) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_INVALID", "Invalid profile"));
  }
  const bool utility = shell_policy::UtilityKind(kind);
  base::DictValue place;
  if (utility && options) {
    if (const base::DictValue* settings = options->FindDict("settings")) {
      place = settings->Clone();
    }
    if (const std::string* source = options->FindString("importSource")) {
      place.Set("importSource", *source);
    }
  }
  if (ShellHostView* existing = HostForWindow(id)) {
    if (existing->is_utility() && !place.empty()) {
      existing->NavigateUtility(std::move(place));
    }
    if (!options || options->FindBool("focus").value_or(true)) {
      existing->ActivateWindow();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (!app_profile_ || !browser_ || closing_) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_UNAVAILABLE", "No window to open from"));
  }
  const gfx::Rect bounds = browser_->GetWindow()->GetBounds();
  const window::Frame opener{static_cast<double>(bounds.x()),
                             static_cast<double>(bounds.y()),
                             static_cast<double>(bounds.width()),
                             static_cast<double>(bounds.height())};
  std::optional<window::Frame> requested;
  const base::ListValue* wanted = options ? options->FindList("frame") : nullptr;
  if (!utility && wanted && wanted->size() == 4 &&
      std::ranges::all_of(*wanted, [](const base::Value& value) {
        return value.is_int() || value.is_double();
      })) {
    if (const std::optional<window_policy::Frame> parsed = window_policy::FrameFrom(
            (*wanted)[0].GetDouble(), (*wanted)[1].GetDouble(), (*wanted)[2].GetDouble(),
            (*wanted)[3].GetDouble())) {
      std::vector<window::Frame> screens;
      if (window_events_) {
        for (const window_policy::Frame& screen : window_events_->Screens()) {
          screens.push_back(window::Frame{screen.x, screen.y, screen.width, screen.height});
        }
      }
      requested = window::PlacedOnScreens(
          window::Frame{parsed->x, parsed->y, parsed->width, parsed->height}, screens);
    }
  }
  const window::Frame frame =
      utility ? window::UtilityFrameOver(opener, kind)
              : requested.value_or(window::CascadedFrom(opener));
  OpenPlacement placement;
  placement.focus = !options || options->FindBool("focus").value_or(true);
  placement.maximized = !utility && options && options->FindBool("maximized").value_or(false);
  if (const std::string* behind = options ? options->FindString("behind") : nullptr) {
    placement.behind = *behind;
  }
  WindowSpec spec;
  spec.id = id;
  spec.kind = std::string(shell_policy::WindowKindFor(kind));
  spec.title = options ? Text(*options, "title") : std::string();
  spec.page_profile = std::string(shell_policy::PageProfileFor(kind, profile));
  spec.startup = false;
  spec.utility = std::move(place);
  if (!OpenShellWindow(app_profile_, std::move(spec),
                       gfx::Rect(glass::ClampToInt(frame.x, 1e5),
                                 glass::ClampToInt(frame.y, 1e5),
                                 std::max(1, glass::ClampToInt(frame.width, 1e5)),
                                 std::max(1, glass::ClampToInt(frame.height, 1e5))),
                       placement)) {
    return std::move(done).Run(
        false, Failure("ERR_WINDOW_OPEN", "The window could not open"));
  }
  std::move(done).Run(true, base::Value());
}

void ShellHostView::WriteSession(const base::DictValue& args, Done done) {
  const base::DictValue* base = args.FindDict("base");
  const base::DictValue* local = args.FindDict("session");
  if (!base || !local || !ardia::ValidLinuxSession(*base) ||
      !ardia::ValidLinuxSession(*local)) {
    return std::move(done).Run(
        false, base::Value("session.write requires bounded base and session objects"));
  }
  if (close_.phase() == window_policy::ClosePhase::kAcknowledged ||
      close_.phase() == window_policy::ClosePhase::kClosing) {
    return std::move(done).Run(
        false, Failure("ERR_DOCUMENT_CLOSING", "Window is closing"));
  }
  SessionFiles()->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&MergeAndWriteSession, base->Clone(), local->Clone()),
      base::BindOnce(
          [](std::string window, base::DictValue source, Done done,
             MergedSession merged) {
            if (!merged.ok) {
              return std::move(done).Run(
                  false, base::Value("Could not merge and persist the session"));
            }
            std::move(done).Run(true, base::Value(merged.session.Clone()));
            BroadcastSession(merged, window, &source);
          },
          window_id_, local->Clone(), std::move(done)));
}

void ShellHostView::ForwardRecordedKey(const input::NativeWebKeyboardEvent& event) {
  content::WebContents* shell = shell_contents();
  content::RenderWidgetHostView* view = shell ? shell->GetRenderWidgetHostView() : nullptr;
  if (view && view->GetRenderWidgetHost()) {
    view->GetRenderWidgetHost()->ForwardKeyboardEvent(event);
  }
}

void ShellHostView::WatchRecordedKeys(bool recording) {
  if (!recording) {
    recording_keys_.reset();
    return;
  }
  if (recording_keys_) {
    return;
  }
  views::Widget* widget = browser_view_ ? browser_view_->GetWidget() : nullptr;
  NSWindow* ns_window = widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
  if (!ns_window) {
    return;
  }
  recording_keys_ = std::make_unique<RecordingKeys>();
  base::WeakPtr<ShellHostView> weak = GetWeakPtr();
  NSWindow* __weak watched = ns_window;
  recording_keys_->monitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                   handler:^NSEvent*(NSEvent* event) {
                                     ShellHostView* host = weak.get();
                                     const NSEventModifierFlags flags = event.modifierFlags;
                                     if (!host ||
                                         shell_policy::RecordingRouteFor(
                                             host->shortcut_recording_,
                                             watched && event.window == watched,
                                             (flags & (NSEventModifierFlagCommand |
                                                       NSEventModifierFlagControl)) != 0) !=
                                             shell_policy::RecordingRoute::kToShell) {
                                       return event;
                                     }
                                     host->ForwardRecordedKey(input::NativeWebKeyboardEvent(
                                         gfx::NativeEvent(base::apple::OwnedNSEvent(event))));
                                     return nil;
                                   }];
}

void ShellHostView::CaptionDoubleClick(Done done) {
  views::Widget* widget = browser_view_ ? browser_view_->GetWidget() : nullptr;
  NSWindow* ns_window =
      widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
  NSUserDefaults* defaults = NSUserDefaults.standardUserDefaults;
  NSString* action = [defaults stringForKey:@"AppleActionOnDoubleClick"];
  id legacy = [defaults objectForKey:@"AppleMiniaturizeOnDoubleClick"];
  const window::CaptionAction chosen = window::CaptionActionFor(
      action ? std::optional<std::string>(base::SysNSStringToUTF8(action))
             : std::nullopt,
      [legacy respondsToSelector:@selector(boolValue)]
          ? std::optional<bool>([legacy boolValue])
          : std::nullopt,
      BackgroundInstance());
  if (!ns_window || chosen == window::CaptionAction::kNone) {
    return std::move(done).Run(true, base::Value("none"));
  }
  if (chosen == window::CaptionAction::kMinimize) {
    [ns_window performMiniaturize:nil];
  } else {
    [ns_window performZoom:nil];
  }
  std::move(done).Run(true, base::Value(window::CaptionActionName(chosen)));
}

void ShellHostView::WatchWindowDrag() {
  views::Widget* widget = browser_view_ ? browser_view_->GetWidget() : nullptr;
  NSWindow* ns_window =
      widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
  if (!ns_window || drag_) {
    return;
  }
  drag_ = std::make_unique<WindowDrag>();
  WindowDrag* state = drag_.get();
  NSWindow* __weak watched = ns_window;
  state->monitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp
                                   handler:^NSEvent*(NSEvent* event) {
                                     const bool down = event.type == NSEventTypeLeftMouseDown;
                                     state->mouse_down = down && event.window == watched ? event : nil;
                                     return event;
                                   }];
  for (NSNotificationName name : {NSWindowDidResignKeyNotification, NSWindowWillCloseNotification}) {
    [state->observers addObject:[NSNotificationCenter.defaultCenter
                                    addObserverForName:name
                                                object:ns_window
                                                 queue:nil
                                            usingBlock:^(NSNotification*) {
                                              state->mouse_down = nil;
                                            }]];
  }
}

void ShellHostView::StopWatchingWindowDrag() {
  if (!drag_) {
    return;
  }
  if (drag_->monitor) {
    [NSEvent removeMonitor:drag_->monitor];
  }
  for (id observer in drag_->observers) {
    [NSNotificationCenter.defaultCenter removeObserver:observer];
  }
  drag_.reset();
}

void ShellHostView::StartWindowMove(Done done) {
  views::Widget* widget = browser_view_ ? browser_view_->GetWidget() : nullptr;
  NSWindow* ns_window =
      widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
  NSEvent* current = [NSApp currentEvent];
  NSEvent* retained = drag_ ? drag_->mouse_down : nil;
  const window::MouseEvent kind =
      current.type == NSEventTypeLeftMouseDown      ? window::MouseEvent::kLeftDown
      : current.type == NSEventTypeLeftMouseDragged ? window::MouseEvent::kLeftDragged
                                                    : window::MouseEvent::kOther;
  const window::DragStart start = window::WindowDragFor(
      kind, ns_window && current.window == ns_window,
      (NSEvent.pressedMouseButtons & 1) != 0,
      ns_window && retained.window == ns_window);
  if (!ns_window || !start.start) {
    return std::move(done).Run(true, base::Value(false));
  }
  [ns_window performWindowDragWithEvent:start.use_retained_down ? retained : current];
  std::move(done).Run(true, base::Value(true));
}

void ShellHostView::OnTabStripModelChanged(
    TabStripModel* tab_strip_model,
    const TabStripModelChange& change,
    const TabStripSelectionChange& selection) {
  if (change.type() == TabStripModelChange::kRemoved) {
    for (const auto& removed : change.GetRemove()->contents) {
      const int id = TabId(removed.contents);
      offered_.Forget(id);
      unclaimed_.erase(id);
      const bool deleted =
          removed.remove_reason == TabRemovedReason::kDeleted ||
          removed.remove_reason == TabRemovedReason::kDeletedAndExpandSidePanel;
      if (page_policy::StripExitFor(deleted, true) != page_policy::StripExit::kDestroyed &&
          BindsContents(removed.contents)) {
        base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
            FROM_HERE, base::BindOnce(&ShellHostView::DropDetachedBinding, GetWeakPtr(),
                                      id, removed.contents->GetWeakPtr()));
      }
    }
  }
  if (change.type() == TabStripModelChange::kReplaced) {
    const TabStripModelChange::Replace* replace = change.GetReplace();
    ReplaceBinding(replace->old_contents, replace->new_contents);
  }
  if (change.type() == TabStripModelChange::kInserted && !closing_) {
    for (const auto& inserted : change.GetInsert()->contents) {
      NoteUnclaimedTab(inserted.contents,
                       selection.active_tab_changed() &&
                           selection.new_contents == inserted.contents);
    }
  }
  ReattachViewports();
  if (system_ && (change.type() == TabStripModelChange::kRemoved ||
                  change.type() == TabStripModelChange::kInserted)) {
    system_->SyncWatchesSoon();
  }
}

bool ShellHostView::BindsContents(const content::WebContents* contents) const {
  return contents && std::ranges::any_of(bindings_, [contents](const auto& entry) {
           return entry.second->contents() == contents;
         });
}

void ShellHostView::NoteUnclaimedTab(content::WebContents* contents, bool active) {
  const int id = TabId(contents);
  if (!contents || id <= 0 || BindsContents(contents)) {
    return;
  }
  unclaimed_[id] = PendingTab{contents->GetWeakPtr(), active};
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&ShellHostView::AnnounceUnclaimedTab,
                                GetWeakPtr(), id, 0));
}

base::DictValue ShellHostView::OfferTab(content::WebContents* contents,
                                        bool active) {
  offered_.Add(TabId(contents), contents->GetWeakPtr(), active);
  Profile* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  return base::DictValue()
      .Set("adoptId", "tab:" + base::NumberToString(TabId(contents)))
      .Set("url", contents->GetVisibleURL().spec())
      .Set("profile", std::string(shell_policy::OfferedProfile(
                          profile ? ProfileName(profile) : std::string())))
      .Set("active", active);
}

void ShellHostView::AnnounceUnclaimedTab(int id, int tries) {
  const auto found = unclaimed_.find(id);
  if (found == unclaimed_.end()) {
    return;
  }
  content::WebContents* contents = found->second.contents.get();
  const bool in_window = contents && OwnerOf(contents);
  const GURL url = contents ? contents->GetVisibleURL() : GURL();
  switch (shell_policy::NextUnclaimedStep(
      in_window, BindsContents(contents),
      handler_ && unclaimed_listener_ == renderer_generation_,
      url.is_empty() || url.IsAboutBlank(), tries)) {
    case shell_policy::UnclaimedStep::kWait:
      base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE,
          base::BindOnce(&ShellHostView::AnnounceUnclaimedTab, GetWeakPtr(),
                         id, tries + 1),
          base::Milliseconds(25));
      return;
    case shell_policy::UnclaimedStep::kPark:
      return;
    case shell_policy::UnclaimedStep::kDrop:
      unclaimed_.erase(found);
      return;
    case shell_policy::UnclaimedStep::kReport: {
      const bool active = found->second.active;
      unclaimed_.erase(found);
      Emit("ArdiaTabs", "unclaimed", base::Value(OfferTab(contents, active)));
      return;
    }
  }
}

void ShellHostView::ListUnclaimedTabs(Done done) {
  if (!browser_) {
    return std::move(done).Run(false, base::Value("This window has no tabs"));
  }
  unclaimed_listener_ = renderer_generation_;
  base::ListValue tabs;
  offered_.Prune([this](int, const auto& offer) {
    content::WebContents* contents = offer.handle.get();
    return contents && !BindsContents(contents) && OwnerOf(contents);
  });
  std::vector<std::pair<content::WebContents*, bool>> replay;
  for (const auto& [id, offer] : offered_.offers()) {
    replay.emplace_back(offer.handle.get(), offer.active);
  }
  for (const auto& [contents, active] : replay) {
    tabs.Append(OfferTab(contents, active));
  }
  for (auto it = unclaimed_.begin(); it != unclaimed_.end();) {
    content::WebContents* contents = it->second.contents.get();
    const bool active = it->second.active;
    it = unclaimed_.erase(it);
    if (contents && OwnerOf(contents) && !BindsContents(contents)) {
      tabs.Append(OfferTab(contents, active));
    }
  }
  std::move(done).Run(true, base::Value(std::move(tabs)));
}

content::WebContents* ShellHostView::MemberTab(int id, Profile* profile) const {
  for (BrowserWindowInterface* member : Members()) {
    if (member->GetProfile() != profile) {
      continue;
    }
    TabStripModel* model = member->GetTabStripModel();
    for (int index = 0; index < model->count(); ++index) {
      content::WebContents* contents = model->GetWebContentsAt(index);
      if (TabId(contents) == id) {
        return contents;
      }
    }
  }
  return nullptr;
}

bool ShellHostView::HandleKeyboardEvent(
    content::WebContents* source,
    const input::NativeWebKeyboardEvent& event) {
  if (shortcut_recording_ && source == shell_contents()) {
    return true;
  }
  if (!focus_manager_) {
    return false;
  }
  return unhandled_keys_.HandleKeyboardEvent(event, focus_manager_);
}

bool ShellHostView::AcceleratorPressed(const ui::Accelerator& accelerator) {
  if (!CanHandleAccelerators()) {
    return false;
  }
  auto found = shortcuts_.find(accelerator);
  if (found == shortcuts_.end()) {
    return false;
  }
  if (shell_policy::ShortcutActionFor(
          found->second.FindBool("suppressed").value_or(false)) ==
      shell_policy::ShortcutAction::kConsume) {
    return true;
  }
  const std::string command = Text(found->second, "command");
  if (command == "tabSwitcher" && !switcher_capture_) {
    NoteSwitcherSource();
  }
  if (command == "focusCommandBar" || command == "newTab" || command == "tabSwitcher") {
    FocusShell();
  }
  base::DictValue payload;
  payload.Set("command", command);
  if (const base::Value* arg = found->second.Find("arg")) {
    payload.Set("arg", arg->Clone());
  } else {
    payload.Set("arg", base::Value());
  }
  payload.Set("windowId", window_id_);
  payload.Set("shortcutModifiers", accelerator.modifiers());
  Emit("ArdiaShell", "onCommand", base::Value(std::move(payload)));
  return true;
}

bool ShellHostView::CanHandleAccelerators() const {
  return shell_policy::AcceleratorsLive(browser_ != nullptr, handler_ != nullptr,
                                        shortcut_recording_);
}

void ShellHostView::SetKeyboardShortcuts(const base::ListValue* values,
                                         Done done) {
  if (!focus_manager_ || !values || values->empty() ||
      !(*values)[0].is_list() || (*values)[0].GetList().size() > 256) {
    return std::move(done).Run(false,
                               base::Value("Invalid keyboard shortcut table"));
  }
  std::map<ui::Accelerator, base::DictValue> shortcuts;
  for (const base::Value& value : (*values)[0].GetList()) {
    if (!value.is_dict()) {
      continue;
    }
    const base::DictValue& binding = value.GetDict();
    const int key = binding.FindInt("keyCode").value_or(0);
    const int flags = binding.FindInt("modifiers").value_or(-1);
    if (!shell_policy::ShortcutAccepted(
            key, flags, !Text(binding, "command").empty(),
            binding.FindBool("suppressed").value_or(false))) {
      continue;
    }
    shortcuts.emplace(ui::Accelerator(static_cast<ui::KeyboardCode>(key), flags),
                      binding.Clone());
  }
  focus_manager_->UnregisterAccelerators(this);
  shortcuts_ = std::move(shortcuts);
  for (const auto& [accelerator, binding] : shortcuts_) {
    focus_manager_->RegisterAccelerator(
        accelerator,
        shell_policy::ShortcutTimingFor(
            binding.FindBool("notInText").value_or(false)) ==
                shell_policy::ShortcutTiming::kBeforePage
            ? ui::AcceleratorManager::kHighPriority
            : ui::AcceleratorManager::kNormalPriority,
        this);
  }
  std::move(done).Run(true, base::Value());
}

BEGIN_METADATA(ShellHostView)
END_METADATA

}
