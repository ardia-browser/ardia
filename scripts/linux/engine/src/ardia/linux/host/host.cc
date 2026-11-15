// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/host/host.h"

#include <cmath>
#include <memory>
#include <utility>
#include <vector>

#include "ardia/core/ac_host_visibility.h"
#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/app_lifetime.h"
#include "ardia/linux/browser_window/browser_window.h"
#include "ardia/linux/log.h"
#include "ardia/linux/browser_window/web_contents_delegate.h"
#include "ardia/linux/host/input_region.h"
#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "ardia/win/page_links.h"
#include "ardia/win/private_sessions.h"
#include "ardia/win/profiles.h"
#include "ardia/win/tab_calls.h"
#include "ardia/win/tab_events.h"
#include "ardia/win/tab_state.h"
#include "base/auto_reset.h"
#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/lifetime/browser_shutdown.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/ui/exclusive_access/exclusive_access_manager.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/tabs/tab_enums.h"
#include "chrome/browser/ui/tabs/tab_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model_delegate.h"
#include "chrome/browser/ui/unload_controller.h"
#include "components/tabs/public/tab_interface.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "ui/compositor/compositor.h"
#include "ui/events/event.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

using ardia_win::Error;
using ardia_win::PageLinks;
using ardia_win::PrivateSessions;
using ardia_win::TabEvents;
using ardia_win::TabState;

constexpr char kOfferedPrefix[] = "ardiacore:";
constexpr int kOpenRequestTries = 20;
constexpr base::TimeDelta kOpenRequestWait = base::Milliseconds(25);

base::DictValue Ok() {
  base::DictValue result;
  result.Set("ok", true);
  return result;
}

int Integer(const base::DictValue& args, std::string_view key) {
  return static_cast<int>(args.FindDouble(key).value_or(0));
}

std::string Text(const base::DictValue& args, std::string_view key) {
  const std::string* value = args.FindString(key);
  return value ? *value : std::string();
}

bool SimulatesBackground(const base::DictValue& args) {
  return args.FindBool("background").value_or(false) &&
         ardiacore::TestInstance();
}

}

Host::Host() = default;

Host::~Host() = default;

Host* Host::Get() {
  static base::NoDestructor<Host> host;
  return host.get();
}

void Host::Start() {
  if (started_) {
    return;
  }
  started_ = true;
  browsers_observation_.Observe(GlobalBrowserCollection::GetInstance());
}

void Host::Call(const std::string& verb,
                base::DictValue args,
                const std::string& window,
                ardia_win::Reply reply) {
  if (ardiacore::Traced("host") && verb != "tab.show") {
    Note("host", verb + " key=" + Text(args, "key") + " window=" + window +
                     (args.contains("url") ? " url" : "") +
                     (args.contains("adopt") ? " adopt" : "") +
                     (args.contains("method") ? " " + Text(args, "method")
                                              : ""));
  }
  if (verb == "tab.create") {
    CreateTab(std::move(args), window, std::move(reply));
    return;
  }
  if (verb == "tab.call") {
    content::WebContents* contents = Find(Text(args, "key"));
    if (!contents) {
      std::move(reply).Run(Error("no such tab"));
      return;
    }
    if (std::optional<base::DictValue> done = CallTab(contents, args)) {
      std::move(reply).Run(std::move(*done));
      return;
    }
    if (!ardia_win::CallTabMethod(contents, Text(args, "method"), args,
                                  reply)) {
      std::move(reply).Run(Error("unknown method"));
    }
    return;
  }
  base::DictValue result;
  if (verb == "tab.show") {
    result = ShowTab(args, window);
  } else if (verb == "tab.close") {
    result = CloseTab(args);
  } else if (verb == "tab.discard") {
    result = DiscardOffered(args);
  } else if (verb == "tabs.list") {
    result = ListTabs();
  } else if (verb == "host.info") {
    result = Info();
  } else if (verb == "keyboard.forget") {
    keyboard_wanted_.erase(window);
    result = Ok();
  } else if (verb == "peek.config") {
    PageLinks::Configure(args);
    result = PageLinks::Config();
  } else if (verb == "tab.links") {
    content::WebContents* contents = Find(Text(args, "key"));
    PageLinks* links =
        contents ? PageLinks::FromWebContents(contents) : nullptr;
    result = Ok();
    result.Set("scriptFrames", links ? links->ScriptFrames() : 0);
  } else if (verb == "profile.release") {
    PrivateSessions::Get()->Release(Text(args, "profile"));
    result = Ok();
  } else if (verb == "app.quit") {
    std::move(reply).Run(Ok());
    AppLifetime::Get().RequestQuit();
    return;
  } else {
    result = Error("unknown verb");
  }
  std::move(reply).Run(std::move(result));
}

bool Host::Keeps(const BrowserWindowInterface* browser) const {
  for (const auto& entry : hosted_) {
    if (entry.first == browser) {
      return true;
    }
  }
  return false;
}

BrowserWindow* Host::HostChromeBrowser(Browser* browser) {
  if (browser->GetType() != BrowserWindowInterface::TYPE_NORMAL &&
      browser->GetType() != BrowserWindowInterface::TYPE_POPUP) {
    return nullptr;
  }
  auto* window = new ardia_linux::HostedBrowserWindow(std::string());
  window->AttachBrowser(browser);
  foreign_.insert(browser);
  return window;
}

int Host::BrowsersOf(Profile* profile) const {
  int count = 0;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&](BrowserWindowInterface* browser) {
        count += browser->GetProfile() == profile;
        return true;
      });
  return count;
}

int Host::CloseBrowsersOf(Profile* profile) {
  std::vector<base::WeakPtr<BrowserWindowInterface>> found;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&](BrowserWindowInterface* browser) {
        if (browser->GetProfile() == profile) {
          found.push_back(browser->GetWeakPtr());
        }
        return true;
      });
  for (const base::WeakPtr<BrowserWindowInterface>& weak : found) {
    if (!weak) {
      continue;
    }
    Browser* browser = static_cast<Browser*>(weak.get());
    TabStripModel* model = browser->GetTabStripModel();
    for (int index = 0; model && index < model->count(); ++index) {
      content::WebContents* contents = model->GetWebContentsAt(index);
      TabState* state = TabState::FromWebContents(contents);
      if (!state) {
        continue;
      }
      state->set_closed_by_host();
      HideTab(state->key());
      auto tab = tabs_.find(state->key());
      if (tab != tabs_.end() && tab->second == contents) {
        tabs_.erase(tab);
      }
    }
    hosted_.erase(browser);
    foreign_.erase(browser);
    UnloadController::From(browser)->set_force_skip_warning_user_on_close(
        true);
    browser->GetWindow()->Close();
  }
  return static_cast<int>(found.size());
}

void Host::ForgetProfile(Profile* profile) {
  profile_names_.erase(profile);
}

void Host::TabDestroyed(TabState* state) {
  HideTab(state->key());
  auto found = tabs_.find(state->key());
  if (found != tabs_.end() && found->second == state->web_contents()) {
    tabs_.erase(found);
  }
}

void Host::DeleteClosedTab(content::WebContents* contents) {
  Browser* browser = contents ? BrowserOf(contents) : nullptr;
  if (!browser) {
    return;
  }
  TabStripModel* model = browser->GetTabStripModel();
  const int index = model->GetIndexOfWebContents(contents);
  if (index == TabStripModel::kNoTab) {
    return;
  }
  content::NavigationEntry* committed =
      contents->GetController().GetLastCommittedEntry();
  TabState* state = TabState::FromWebContents(contents);
  if (state) {
    HideTab(state->key());
  }
  if (!contents->GetBrowserContext()->IsOffTheRecord() && committed &&
      !committed->IsInitialEntry() &&
      !(state && state->OnlyShowedOpeningBlank())) {
    model->delegate()->CreateHistoricalTab(contents);
  }
  model->DetachAndDeleteWebContentsAt(index);
}

bool Host::Shows(const std::string& key) const {
  return !key.empty() && shown_.contains(key);
}

std::string Host::WindowOfBrowser(const Browser* browser) const {
  for (const auto& entry : hosted_) {
    if (entry.first == browser) {
      return entry.second.window;
    }
  }
  return std::string();
}

std::string Host::WindowOfContents(content::WebContents* contents) const {
  if (TabState* state = contents ? TabState::FromWebContents(contents)
                                 : nullptr) {
    auto shown = shown_.find(state->key());
    if (shown != shown_.end()) {
      return shown->second.window;
    }
  }
  Browser* browser = contents ? BrowserOf(contents) : nullptr;
  return browser ? WindowOfBrowser(browser) : std::string();
}

std::optional<gfx::Rect> Host::PlaceOf(content::WebContents* contents) const {
  TabState* state = contents ? TabState::FromWebContents(contents) : nullptr;
  auto shown = state ? shown_.find(state->key()) : shown_.end();
  if (shown == shown_.end()) {
    return std::nullopt;
  }
  return shown->second.place;
}

void Host::CreateTab(base::DictValue args,
                     const std::string& window,
                     ardia_win::Reply reply) {
  std::string key = Text(args, "key");
  if (key.empty() || !AppWindows::Get().Find(window)) {
    std::move(reply).Run(Error("a tab needs a key and a window"));
    return;
  }
  std::string adopt = Text(args, "adopt");
  content::WebContents* existing = Find(key);
  if (!existing && !adopt.empty()) {
    existing = FindOffered(adopt);
    if (!existing) {
      std::move(reply).Run(Error("the offered tab is gone"));
      return;
    }
    tabs_[key] = existing;
    TabState::Bind(existing, key)->NoteNavigation();
    TabEvents::Attach(existing);
  }
  if (existing) {
    if (!PlaceTab(existing, window)) {
      std::move(reply).Run(Error("the tab could not move to this window"));
      return;
    }
    base::DictValue result;
    result.Set("tab", TabState::IdOf(existing));
    std::move(reply).Run(std::move(result));
    return;
  }
  std::string profile_name = Text(args, "profile");
  ardia_win::WithProfile(
      profile_name,
      base::BindOnce(&Host::CreateTabInProfile, weak_factory_.GetWeakPtr(),
                     std::move(key), Text(args, "url"), profile_name, window,
                     std::move(reply)));
}

void Host::CreateTabInProfile(std::string key,
                              std::string url,
                              std::string profile_name,
                              std::string window,
                              ardia_win::Reply reply,
                              Profile* profile) {
  if (!profile || !AppWindows::Get().Find(window)) {
    std::move(reply).Run(Error("the profile did not load"));
    return;
  }
  profile_names_[profile] = profile_name;
  if (content::WebContents* existing = Find(key)) {
    PlaceTab(existing, window);
    base::DictValue result;
    result.Set("tab", TabState::IdOf(existing));
    std::move(reply).Run(std::move(result));
    return;
  }
  Browser* browser = BrowserFor(window, profile);
  if (!browser) {
    std::move(reply).Run(Error("no browser for this profile"));
    return;
  }
  content::WebContents* contents = nullptr;
  int64_t opening_navigation_id = 0;
  {
    base::AutoReset<bool> creating(&creating_tab_, true);
    NavigateParams params(browser, GURL(url.empty() ? "about:blank" : url),
                          ui::PAGE_TRANSITION_TYPED);
    params.disposition = WindowOpenDisposition::NEW_BACKGROUND_TAB;
    params.window_action = NavigateParams::WindowAction::kNoAction;
    base::WeakPtr<content::NavigationHandle> opening = Navigate(&params);
    if (opening) {
      opening_navigation_id = opening->GetNavigationId();
    }
    contents = params.navigated_or_inserted_contents;
  }
  if (!contents) {
    std::move(reply).Run(Error("the tab did not open"));
    return;
  }
  tabs_[key] = contents;
  TabState* state = TabState::Bind(contents, key);
  if (url.empty()) {
    state->WatchOpeningBlank(opening_navigation_id);
  }
  state->NoteNavigation();
  TabEvents::Attach(contents);
  base::DictValue result;
  result.Set("tab", TabState::IdOf(contents));
  std::move(reply).Run(std::move(result));
}

base::DictValue Host::ShowTab(const base::DictValue& args,
                              const std::string& window) {
  const std::string key = Text(args, "key");
  content::WebContents* contents = Find(key);
  if (!contents) {
    return Error("no such tab");
  }
  if (!args.FindBool("visible").value_or(true)) {
    HideTab(key);
    return Ok();
  }
  AppWindow* app = AppWindows::Get().Find(window);
  if (!app || !app->view()) {
    return Error("no window");
  }
  if (!PlaceTab(contents, window)) {
    return Error("the tab could not move to this window");
  }
  auto shown = shown_.find(key);
  if (shown != shown_.end() && shown->second.window != window) {
    HideTab(key);
  }
  double scale = 1;
  if (Text(args, "unit") == "px" && app->widget()) {
    scale = app->widget()->GetCompositor()
                ? app->widget()->GetCompositor()->device_scale_factor()
                : 1;
  }
  const double x = args.FindDouble("x").value_or(0) / scale;
  const double y = args.FindDouble("y").value_or(0) / scale;
  const double width = args.FindDouble("width").value_or(0) / scale;
  const double height = args.FindDouble("height").value_or(0) / scale;
  const double radius = args.FindDouble("radius").value_or(0) / scale;
  const gfx::Rect place(static_cast<int>(std::lround(x)),
                        static_cast<int>(std::lround(y)),
                        static_cast<int>(std::lround(x + width)) -
                            static_cast<int>(std::lround(x)),
                        static_cast<int>(std::lround(y + height)) -
                            static_cast<int>(std::lround(y)));
  Browser* browser = BrowserOf(contents);
  TabStripModel* model = browser ? browser->GetTabStripModel() : nullptr;
  const bool first_show = !shown_.contains(key);
  if (model && first_show) {
    const int index = model->GetIndexOfWebContents(contents);
    if (index != TabStripModel::kNoTab && index != model->active_index()) {
      model->ActivateTabAt(index);
    }
  }
  std::vector<RoundedArea> holes =
      InputRegion::HolesFrom(args.FindList("holes"));
  if (scale != 1) {
    for (RoundedArea& hole : holes) {
      hole.rect.InvScale(static_cast<float>(scale));
      hole.radius /= static_cast<float>(scale);
    }
  }
  app->view()->AddPage(key, contents);
  app->view()->PlacePage(key, place, static_cast<int>(std::lround(radius)),
                         holes);
  RoundedArea area;
  area.rect = gfx::RectF(place);
  area.radius = static_cast<float>(radius);
  app->input_region().SetPage(key, area, std::move(holes));
  ardiacore::NoteTabShownByHost(contents, true);
  Shown& entry = shown_[key];
  entry.window = window;
  entry.place = place;
  return Ok();
}

void Host::HideTab(const std::string& key) {
  auto shown = shown_.find(key);
  if (key.empty() || shown == shown_.end()) {
    return;
  }
  const std::string window = shown->second.window;
  shown_.erase(shown);
  auto wanted = keyboard_wanted_.find(window);
  if (wanted != keyboard_wanted_.end() && wanted->second == key) {
    keyboard_wanted_.erase(wanted);
  }
  content::WebContents* contents = Find(key);
  ardiacore::NoteTabShownByHost(contents, false);
  Browser* browser = contents ? BrowserOf(contents) : nullptr;
  if (browser) {
    if (ExclusiveAccessManager* manager =
            ExclusiveAccessManager::From(browser)) {
      manager->OnTabDeactivated(contents);
    }
  }
  if (AppWindow* app = AppWindows::Get().Find(window)) {
    const bool had_keyboard =
        contents && contents->GetRenderWidgetHostView() &&
        contents->GetRenderWidgetHostView()->HasFocus();
    app->input_region().RemovePage(key);
    if (app->view()) {
      app->view()->RemovePage(key);
    }
    if (had_keyboard && app->KeyboardIsHere() && app->ui_contents()) {
      app->ui_contents()->Focus();
    }
  }
}

base::DictValue Host::CloseTab(const base::DictValue& args) {
  const std::string key = Text(args, "key");
  content::WebContents* contents = Find(key);
  if (!contents) {
    return Ok();
  }
  TabState* state = TabState::FromWebContents(contents);
  if (state) {
    state->set_closed_by_host();
  }
  HideTab(key);
  Browser* browser = BrowserOf(contents);
  tabs_.erase(key);
  if (state) {
    state->ReleaseKey();
  }
  if (!browser) {
    return Ok();
  }
  TabStripModel* model = browser->GetTabStripModel();
  const int index = model->GetIndexOfWebContents(contents);
  if (index == TabStripModel::kNoTab) {
    return Ok();
  }
  if (state && state->closing_after_unload()) {
    return Ok();
  }
  if (state && !browser_shutdown::HasShutdownStarted() &&
      contents->NeedToFireBeforeUnloadOrUnloadEvents()) {
    state->CloseAfterUnloadHandlers(
        browser_shutdown::IsTryingToQuit() ||
        UnloadController::From(browser)->is_attempting_to_close_browser());
    return Ok();
  }
  const bool kept_for_reopen = !(state && state->OnlyShowedOpeningBlank());
  model->CloseWebContentsAt(
      index, TabCloseTypes::CLOSE_USER_GESTURE |
                 (kept_for_reopen ? TabCloseTypes::CLOSE_CREATE_HISTORICAL_TAB
                                  : TabCloseTypes::CLOSE_NONE));
  return Ok();
}

base::DictValue Host::DiscardOffered(const base::DictValue& args) {
  content::WebContents* contents = FindOffered(Text(args, "adopt"));
  if (!contents) {
    return Ok();
  }
  TabState* state = TabState::FromWebContents(contents);
  if (state && !state->key().empty()) {
    return Error("the tab is in use");
  }
  Browser* browser = BrowserOf(contents);
  if (!browser) {
    return Ok();
  }
  TabStripModel* model = browser->GetTabStripModel();
  const int index = model->GetIndexOfWebContents(contents);
  if (index != TabStripModel::kNoTab) {
    model->CloseWebContentsAt(index, TabCloseTypes::CLOSE_NONE);
  }
  return Ok();
}

std::optional<base::DictValue> Host::CallTab(content::WebContents* contents,
                                             const base::DictValue& args) {
  const std::string method = Text(args, "method");
  content::NavigationController& controller = contents->GetController();
  if (method == "loadUrl") {
    const bool user_initiated =
        args.FindBool("userInitiated").value_or(false);
    const GURL url(Text(args, "url"));
    if (!user_initiated && url == contents->GetLastCommittedURL() &&
        !contents->IsLoading()) {
      return Ok();
    }
    content::NavigationController::LoadURLParams params(url);
    params.transition_type =
        user_initiated
            ? ui::PageTransitionFromInt(ui::PAGE_TRANSITION_TYPED |
                                        ui::PAGE_TRANSITION_FROM_ADDRESS_BAR)
            : ui::PAGE_TRANSITION_AUTO_TOPLEVEL;
    params.has_user_gesture = user_initiated;
    TabState* state = TabState::FromWebContents(contents);
    if (state && state->OnlyShowedOpeningBlank()) {
      params.should_replace_current_entry = true;
    }
    controller.LoadURLWithParams(params);
  } else if (method == "goBack") {
    if (controller.CanGoBack()) {
      controller.GoBack();
    }
  } else if (method == "goForward") {
    if (controller.CanGoForward()) {
      controller.GoForward();
    }
  } else if (method == "goToOffset") {
    const int offset = Integer(args, "offset");
    if (controller.CanGoToOffset(offset)) {
      controller.GoToOffset(offset);
    }
  } else if (method == "reload") {
    controller.Reload(content::ReloadType::NORMAL, true);
  } else if (method == "forceReload") {
    controller.Reload(content::ReloadType::BYPASSING_CACHE, true);
  } else if (method == "stopLoading") {
    contents->Stop();
  } else if (method == "setMuted") {
    contents->SetAudioMuted(args.FindBool("muted").value_or(false));
  } else if (method == "focus") {
    TabState* state = TabState::FromWebContents(contents);
    auto shown = state ? shown_.find(state->key()) : shown_.end();
    if (shown != shown_.end()) {
      GiveKeyboard(contents, shown->second.window,
                   args.FindBool("follow").value_or(false),
                   SimulatesBackground(args));
    }
  } else {
    return std::nullopt;
  }
  return Ok();
}

void Host::GiveKeyboard(content::WebContents* contents,
                        const std::string& window,
                        bool follow,
                        bool background) {
  TabState* state = TabState::FromWebContents(contents);
  AppWindow* app = AppWindows::Get().Find(window);
  keyboard_wanted_.erase(window);
  if (!state || !app) {
    return;
  }
  if (background || ardiacore::BackgroundInstance() ||
      !app->KeyboardIsHere()) {
    if (background || !ardiacore::BackgroundInstance() ||
        !app->KeyboardIsHere()) {
      keyboard_wanted_[window] = state->key();
    }
    return;
  }
  if (follow && !app->KeyboardIsHere()) {
    return;
  }
  if (Browser* browser = BrowserOf(contents)) {
    TabStripModel* model = browser->GetTabStripModel();
    const int index = model->GetIndexOfWebContents(contents);
    if (index != TabStripModel::kNoTab && index != model->active_index()) {
      model->ActivateTabAt(index);
    }
  }
  contents->Focus();
}

void Host::WindowActivated(const std::string& window) {
  if (!keyboard_wanted_.contains(window)) {
    return;
  }
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&Host::ApplyWantedKeyboard,
                                weak_factory_.GetWeakPtr(), window));
}

void Host::ApplyWantedKeyboard(const std::string& window) {
  auto wanted = keyboard_wanted_.find(window);
  AppWindow* app = AppWindows::Get().Find(window);
  if (wanted == keyboard_wanted_.end() || !app || !app->KeyboardIsHere() ||
      ardiacore::BackgroundInstance()) {
    return;
  }
  const std::string key = wanted->second;
  keyboard_wanted_.erase(wanted);
  auto shown = shown_.find(key);
  content::WebContents* contents = Find(key);
  if (!contents || shown == shown_.end() || shown->second.window != window) {
    return;
  }
  GiveKeyboard(contents, window, true, false);
}

void Host::WindowMoved(const std::string& window) {}

std::string Host::KeyboardPage() const {
  for (const auto& [key, shown] : shown_) {
    content::WebContents* contents = Find(key);
    content::RenderWidgetHostView* view =
        contents ? contents->GetRenderWidgetHostView() : nullptr;
    if (view && view->HasFocus()) {
      return key;
    }
  }
  return std::string();
}

void Host::PagePressed(const std::string& window, const std::string& key) {
  if (key.empty()) {
    return;
  }
  keyboard_wanted_.erase(window);
  if (content::WebContents* contents = Find(key)) {
    if (TabState* state = TabState::FromWebContents(contents)) {
      state->Send("pagePress", base::DictValue());
    }
  }
}

void Host::PageMouse(const std::string& window,
                     const std::string& key,
                     const ui::MouseEvent& event) {
  auto shown = key.empty() ? shown_.end() : shown_.find(key);
  if (shown == shown_.end()) {
    PageLinks::NoteMouse(event, key);
    return;
  }
  ui::MouseEvent in_page(event);
  in_page.set_root_location_f(
      event.root_location_f() -
      gfx::Vector2dF(shown->second.place.x(), shown->second.place.y()));
  PageLinks::NoteMouse(in_page, key);
}

void Host::WindowClosing(const std::string& window) {
  std::vector<std::string> keys;
  for (const auto& [key, shown] : shown_) {
    if (shown.window == window) {
      keys.push_back(key);
    }
  }
  for (const std::string& key : keys) {
    HideTab(key);
  }
  keyboard_wanted_.erase(window);
  for (auto& [browser, hosted] : hosted_) {
    if (hosted.window == window) {
      hosted.window.clear();
    }
  }
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(&Host::CloseSpareBrowsers, weak_factory_.GetWeakPtr()));
}

void Host::CloseSpareBrowsers() {
  std::vector<base::WeakPtr<BrowserWindowInterface>> spare;
  for (const auto& [browser, hosted] : hosted_) {
    if ((hosted.window.empty() || !AppWindows::Get().Find(hosted.window)) &&
        browser->GetTabStripModel()->empty()) {
      spare.push_back(browser->GetWeakPtr());
    }
  }
  for (const base::WeakPtr<BrowserWindowInterface>& weak : spare) {
    if (!weak) {
      continue;
    }
    Browser* browser = static_cast<Browser*>(weak.get());
    hosted_.erase(browser);
    browser->GetWindow()->Close();
  }
}

void Host::BrowserWindowGone(Browser* browser) {
  hosted_.erase(browser);
  foreign_.erase(browser);
}

base::DictValue Host::Info() {
  base::DictValue result;
  result.Set("chromium", version_info::GetVersionNumber());
  result.Set("userDataDir",
             g_browser_process->profile_manager()->user_data_dir().value());
  result.Set("privateSessions", PrivateSessions::Get()->LiveSessions());
  result.Set("pageWindows", static_cast<int>(hosted_.size()));
  result.Set("shownPages", static_cast<int>(shown_.size()));
  result.Set("testInstance", ardiacore::TestInstance());
  result.Set("keyboardPage", KeyboardPage());
  AppWindow* active = AppWindows::Get().LastActive();
  result.Set("keyboardMayMove", active && active->KeyboardIsHere() &&
                                    !ardiacore::BackgroundInstance());
  base::ListValue wanted;
  for (const auto& entry : keyboard_wanted_) {
    wanted.Append(entry.second);
  }
  result.Set("keyboardWanted", std::move(wanted));
  return result;
}

base::DictValue Host::ListTabs() {
  base::ListValue tabs;
  for (const auto& entry : tabs_) {
    content::WebContents* contents = entry.second;
    base::DictValue tab;
    tab.Set("key", entry.first);
    tab.Set("tab", TabState::IdOf(contents));
    tab.Set("url", contents->GetVisibleURL().spec());
    tab.Set("title", base::UTF16ToUTF8(contents->GetTitle()));
    tab.Set("loading", contents->IsLoading());
    tab.Set("session",
            PrivateSessions::Get()->SessionNumber(
                Profile::FromBrowserContext(contents->GetBrowserContext())));
    auto shown = shown_.find(entry.first);
    tab.Set("shown", shown != shown_.end());
    AppWindow* app = shown != shown_.end()
                         ? AppWindows::Get().Find(shown->second.window)
                         : nullptr;
    tab.Set("window", shown != shown_.end() ? shown->second.window
                                             : WindowOfContents(contents));
    tab.Set("windowVisible",
            app && app->widget() && app->widget()->IsVisible());
    const gfx::Rect place =
        shown != shown_.end() ? shown->second.place : gfx::Rect();
    const gfx::Rect window = app ? app->Bounds() : gfx::Rect();
    tab.Set("left", window.x() + place.x());
    tab.Set("top", window.y() + place.y());
    tab.Set("width", place.width());
    tab.Set("height", place.height());
    tab.Set("visibility", static_cast<int>(contents->GetVisibility()));
    tabs.Append(std::move(tab));
  }
  base::DictValue result;
  result.Set("tabs", std::move(tabs));
  return result;
}

content::WebContents* Host::Find(const std::string& key) const {
  auto found = tabs_.find(key);
  return found == tabs_.end() ? nullptr : found->second.get();
}

content::WebContents* Host::FindOffered(const std::string& adopt) const {
  std::string_view prefix = kOfferedPrefix;
  if (!adopt.starts_with(prefix)) {
    return nullptr;
  }
  int id = 0;
  if (!base::StringToInt(adopt.substr(prefix.size()), &id)) {
    return nullptr;
  }
  std::vector<Browser*> browsers;
  for (const auto& entry : hosted_) {
    browsers.push_back(entry.first);
  }
  browsers.insert(browsers.end(), foreign_.begin(), foreign_.end());
  for (Browser* browser : browsers) {
    TabStripModel* model = browser->GetTabStripModel();
    for (int index = 0; index < model->count(); ++index) {
      content::WebContents* contents = model->GetWebContentsAt(index);
      const TabState* state = TabState::FromWebContents(contents);
      if (TabState::IdOf(contents) == id &&
          !(state && state->closed_by_host())) {
        return contents;
      }
    }
  }
  return nullptr;
}

Browser* Host::BrowserFor(const std::string& window, Profile* profile) {
  for (auto& [browser, hosted] : hosted_) {
    if (hosted.window == window && hosted.profile == profile &&
        !browser->IsDeleteScheduled()) {
      return browser;
    }
  }
  return NewBrowser(window, profile);
}

Browser* Host::NewBrowser(const std::string& window, Profile* profile) {
  if (GetBrowserWindowCreationStatusForProfile(*profile) !=
      BrowserWindowInterface::CreationStatus::kOk) {
    return nullptr;
  }
  auto* browser_window = new ardia_linux::HostedBrowserWindow(window);
  BrowserWindowCreateParams params(BrowserWindowInterface::TYPE_NORMAL,
                                   *profile, true);
  params.window = browser_window;
  params.omit_from_session_restore = true;
  params.should_trigger_session_restore = false;
  Browser* browser =
      static_cast<Browser*>(CreateBrowserWindow(std::move(params)));
  if (!browser) {
    return nullptr;
  }
  browser_window->AttachBrowser(browser);
  Hosted hosted;
  hosted.window = window;
  hosted.profile = profile;
  hosted_[browser] = hosted;
  browser->GetTabStripModel()->AddObserver(this);
  return browser;
}

Browser* Host::BrowserOf(content::WebContents* contents) const {
  return static_cast<Browser*>(
      GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents));
}

Browser* Host::OwnerOf(const TabStripModel* model) const {
  for (const auto& entry : hosted_) {
    if (entry.first->GetTabStripModel() == model) {
      return entry.first;
    }
  }
  for (Browser* browser : foreign_) {
    if (browser->GetTabStripModel() == model) {
      return browser;
    }
  }
  return nullptr;
}

bool Host::PlaceTab(content::WebContents* contents, const std::string& window) {
  Profile* profile =
      Profile::FromBrowserContext(contents->GetBrowserContext());
  Browser* from = BrowserOf(contents);
  if (!from) {
    return false;
  }
  auto current = hosted_.find(from);
  if (current != hosted_.end() && current->second.window == window &&
      current->second.profile == profile) {
    return true;
  }
  Browser* target = BrowserFor(window, profile);
  if (!target) {
    return false;
  }
  if (from == target) {
    return true;
  }
  return MoveTab(contents, from, target);
}

bool Host::MoveTab(content::WebContents* contents,
                   Browser* from,
                   Browser* target) {
  TabStripModel* source = from->GetTabStripModel();
  const int index = source->GetIndexOfWebContents(contents);
  if (index == TabStripModel::kNoTab) {
    return false;
  }
  if (TabState* state = TabState::FromWebContents(contents)) {
    HideTab(state->key());
  }
  base::AutoReset<bool> moving(&moving_tab_, true);
  std::unique_ptr<tabs::TabModel> moved =
      source->DetachTabAtForInsertion(index);
  if (!moved) {
    return false;
  }
  TabStripModel* model = target->GetTabStripModel();
  model->InsertDetachedTabAt(model->count(), std::move(moved),
                             AddTabTypes::ADD_NONE);
  return true;
}

void Host::NoteOpened(Browser* browser,
                      TabStripModel* model,
                      content::WebContents* contents,
                      int index,
                      bool foreground) {
  base::DictValue payload;
  payload.Set("adopt", kOfferedPrefix +
                           base::NumberToString(TabState::IdOf(contents)));
  payload.Set("url", contents->GetVisibleURL().spec());
  payload.Set("foreground", foreground);
  const bool foreign = foreign_.contains(browser);
  payload.Set("window", foreign);
  payload.Set("profile", NameOf(browser->GetProfile()));
  if (const base::DictValue* features = PopupFeaturesOf(contents)) {
    payload.Set("popup", true);
    payload.Set("features", features->Clone());
  } else if (browser->GetType() == BrowserWindowInterface::TYPE_POPUP) {
    payload.Set("popup", true);
  }
  std::string opener_key;
  content::WebContents* opener = nullptr;
  if (tabs::TabInterface* opener_tab = model->GetOpenerOfTabAt(index)) {
    opener = opener_tab->GetContents();
  }
  if (!opener) {
    opener = contents->GetFirstWebContentsInLiveOriginalOpenerChain();
  }
  if (opener) {
    if (TabState* state = TabState::FromWebContents(opener)) {
      opener_key = state->key();
    }
  }
  payload.Set("opener", opener_key);
  payload.Set("parent", opener ? WindowOfContents(opener)
                               : WindowOfBrowser(browser));
  payload.Set("fromClick", false);
  if (!foreground || foreign || opener_key.empty() ||
      !ardia_win::OpenRequest::FromWebContents(contents)) {
    ardia_win::Emit("tab.opened", std::move(payload));
    return;
  }
  EmitOpened(std::move(payload), contents->GetWeakPtr(), opener_key, 0);
}

void Host::EmitOpened(base::DictValue payload,
                      base::WeakPtr<content::WebContents> contents,
                      std::string opener_key,
                      int tries) {
  if (!contents) {
    return;
  }
  ardia_win::OpenRequest* request =
      ardia_win::OpenRequest::FromWebContents(contents.get());
  content::WebContents* opener = Find(opener_key);
  PageLinks* links = opener ? PageLinks::FromWebContents(opener) : nullptr;
  const bool linked = request && request->clicked() && links &&
                      links->TakeNewTabLink(
                          {request->url(), contents->GetVisibleURL()});
  if (request && !linked && tries < kOpenRequestTries &&
      (!request->started() || request->clicked())) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&Host::EmitOpened, weak_factory_.GetWeakPtr(),
                       std::move(payload), contents, std::move(opener_key),
                       tries + 1),
        kOpenRequestWait);
    return;
  }
  if (linked) {
    payload.Set("fromClick", true);
    payload.Set("url", request->url().spec());
    if (std::optional<gfx::PointF> point =
            PageLinks::RecentClickPoint(opener_key)) {
      base::DictValue at;
      at.Set("x", point->x());
      at.Set("y", point->y());
      payload.Set("point", std::move(at));
    }
  }
  ardia_win::Emit("tab.opened", std::move(payload));
}

std::string Host::NameOf(Profile* profile) const {
  auto found = profile_names_.find(profile);
  return found == profile_names_.end() ? ardia_win::NameOfProfile(profile)
                                       : found->second;
}

void Host::OnTabStripModelChanged(TabStripModel* tab_strip_model,
                                  const TabStripModelChange& change,
                                  const TabStripSelectionChange& selection) {
  Browser* browser = OwnerOf(tab_strip_model);
  if (!browser) {
    return;
  }
  if (change.type() == TabStripModelChange::kInserted) {
    if (creating_tab_ || moving_tab_) {
      return;
    }
    for (const auto& inserted : change.GetInsert()->contents) {
      content::WebContents* contents = inserted.contents;
      TabState* state = TabState::FromWebContents(contents);
      if (state && (!state->key().empty() || state->closed_by_host())) {
        continue;
      }
      NoteOpened(browser, tab_strip_model, contents, inserted.index,
                 selection.new_contents == contents);
    }
    return;
  }
  if (change.type() == TabStripModelChange::kRemoved) {
    auto orphan = hosted_.find(browser);
    if (orphan != hosted_.end() &&
        (orphan->second.window.empty() ||
         !AppWindows::Get().Find(orphan->second.window)) &&
        tab_strip_model->empty()) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&Host::CloseSpareBrowsers,
                                    weak_factory_.GetWeakPtr()));
    }
    for (const auto& removed : change.GetRemove()->contents) {
      if (removed.remove_reason != TabRemovedReason::kDeleted) {
        continue;
      }
      TabState* state = TabState::FromWebContents(removed.contents);
      if (!state || state->key().empty()) {
        continue;
      }
      HideTab(state->key());
      if (!state->closed_by_host()) {
        state->Send("windowClose", base::DictValue());
      }
      tabs_.erase(state->key());
    }
  }
}

void Host::OnBrowserCreated(BrowserWindowInterface* browser) {
  Browser* created = static_cast<Browser*>(browser);
  if (foreign_.contains(created)) {
    created->GetTabStripModel()->AddObserver(this);
  }
}

void Host::OnBrowserClosed(BrowserWindowInterface* browser) {
  Browser* closed = static_cast<Browser*>(browser);
  hosted_.erase(closed);
  foreign_.erase(closed);
}

}
