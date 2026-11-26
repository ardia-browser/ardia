#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/profiles.h"
#include "ardia/win/webui/webui_bridge.h"
#include "ardia/win/webui/webui_host_internal.h"
#include "ardia/win/webui/webui_host_view.h"
#include "ardia/win/webui/webui_windows.h"
#include "base/auto_reset.h"
#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/tabs/tab_enums.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/zoom/page_zoom.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/reload_type.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/referrer.h"
#include "content/public/common/page_zoom.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "ui/views/controls/webview/webview.h"

namespace ardia_win::webui {

namespace {

constexpr base::TimeDelta kUnclaimedRetry = base::Milliseconds(25);
constexpr int kNavigationEntryLimit = 1000;

bool BlankUrl(const GURL& url) {
  return url.is_empty() || url.IsAboutBlank();
}

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
  base::DictValue lease;
  lease.Set("claim", binding->claim);
  lease.Set("rendererGeneration",
            base::NumberToString(binding->renderer_generation));
  lease.Set("bindingGeneration",
            base::NumberToString(binding->binding_generation));
  lease.Set("documentEpoch", "1");
  base::DictValue snapshot;
  snapshot.Set("watermark", static_cast<double>(binding->sequence));
  snapshot.Set("events", base::ListValue().Append(binding->NavigationEvent()));
  return base::DictValue()
      .Set("browserId", binding->id())
      .Set("chromeTabId", binding->id())
      .Set("lease", std::move(lease))
      .Set("snapshot", std::move(snapshot));
}

void ShellHostView::CreateTab(const base::DictValue& args, Done done) {
  if (!webui_window::ValidTabKey(Text(args, "key")) ||
      !webui_window::ValidClaim(Text(args, "claim"))) {
    return std::move(done).Run(false,
                               base::Value("A key and a claim are required"));
  }
  const base::Value* requested_url = args.Find("url");
  if ((requested_url && !requested_url->is_string()) ||
      !AllowedPageUrl(Text(args, "url"))) {
    return std::move(done).Run(false, base::Value("Invalid or reserved tab URL"));
  }
  if (!browser_ || is_utility()) {
    return std::move(done).Run(false, base::Value("This window has no tabs"));
  }
  const int delay =
      ardiacore::TestInstance()
          ? std::clamp(args.FindInt("testDelayMs").value_or(0), 0, 10000)
          : 0;
  auto start = base::BindOnce(&ShellHostView::StartTab, GetWeakPtr(),
                              args.Clone(), std::move(done), request_handler_,
                              request_generation_);
  if (delay > 0) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, std::move(start), base::Milliseconds(delay));
    return;
  }
  std::move(start).Run();
}

void ShellHostView::StartTab(base::DictValue args,
                             Done done,
                             base::WeakPtr<ShellBridge> origin,
                             uint64_t generation) {
  if (!origin || !OwnsHandler(origin.get(), generation)) {
    return std::move(done).Run(
        false, base::Value("The shell document that asked for this tab is gone"));
  }
  const std::string profile = Text(args, "profile");
  if (profile.empty() || profile == config_.page_profile) {
    return CreateTabIn(std::move(args), std::move(done), std::move(origin),
                       generation, page_profile());
  }
  WithProfile(profile,
              base::BindOnce(&ShellHostView::CreateTabIn, GetWeakPtr(),
                             std::move(args), std::move(done), std::move(origin),
                             generation));
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
  if (!profile || !browser_) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_UNAVAILABLE", "The tab's profile did not load"));
  }
  const std::optional<GURL> url = AllowedPageUrl(Text(args, "url"));
  if (!url) {
    return std::move(done).Run(false, base::Value("Invalid or reserved tab URL"));
  }
  const std::string key = Text(args, "key");
  const std::string claim = Text(args, "claim");
  const bool own = profile == page_profile();
  const webui_window::MemberRoute route =
      webui_window::RouteProfile({.window_private = private_window(),
                                  .window_utility = is_utility(),
                                  .requested_private = profile->IsOffTheRecord(),
                                  .requested_is_window_profile = own,
                                  .window_closing = closing_});
  if (route == webui_window::MemberRoute::kRefuse) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_WINDOW_MISMATCH",
                       "This window cannot hold a tab of that profile"));
  }
  BrowserWindowInterface* member = own ? browser_.get() : EnsureMember(profile);
  if (!member) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_UNAVAILABLE",
                       "The tab's profile has no window to live in"));
  }
  if (PageBinding* existing = BindingForKey(key)) {
    if (!webui_window::CanReclaim(existing->claim, Text(args, "previousClaim"))) {
      return std::move(done).Run(
          false, base::Value("This tab already has an active owner"));
    }
    if (existing->contents()->GetBrowserContext() == profile) {
      existing->claim = claim;
      existing->renderer_generation = renderer_generation_;
      ReattachViewports();
      return std::move(done).Run(true, base::Value(Identity(existing)));
    }
    content::WebContents* retired = existing->contents();
    BrowserWindowInterface* retired_owner = OwnerOf(retired);
    bindings_.erase(existing->id());
    if (retired_owner) {
      TabStripModel* retired_model = retired_owner->GetTabStripModel();
      const int retired_index = retired_model->GetIndexOfWebContents(retired);
      if (retired_index != TabStripModel::kNoTab) {
        base::AutoReset<bool> creating(&creating_tab_, true);
        retired_model->DetachAndDeleteWebContentsAt(retired_index);
      }
    }
    if (!browser_) {
      return std::move(done).Run(
          false, base::Value("The window closed while the tab moved profiles"));
    }
    member = own ? browser_.get() : EnsureMember(profile);
    if (!member) {
      return std::move(done).Run(
          false, Failure("ERR_PROFILE_UNAVAILABLE",
                         "The tab's profile has no window to live in"));
    }
  }
  for (ShellHostView* source : WindowRegistry::Get().Hosts()) {
    if (source == this) {
      continue;
    }
    PageBinding* other = source->BindingForKey(key);
    if (!other) {
      continue;
    }
    BrowserWindowInterface* source_owner = source->OwnerOf(other->contents());
    TabStripModel* source_model =
        source_owner ? source_owner->GetTabStripModel() : nullptr;
    const int index = source_model
                          ? source_model->GetIndexOfWebContents(other->contents())
                          : TabStripModel::kNoTab;
    if (!other->transferable ||
        other->contents()->GetBrowserContext() != profile ||
        index == TabStripModel::kNoTab) {
      return std::move(done).Run(
          false, base::Value("This tab has not been offered for transfer"));
    }
    std::unique_ptr<PageBinding> moved = source->TakeBinding(other->id());
    moved->MoveTo(this);
    {
      base::AutoReset<bool> creating(&creating_tab_, true);
      base::AutoReset<bool> leaving(&source->creating_tab_, true);
      std::unique_ptr<content::WebContents> contents =
          source_model->DetachWebContentsAtForInsertion(index);
      member->GetTabStripModel()->InsertWebContentsAt(
          member->GetTabStripModel()->count(), std::move(contents),
          AddTabTypes::ADD_NONE);
    }
    moved->claim = claim;
    moved->renderer_generation = renderer_generation_;
    PageBinding* binding = moved.get();
    bindings_[binding->id()] = std::move(moved);
    source->ReattachViewports();
    ReattachViewports();
    Note("tab moved from window " + source->window_id() + " to " +
         config_.window_id);
    return std::move(done).Run(true, base::Value(Identity(binding)));
  }
  content::WebContents* contents = nullptr;
  if (const std::optional<int> adopt =
          webui_window::ParseAdoptId(Text(args, "adoptId"))) {
    for (BrowserWindowInterface* candidate : Members()) {
      TabStripModel* model = candidate->GetTabStripModel();
      for (int index = 0; index < model->count(); ++index) {
        content::WebContents* offered = model->GetWebContentsAt(index);
        if (TabId(offered) != *adopt || offered->GetBrowserContext() != profile) {
          continue;
        }
        bool bound = false;
        for (ShellHostView* host : WindowRegistry::Get().Hosts()) {
          bound |= host->BindsTab(offered);
        }
        if (!bound) {
          contents = offered;
        }
      }
    }
  }
  if (!contents) {
    base::AutoReset<bool> creating(&creating_tab_, true);
    NavigateParams params(member, *url, ui::PAGE_TRANSITION_AUTO_TOPLEVEL);
    params.disposition = WindowOpenDisposition::kNewBackgroundTab;
    params.window_action = NavigateParams::WindowAction::kNoAction;
    Navigate(&params);
    contents = params.navigated_or_inserted_contents;
  }
  if (!contents) {
    return std::move(done).Run(false, base::Value("The tab did not open"));
  }
  auto binding = std::make_unique<PageBinding>(this, contents, key,
                                               Text(args, "profile"));
  binding->claim = claim;
  binding->renderer_generation = renderer_generation_;
  PageBinding* created = binding.get();
  const int id = created->id();
  unclaimed_.erase(id);
  announced_.erase(id);
  bindings_[id] = std::move(binding);
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
  if (args.FindDict("rect") && !rect) {
    return std::move(done).Run(
        false, base::Value("Viewport coordinates must be finite and nonnegative "
                           "in size"));
  }
  if (!binding->viewport) {
    binding->viewport = AddChildViewAt(
        MakeViewport(binding->contents()->GetBrowserContext()), 0);
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
  if (!tabs || tabs->size() > webui_window::kPresentationLimit) {
    return std::move(done).Run(false,
                               base::Value("A tab presentation list is required"));
  }
  std::vector<std::pair<PageBinding*, bool>> updates;
  for (const base::Value& tab : *tabs) {
    const base::DictValue* item = tab.GetIfDict();
    PageBinding* binding = item ? ClaimedBinding(*item) : nullptr;
    const std::optional<bool> visible =
        item ? item->FindBool("visible") : std::nullopt;
    if (!binding || !visible) {
      return std::move(done).Run(
          false, base::Value("A claimed tab and boolean visibility are required"));
    }
    updates.emplace_back(binding, *visible);
  }
  std::map<BrowserWindowInterface*, content::WebContents*> activate;
  for (const auto& [binding, visible] : updates) {
    binding->presented = visible;
    if (!visible) {
      continue;
    }
    if (BrowserWindowInterface* owner = OwnerOf(binding->contents())) {
      activate[owner] = binding->contents();
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
  if (!binding) {
    return std::move(done).Run(false, base::Value("No owned live tab"));
  }
  content::WebContents* contents = binding->contents();
  const std::string command = Text(args, "command");
  const base::ListValue* values = Arguments(args);
  content::NavigationController& controller = contents->GetController();
  if (command == "loadUrl") {
    const std::optional<GURL> url =
        values && !values->empty() && (*values)[0].is_string() &&
                !(*values)[0].GetString().empty()
            ? AllowedPageUrl((*values)[0].GetString())
            : std::nullopt;
    if (!url) {
      return std::move(done).Run(false, base::Value("Invalid or reserved URL"));
    }
    controller.LoadURL(*url, content::Referrer(), ui::PAGE_TRANSITION_TYPED,
                       std::string());
    return std::move(done).Run(true, base::Value());
  }
  if (command == "goBack") {
    if (controller.CanGoBack()) {
      controller.GoBack();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (command == "goForward") {
    if (controller.CanGoForward()) {
      controller.GoForward();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (command == "goToOffset") {
    const int offset =
        values && !values->empty() && (*values)[0].is_int() ? (*values)[0].GetInt()
                                                            : 0;
    if (offset != 0 && controller.CanGoToOffset(offset)) {
      controller.GoToOffset(offset);
    }
    return std::move(done).Run(true, base::Value());
  }
  if (command == "reload" || command == "forceReload") {
    controller.Reload(command == "reload" ? content::ReloadType::NORMAL
                                          : content::ReloadType::BYPASSING_CACHE,
                      true);
    return std::move(done).Run(true, base::Value());
  }
  if (command == "stopLoading") {
    contents->Stop();
    return std::move(done).Run(true, base::Value());
  }
  if (command == "focus") {
    if (binding->viewport) {
      binding->viewport->RequestFocus();
    }
    contents->Focus();
    return std::move(done).Run(true, base::Value());
  }
  if (command == "blur") {
    FocusShell();
    return std::move(done).Run(true, base::Value());
  }
  if (command == "zoomStep") {
    const int step =
        values && !values->empty() && (*values)[0].is_int() ? (*values)[0].GetInt()
                                                            : 0;
    zoom::PageZoom::Zoom(contents, step > 0   ? content::PAGE_ZOOM_IN
                                   : step < 0 ? content::PAGE_ZOOM_OUT
                                              : content::PAGE_ZOOM_RESET);
    return std::move(done).Run(true, base::Value());
  }
  if (command == "setMuted") {
    if (!values || values->empty() || !(*values)[0].is_bool()) {
      return std::move(done).Run(false, base::Value("A boolean is required"));
    }
    contents->SetAudioMuted((*values)[0].GetBool());
    return std::move(done).Run(true, base::Value());
  }
  if (command == "close") {
    std::move(done).Run(true, base::Value());
    return CloseContents(contents);
  }
  if (command == "navigationEntries") {
    base::ListValue entries;
    const int count = std::min(controller.GetEntryCount(), kNavigationEntryLimit);
    const int current = controller.GetCurrentEntryIndex();
    for (int index = 0; index < count; ++index) {
      content::NavigationEntry* entry = controller.GetEntryAtIndex(index);
      entries.Append(base::DictValue()
                         .Set("url", entry->GetVirtualURL().spec())
                         .Set("title", base::UTF16ToUTF8(entry->GetTitle()))
                         .Set("current", index == current));
    }
    return std::move(done).Run(true, base::Value(std::move(entries)));
  }
  NoteUnhandled("tab.command " + command);
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
  binding->visible = false;
  binding->presented = false;
  if (binding->viewport) {
    binding->viewport->SetVisible(false);
    binding->viewport->SetWebContents(nullptr);
  }
  ApplyShellInput();
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
                       std::vector<gfx::Rect>& out) {
    if (!list || list->size() > 64) {
      return false;
    }
    for (const base::Value& entry : *list) {
      const std::optional<gfx::Rect> rect = RectFrom(entry.GetIfDict());
      if (!rect) {
        return false;
      }
      if (!rect->IsEmpty()) {
        out.push_back(*rect);
      }
    }
    return true;
  };
  std::vector<gfx::Rect> pages;
  std::vector<gfx::Rect> overlays;
  if (!read(args.FindList("pages"), pages) ||
      !read(args.FindList("overlays"), overlays)) {
    return std::move(done).Run(
        false, base::Value("Input regions need pages and overlays as lists"));
  }
  std::vector<gfx::Rect> pass;
  for (const gfx::Rect& page : pages) {
    std::vector<gfx::Rect> open{page};
    for (const gfx::Rect& overlay : overlays) {
      SubtractFromRegion(open, overlay);
    }
    pass.insert(pass.end(), open.begin(), open.end());
  }
  if (pass.size() != logged_pass_regions_) {
    logged_pass_regions_ = pass.size();
    Note("input regions: " + base::NumberToString(pages.size()) + " pages, " +
         base::NumberToString(overlays.size()) + " overlays, " +
         base::NumberToString(pass.size()) + " pass-through rects");
  }
  pass_ = std::move(pass);
  ApplyShellInput();
  std::move(done).Run(true, base::Value());
}

void ShellHostView::PrepareTransfer(const base::ListValue* values,
                                    bool transferable,
                                    Done done) {
  PageBinding* binding =
      values && !values->empty() && (*values)[0].is_string()
          ? BindingForKey((*values)[0].GetString())
          : nullptr;
  if (!binding) {
    return std::move(done).Run(false, base::Value("No owned tab to transfer"));
  }
  binding->transferable = transferable;
  std::move(done).Run(true, base::Value());
}

void ShellHostView::ClaimLaunchTab(const base::ListValue* values, Done done) {
  if (!values || values->size() != 3 || !(*values)[0].is_string() ||
      !(*values)[1].is_string() || !(*values)[2].is_string()) {
    return std::move(done).Run(
        false, base::Value("A launch key, URL and profile are required"));
  }
  std::move(done).Run(true, base::Value());
}

base::DictValue ShellHostView::UnclaimedOffer(content::WebContents* contents,
                                              bool active) const {
  Profile* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  return base::DictValue()
      .Set("adoptId", std::string(webui_window::kAdoptTabPrefix) +
                          base::NumberToString(TabId(contents)))
      .Set("url", contents->GetVisibleURL().spec())
      .Set("profile", profile == page_profile() ? config_.page_profile
                                                : NameOfProfile(profile))
      .Set("active", active);
}

void ShellHostView::NoteUnclaimedTab(content::WebContents* contents,
                                     bool active) {
  if (!contents || TabId(contents) <= 0) {
    return;
  }
  for (ShellHostView* host : WindowRegistry::Get().Hosts()) {
    if (host->BindsTab(contents)) {
      return;
    }
  }
  const int id = TabId(contents);
  unclaimed_[id] = contents->GetWeakPtr();
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&ShellHostView::AnnounceUnclaimedTab,
                                GetWeakPtr(), id, 0));
  if (active) {
    pending_active_offer_ = id;
  }
}

void ShellHostView::AnnounceUnclaimedTab(int id, int tries) {
  const auto found = unclaimed_.find(id);
  if (found == unclaimed_.end()) {
    return;
  }
  content::WebContents* contents = found->second.get();
  bool claimed = false;
  for (ShellHostView* host : WindowRegistry::Get().Hosts()) {
    claimed |= contents && host->BindsTab(contents);
  }
  const bool in_window = contents && OwnerOf(contents);
  const bool listening =
      handler_ && unclaimed_listener_ == renderer_generation_;
  switch (webui_window::NextUnclaimedStep(
      in_window, claimed, listening,
      in_window && BlankUrl(contents->GetVisibleURL()), tries)) {
    case webui_window::UnclaimedStep::kWait:
      base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE,
          base::BindOnce(&ShellHostView::AnnounceUnclaimedTab, GetWeakPtr(), id,
                         tries + 1),
          kUnclaimedRetry);
      return;
    case webui_window::UnclaimedStep::kPark:
      return;
    case webui_window::UnclaimedStep::kDrop:
      unclaimed_.erase(found);
      return;
    case webui_window::UnclaimedStep::kReport: {
      const bool active = pending_active_offer_ == id;
      unclaimed_.erase(found);
      announced_[id] = contents->GetWeakPtr();
      Emit("ArdiaTabs", "unclaimed", base::Value(UnclaimedOffer(contents, active)));
      return;
    }
  }
}

void ShellHostView::ListUnclaimedTabs(Done done) {
  if (!browser_ || is_utility()) {
    return std::move(done).Run(false, base::Value("This window has no tab strip"));
  }
  unclaimed_listener_ = renderer_generation_;
  base::ListValue tabs;
  const auto unbound = [](content::WebContents* contents) {
    for (ShellHostView* host : WindowRegistry::Get().Hosts()) {
      if (host->BindsTab(contents)) {
        return false;
      }
    }
    return true;
  };
  for (auto it = announced_.begin(); it != announced_.end();) {
    content::WebContents* contents = it->second.get();
    if (!contents || !unbound(contents) || !OwnerOf(contents)) {
      it = announced_.erase(it);
      continue;
    }
    tabs.Append(UnclaimedOffer(contents, false));
    ++it;
  }
  for (auto it = unclaimed_.begin(); it != unclaimed_.end();) {
    content::WebContents* contents = it->second.get();
    if (!contents || !unbound(contents) || !OwnerOf(contents)) {
      it = unclaimed_.erase(it);
      continue;
    }
    const bool active = pending_active_offer_ == it->first;
    announced_[it->first] = contents->GetWeakPtr();
    tabs.Append(UnclaimedOffer(contents, active));
    it = unclaimed_.erase(it);
  }
  std::move(done).Run(true, base::Value(std::move(tabs)));
}

}
