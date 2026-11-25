#include "ardia/win/webui/webui_host_view.h"

#include <windows.h>

#include <dwmapi.h>

#include <algorithm>
#include <memory>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include "ardia/desktop/ac_desktop_platform.h"
#include "ardia/desktop/ac_desktop_window_state.h"
#include "ardia/desktop/generated/ac_desktop_routes.h"
#include "ardia/win/main.h"
#include "ardia/win/private_sessions.h"
#include "ardia/win/profiles.h"
#include "ardia/win/webui/webui_bridge.h"
#include "ardia/win/webui/webui_file_picker.h"
#include "ardia/win/webui/webui_host_internal.h"
#include "ardia/win/webui/webui_storage.h"
#include "ardia/win/webui/webui_updates.h"
#include "ardia/win/webui/webui_windows.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/system/sys_info.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/lifetime/browser_shutdown.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/unload_controller.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "components/input/native_web_keyboard_event.h"
#include "components/sessions/content/session_tab_helper.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/aura/window.h"
#include "ui/aura/window_targeter.h"
#include "ui/base/base_window.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/mojom/window_show_state.mojom.h"
#include "ui/compositor/layer.h"
#include "ui/compositor/layer_type.h"
#include "ui/gfx/geometry/rect_conversions.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/views/controls/native/native_view_host.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/focus/focus_manager.h"
#include "ui/views/view_targeter.h"
#include "ui/views/widget/widget.h"
#include "ui/views/win/hwnd_util.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia_win::webui {

WindowConfig::WindowConfig() = default;
WindowConfig::WindowConfig(WindowConfig&&) = default;
WindowConfig& WindowConfig::operator=(WindowConfig&&) = default;
WindowConfig::~WindowConfig() = default;

namespace {

constexpr size_t kUnhandledLimit = 400;
constexpr char kShellUrl[] = "chrome://ardia/";

class ShellTargeter : public aura::WindowTargeter {
 public:
  explicit ShellTargeter(std::vector<gfx::Rect> shape)
      : shape_(std::move(shape)) {}

  std::unique_ptr<HitTestRects> GetExtraHitTestShapeRects(
      aura::Window* target) const override {
    if (target != window()) {
      return nullptr;
    }
    return std::make_unique<HitTestRects>(shape_);
  }

 private:
  const std::vector<gfx::Rect> shape_;
};

class ShellRootTargeter : public aura::WindowTargeter {
 public:
  explicit ShellRootTargeter(base::WeakPtr<ShellHostView> host)
      : host_(std::move(host)) {}

 protected:
  bool SubtreeShouldBeExploredForEvent(aura::Window* window,
                                       const ui::LocatedEvent& event) override {
    if (host_ && window->parent() == this->window() &&
        host_->HasPassRegions() && host_->IsPageChildWindow(window)) {
      return window->IsVisible() && EventLocationInsideBounds(window, event);
    }
    return aura::WindowTargeter::SubtreeShouldBeExploredForEvent(window, event);
  }

 private:
  base::WeakPtr<ShellHostView> host_;
};

class ViewportView : public views::WebView {
  METADATA_HEADER(ViewportView, views::WebView)

 public:
  explicit ViewportView(content::BrowserContext* profile)
      : views::WebView(profile) {
    if (holder()->layer_managed_by_views()) {
      SetPaintToLayer(ui::LAYER_NOT_DRAWN);
      layer()->SetFillsBoundsOpaquely(false);
    }
  }

  ~ViewportView() override { SetWebContents(nullptr); }
};

BEGIN_METADATA(ViewportView)
END_METADATA

}

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
  if (!webui_window::ValidRect(x, y, width, height)) {
    return std::nullopt;
  }
  return gfx::ToEnclosingRect(gfx::RectF(x, y, width, height));
}

void SubtractFromRegion(std::vector<gfx::Rect>& region, const gfx::Rect& cut) {
  std::vector<gfx::Rect> remaining;
  for (const gfx::Rect& piece : region) {
    gfx::Rect overlap = piece;
    overlap.Intersect(cut);
    if (overlap.IsEmpty()) {
      remaining.push_back(piece);
      continue;
    }
    for (const gfx::Rect& part :
         {gfx::Rect(piece.x(), piece.y(), piece.width(), overlap.y() - piece.y()),
          gfx::Rect(piece.x(), overlap.bottom(), piece.width(),
                    piece.bottom() - overlap.bottom()),
          gfx::Rect(piece.x(), overlap.y(), overlap.x() - piece.x(),
                    overlap.height()),
          gfx::Rect(overlap.right(), overlap.y(), piece.right() - overlap.right(),
                    overlap.height())}) {
      if (!part.IsEmpty()) {
        remaining.push_back(part);
      }
    }
  }
  region = std::move(remaining);
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

std::unique_ptr<views::WebView> MakeViewport(content::BrowserContext* profile) {
  return std::make_unique<ViewportView>(profile);
}

PageBinding::PageBinding(ShellHostView* owner,
                         content::WebContents* contents,
                         std::string key,
                         std::string profile)
    : content::WebContentsObserver(contents),
      owner_(owner),
      id_(TabId(contents)),
      key_(std::move(key)),
      profile_(std::move(profile)) {}

PageBinding::~PageBinding() {
  if (viewport && owner_) {
    viewport->SetWebContents(nullptr);
    owner_->RemoveChildViewT(viewport.get());
  }
  viewport = nullptr;
}

void PageBinding::MoveTo(ShellHostView* owner) {
  if (viewport && owner_) {
    viewport->SetWebContents(nullptr);
    owner_->RemoveChildViewT(viewport.get());
  }
  viewport = nullptr;
  owner_ = owner;
  visible = false;
  presented = false;
  transferable = false;
  claim.clear();
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
  data.Set("themeColor", base::Value());
  data.Set("themeColorSource", base::Value());
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

void PageBinding::ReportNavigation() {
  if (!owner_ || claim.empty() || !web_contents()) {
    return;
  }
  base::DictValue delivery = Envelope("pageEvent");
  delivery.Set("event", NavigationEvent());
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

bool PageBinding::ReportOpenPrivateWindow(const GURL& url,
                                          const std::string& profile) {
  if (!owner_ || claim.empty() || !url.is_valid() ||
      webui_window::PrivateLinkProfile(profile).empty()) {
    return false;
  }
  base::DictValue delivery = Envelope("pageEvent");
  delivery.Set("event",
               base::DictValue()
                   .Set("name", "openWindow")
                   .Set("data", base::DictValue()
                                    .Set("url", url.spec())
                                    .Set("disposition", "incognito")
                                    .Set("profile",
                                         webui_window::PrivateLinkProfile(
                                             profile))));
  owner_->Emit("ArdiaWebView", base::NumberToString(id_),
               base::Value(std::move(delivery)));
  return true;
}

void PageBinding::Rebind(content::WebContents* contents) {
  if (viewport) {
    viewport->SetWebContents(nullptr);
  }
  Observe(contents);
  id_ = TabId(contents);
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

void PageBinding::WebContentsDestroyed() {
  ReportClosed();
  if (viewport) {
    viewport->SetWebContents(nullptr);
  }
  Observe(nullptr);
  if (owner_) {
    owner_->BindingGone(this);
  }
}

ShellHostView::CompanionConfirmation::CompanionConfirmation() = default;
ShellHostView::CompanionConfirmation::~CompanionConfirmation() = default;

ShellHostView::ShellHostView(BrowserWindowInterface* browser,
                             BrowserView* browser_view,
                             Profile* app_profile,
                             WindowConfig config)
    : browser_(browser),
      browser_view_(browser_view),
      app_profile_(app_profile),
      config_(std::move(config)),
      id_(browser->GetSessionID().id()) {
  SetEventTargeter(std::make_unique<views::ViewTargeter>(this));
  caption_ = std::make_unique<CaptionInput>(
      base::BindRepeating(&ShellHostView::EmitMaximizeButtonState,
                          weak_factory_.GetWeakPtr()),
      base::BindRepeating(&ShellHostView::ToggleMaximize,
                          weak_factory_.GetWeakPtr()),
      base::BindRepeating(
          [](base::WeakPtr<ShellHostView> host) {
            return host && host->InterceptSystemClose();
          },
          weak_factory_.GetWeakPtr()));
}

ShellHostView::~ShellHostView() {
  DetachBrowser();
  WindowRegistry::Get().Detached(this);
}

void ShellHostView::Initialize() {
  view_observation_.Observe(browser_view_.get());
  if (views::Widget* frame = widget()) {
    widget_observation_.Observe(frame);
  }
  focus_manager_ = GetFocusManager();
  shell_ = AddChildView(std::make_unique<views::WebView>(app_profile_.get()));
  shell_->GetWebContents()->SetDelegate(this);
  transparency_ = std::make_unique<ShellTransparency>(shell_->GetWebContents());
  ObserveMember(browser_);
  if (views::Widget* frame = widget()) {
    original_targeter_ = frame->GetNativeWindow()->SetEventTargeter(
        std::make_unique<ShellRootTargeter>(GetWeakPtr()));
  }
  caption_->Attach(Hwnd());
  documents_ = DocumentsFor(SessionDirectory());
  LayoutOverlay();
  shell_->LoadInitialURL(GURL(kShellUrl));
  Decorate();
  if (config_.chrome_made) {
    TabStripModel* model = browser_->GetTabStripModel();
    for (int index = 0; index < model->count(); ++index) {
      NoteUnclaimedTab(model->GetWebContentsAt(index),
                       index == model->active_index());
    }
  }
  Note("window " + config_.window_id + " attached to Chromium window " +
       base::NumberToString(id_));
}

void ShellHostView::DetachBrowser() {
  if (!browser_) {
    return;
  }
  closing_ = true;
  RetireRenderer();
  telemetry_.CancelAll();
  file_picker_.reset();
  system_state_subscription_ = {};
  TabStripModelObserver::StopObservingAll(this);
  CloseCompanions();
  for (auto& [id, binding] : bindings_) {
    if (binding->viewport) {
      binding->viewport->SetWebContents(nullptr);
    }
  }
  bindings_.clear();
  caption_->Detach();
  if (focus_manager_) {
    focus_manager_->UnregisterAccelerators(this);
    focus_manager_ = nullptr;
  }
  if (views::Widget* frame = widget(); frame && original_targeter_) {
    frame->GetNativeWindow()->SetEventTargeter(std::move(original_targeter_));
  }
  original_targeter_.reset();
  if (shell_ && shell_->web_contents()) {
    shell_->web_contents()->SetDelegate(nullptr);
  }
  transparency_.reset();
  widget_observation_.Reset();
  view_observation_.Reset();
  if (private_window()) {
    PrivateSessions::Get()->Release(config_.page_profile);
  }
  browser_ = nullptr;
  Note("window " + config_.window_id + " detached");
}

bool ShellHostView::private_window() const {
  return ParseProfileName(config_.page_profile).off_the_record;
}

Profile* ShellHostView::page_profile() const {
  return browser_ ? browser_->GetProfile() : nullptr;
}

content::WebContents* ShellHostView::shell_contents() const {
  return shell_ ? shell_->web_contents() : nullptr;
}

views::Widget* ShellHostView::widget() const {
  return browser_view_ ? browser_view_->GetWidget() : nullptr;
}

HWND ShellHostView::Hwnd() const {
  views::Widget* frame = widget();
  return frame ? views::HWNDForWidget(frame) : nullptr;
}

void ShellHostView::Note(const std::string& line) const {
  LOG(WARNING) << "Ardia WebUI shell: " << line;
  NoteForTest("webui shell: " + line);
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

BrowserWindowInterface* ShellHostView::MemberFor(const Profile* profile) const {
  for (BrowserWindowInterface* member : Members()) {
    if (profile && member->GetProfile() == profile) {
      return member;
    }
  }
  return nullptr;
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

void ShellHostView::ObserveMember(BrowserWindowInterface* member) {
  if (member) {
    member->GetTabStripModel()->AddObserver(this);
  }
}

BrowserWindowInterface* ShellHostView::EnsureMember(Profile* profile) {
  if (!browser_ || !profile) {
    return nullptr;
  }
  if (BrowserWindowInterface* member = MemberFor(profile)) {
    return member;
  }
  const webui_window::MemberRoute route =
      webui_window::RouteProfile({.window_private = private_window(),
                                  .window_utility = is_utility(),
                                  .requested_private = profile->IsOffTheRecord(),
                                  .requested_is_window_profile = false,
                                  .window_closing = closing_});
  if (route != webui_window::MemberRoute::kCompanion ||
      profile->ShutdownStarted() ||
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
  WindowRegistry::Get().RegisterCompanion(created, this);
  companions_.push_back(created->GetWeakPtr());
  ObserveMember(created);
  Note("companion window for another profile joined window " +
       config_.window_id);
  return created;
}

void ShellHostView::CompanionClosed(BrowserWindowInterface* companion) {
  companion->GetTabStripModel()->RemoveObserver(this);
  std::erase_if(companions_, [companion](const auto& weak) {
    return !weak || weak.get() == companion;
  });
  if (active_profile_ && active_profile_.get() == companion->GetProfile()) {
    active_profile_.reset();
  }
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
    UnloadController* unload = UnloadController::From(companion.get());
    if (!unload || !unload->is_attempting_to_close_browser()) {
      while (model->count() > 0) {
        model->DetachAndDeleteWebContentsAt(model->count() - 1);
      }
    }
    companion->GetWindow()->Close();
  }
}

void ShellHostView::SelectProfile(Profile* profile) {
  if (!profile || !MemberFor(profile)) {
    return;
  }
  active_profile_ = profile->GetWeakPtr();
}

bool ShellHostView::BindsTab(const content::WebContents* contents) const {
  return BindingForContents(contents) != nullptr;
}

PageBinding* ShellHostView::BindingForKey(std::string_view key) const {
  for (const auto& [id, binding] : bindings_) {
    if (binding->key() == key && binding->contents()) {
      return binding.get();
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

std::unique_ptr<PageBinding> ShellHostView::TakeBinding(int id) {
  auto found = bindings_.find(id);
  if (found == bindings_.end()) {
    return nullptr;
  }
  std::unique_ptr<PageBinding> taken = std::move(found->second);
  bindings_.erase(found);
  return taken;
}

void ShellHostView::BindingGone(PageBinding* binding) {
  const int id = binding->id();
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
                         host->ApplyShellInput();
                       }
                     },
                     GetWeakPtr(), id));
}

bool ShellHostView::HasPassRegions() const {
  return !pass_.empty();
}

aura::Window* ShellHostView::ChildWindowOf(views::WebView* view) const {
  if (!view || !view->web_contents() || !GetWidget()) {
    return nullptr;
  }
  aura::Window* content = GetWidget()->GetNativeWindow();
  aura::Window* window = view->web_contents()->GetNativeView();
  while (window && window->parent() && window->parent() != content) {
    window = window->parent();
  }
  return window && window->parent() == content ? window : nullptr;
}

bool ShellHostView::IsPageChildWindow(aura::Window* window) const {
  for (const auto& [id, binding] : bindings_) {
    if (binding->viewport && ChildWindowOf(binding->viewport) == window) {
      return true;
    }
  }
  return false;
}

bool ShellHostView::PassesShellPoint(gfx::NativeView child,
                                     const gfx::Point& location) const {
  if (!shell_ || pass_.empty() || !child ||
      (child != ChildWindowOf(shell_) &&
       child != shell_->holder()->GetNativeViewContainer())) {
    return false;
  }
  gfx::Point point = location;
  views::View::ConvertPointFromWidget(shell_, &point);
  return std::ranges::any_of(
      pass_, [&](const gfx::Rect& rect) { return rect.Contains(point); });
}

void ShellHostView::ApplyShellInput() {
  if (!shell_) {
    return;
  }
  aura::Window* container = ChildWindowOf(shell_);
  if (!container) {
    return;
  }
  std::vector<gfx::Rect> shape{gfx::Rect(shell_->size())};
  for (const gfx::Rect& rect : pass_) {
    SubtractFromRegion(shape, rect);
  }
  container->SetEventTargeter(std::make_unique<ShellTargeter>(std::move(shape)));
}

bool ShellHostView::DoesIntersectRect(const views::View* target,
                                      const gfx::Rect& rect) const {
  if (target != shell_) {
    return views::ViewTargeterDelegate::DoesIntersectRect(target, rect);
  }
  gfx::Rect inside = rect;
  inside.Intersect(target->GetLocalBounds());
  if (inside.IsEmpty()) {
    return false;
  }
  std::vector<gfx::Rect> remaining{inside};
  for (const gfx::Rect& pass : pass_) {
    SubtractFromRegion(remaining, pass);
  }
  return !remaining.empty();
}

void ShellHostView::LayoutOverlay() {
  if (!browser_view_) {
    return;
  }
  SetBoundsRect(browser_view_->GetLocalBounds());
  if (shell_) {
    shell_->SetBoundsRect(GetLocalBounds());
  }
  if (views::WebView* chrome_view = browser_view_->GetActiveContentsWebView()) {
    chrome_view->SetVisible(false);
  }
  Restack();
  ApplyShellInput();
}

void ShellHostView::Restack() {
  if (!shell_ || !browser_view_) {
    return;
  }
  browser_view_->ReorderChildView(this, browser_view_->children().size());
  ReorderChildView(shell_, children().size());
}

void ShellHostView::ReattachViewports() {
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
  views::FocusManager* focus = GetFocusManager();
  for (auto& [id, binding] : bindings_) {
    views::WebView* page = binding->viewport;
    content::WebContents* contents = binding->contents();
    if (!page || !contents || !binding->visible) {
      continue;
    }
    if (taken.contains(contents) || page->web_contents() != contents) {
      const bool focused = focus && focus->GetFocusedView() == page;
      if (focused) {
        focus->ClearFocus();
      }
      page->SetWebContents(nullptr);
      page->SetWebContents(contents);
      if (focused) {
        page->RequestFocus();
        contents->Focus();
      }
    }
  }
  Restack();
  ApplyShellInput();
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

void ShellHostView::FocusWindow() {
  if (!browser_) {
    return;
  }
  ui::BaseWindow* window = browser_->GetWindow();
  if (window->IsMinimized()) {
    window->Restore();
  }
  window->Activate();
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
  Note("shell document " + base::NumberToString(renderer_generation_) +
       " is live in window " + config_.window_id);
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

bool ShellHostView::LiveFor(uint64_t generation) const {
  return browser_ && !closing_ && handler_ && generation &&
         renderer_generation_ == generation &&
         renderer_document_.AsRenderFrameHostIfValid() != nullptr;
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
  if (!had_document) {
    return;
  }
  RetireDocuments();
  for (auto& [id, binding] : bindings_) {
    binding->claim.clear();
    binding->renderer_generation = 0;
    binding->transferable = false;
    binding->visible = false;
    if (binding->viewport) {
      binding->viewport->SetVisible(false);
      binding->viewport->SetWebContents(nullptr);
    }
  }
  pass_.clear();
  ApplyShellInput();
  if (ShellBrowserFrameView* frame = ShellFrameOf(browser_view_)) {
    frame->SetMaximizeButton(std::nullopt);
  }
  caption_->Reset();
  unclaimed_listener_.reset();
  open_urls_listener_.reset();
  utility_ready_ = false;
  if (focus_manager_) {
    focus_manager_->UnregisterAccelerators(this);
  }
  shortcuts_.clear();
  Note("shell document retired in window " + config_.window_id +
       "; generation is now " + base::NumberToString(renderer_generation_));
}

void ShellHostView::DeliverReply(base::WeakPtr<ShellBridge> handler,
                                 uint64_t generation,
                                 std::string id,
                                 bool success,
                                 base::Value response) {
  if (!handler || !OwnsHandler(handler.get(), generation)) {
    ++dropped_replies_;
    Note("reply dropped: shell document " + base::NumberToString(generation) +
         " is not the live one (" + base::NumberToString(renderer_generation_) +
         "); " + base::NumberToString(dropped_replies_) + " dropped so far");
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

void ShellHostView::NoteUnhandled(const std::string& method) {
  if (unhandled_.size() >= kUnhandledLimit ||
      std::ranges::find(unhandled_, method) != unhandled_.end()) {
    return;
  }
  unhandled_.push_back(method);
  Note("unhandled host call " + method);
}

void ShellHostView::Decorate() {
  decorations_ = ApplyShellDecorations(Hwnd());
  Note("window decorations: backdrop " +
       base::NumberToString(static_cast<long>(decorations_.backdrop)) +
       ", corners " +
       base::NumberToString(static_cast<long>(decorations_.corners)) +
       ", dark title " +
       base::NumberToString(static_cast<long>(decorations_.dark_title)));
}

base::DictValue ShellHostView::DecorationReport() const {
  HWND hwnd = Hwnd();
  DWM_SYSTEMBACKDROP_TYPE backdrop = DWMSBT_AUTO;
  const HRESULT read_backdrop =
      hwnd ? ::DwmGetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop,
                                     sizeof(backdrop))
           : E_HANDLE;
  BOOL dark = FALSE;
  const HRESULT read_dark =
      hwnd ? ::DwmGetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark,
                                     sizeof(dark))
           : E_HANDLE;
  return base::DictValue()
      .Set("backdropSet", SUCCEEDED(decorations_.backdrop))
      .Set("cornersSet", SUCCEEDED(decorations_.corners))
      .Set("darkTitleSet", SUCCEEDED(decorations_.dark_title))
      .Set("systemDark", decorations_.dark)
      .Set("backdrop", SUCCEEDED(read_backdrop)
                           ? base::Value(static_cast<int>(backdrop))
                           : base::Value())
      .Set("darkTitle",
           SUCCEEDED(read_dark) ? base::Value(dark != FALSE) : base::Value());
}

void ShellHostView::EmitMaximizeButtonState(
    const MaximizeButtonVisualState& state) {
  Emit("ArdiaShell", "maximizeButtonState",
       base::Value(base::DictValue()
                       .Set("windowId", config_.window_id)
                       .Set("hovered", state.hovered)
                       .Set("pressed", state.pressed)));
}

void ShellHostView::ToggleMaximize() {
  ardia::desktop::Platform().CaptionDoubleClick(widget());
}

base::DictValue ShellHostView::WindowState() const {
  views::Widget* frame = widget();
  return base::DictValue()
      .Set("windowId", config_.window_id)
      .Set("maximized", frame && frame->IsMaximized())
      .Set("tiled", false)
      .Set("fullScreen", frame && frame->IsFullscreen());
}

base::ListValue ShellHostView::WindowFrame() const {
  views::Widget* frame = widget();
  const gfx::Rect bounds =
      frame ? frame->GetWindowBoundsInScreen() : gfx::Rect();
  return base::ListValue()
      .Append(bounds.x())
      .Append(bounds.y())
      .Append(bounds.width())
      .Append(bounds.height());
}

void ShellHostView::ReportWindowState() {
  views::Widget* frame = widget();
  if (!frame) {
    return;
  }
  const bool full_screen = frame->IsFullscreen();
  if (reported_full_screen_ != full_screen) {
    const bool announce = reported_full_screen_.has_value() || full_screen;
    reported_full_screen_ = full_screen;
    if (announce && !is_utility()) {
      WindowRegistry::Get().BroadcastWindowEvent(
          base::DictValue()
              .Set("type", "fullScreen")
              .Set("id", config_.window_id)
              .Set("on", full_screen));
    }
  }
  const bool maximized = frame->IsMaximized();
  if (reported_maximized_ == maximized) {
    return;
  }
  reported_maximized_ = maximized;
  Emit("ArdiaShell", ardia::desktop_window_state::kWindowStateEvent,
       base::Value(WindowState()));
}

void ShellHostView::RememberPlacement() {
  if (!browser_ || private_window() || is_utility()) {
    return;
  }
  ui::BaseWindow* window = browser_->GetWindow();
  const gfx::Rect restored = window->GetRestoredBounds();
  if (restored.IsEmpty()) {
    return;
  }
  WindowRegistry::Get().RememberPlacement(
      {{restored.x(), restored.y(), restored.width(), restored.height()},
       window->IsMaximized()});
}

void ShellHostView::RequestClose() {
  if (!browser_ || closing_ || close_confirming_) {
    return;
  }
  RememberPlacement();
  ResetUnloadConfirmations();
  if (!CompanionsHoldTabs() || browser_shutdown::IsTryingToQuit()) {
    browser_->GetWindow()->Close();
    return;
  }
  close_confirming_ = true;
  ConfirmWindowUnload(base::BindOnce(
      [](base::WeakPtr<ShellHostView> host, bool proceed) {
        if (!host) {
          return;
        }
        host->close_confirming_ = false;
        if (!proceed || !host->browser_ || host->closing_) {
          host->Note("closing window " + host->config_.window_id +
                     " was cancelled by one of its pages");
          return;
        }
        host->browser_->GetWindow()->Close();
      },
      GetWeakPtr()));
}

bool ShellHostView::InterceptSystemClose() {
  if (!browser_ || closing_ || browser_shutdown::IsTryingToQuit() ||
      !CompanionsHoldTabs()) {
    return false;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&ShellHostView::RequestClose, GetWeakPtr()));
  return true;
}

bool ShellHostView::CompanionsHoldTabs() const {
  return std::ranges::any_of(companions_, [](const auto& companion) {
    return companion && companion->GetTabStripModel()->count() > 0;
  });
}

void ShellHostView::ConfirmWindowUnload(
    base::OnceCallback<void(bool)> done) {
  std::vector<base::WeakPtr<BrowserWindowInterface>> waiting;
  for (const auto& companion : companions_) {
    if (companion && companion->GetTabStripModel()->count() > 0) {
      waiting.push_back(companion);
    }
  }
  confirmation_steps_.clear();
  if (waiting.empty() || browser_shutdown::IsTryingToQuit()) {
    return std::move(done).Run(true);
  }
  auto confirmation = std::make_shared<CompanionConfirmation>();
  confirmation->browsers = std::move(waiting);
  confirmation->done = std::move(done);
  auto step = std::make_shared<base::RepeatingClosure>();
  *step = base::BindRepeating(
      &ShellHostView::ConfirmNextCompanion, confirmation,
      std::weak_ptr<base::RepeatingClosure>(step));
  confirmation_steps_.push_back(step);
  step->Run();
}

void ShellHostView::ConfirmNextCompanion(
    std::shared_ptr<CompanionConfirmation> confirmation,
    std::weak_ptr<base::RepeatingClosure> self) {
  while (confirmation->done &&
         confirmation->next < confirmation->browsers.size()) {
    const base::WeakPtr<BrowserWindowInterface> browser =
        confirmation->browsers[confirmation->next++];
    if (!browser) {
      continue;
    }
    const bool waits =
        UnloadController::From(browser.get())
            ->RunBeforeUnloadForShutdown(
                false,
                base::BindRepeating(
                    [](std::shared_ptr<CompanionConfirmation> confirmation,
                       std::weak_ptr<base::RepeatingClosure> self,
                       bool proceed) {
                      if (!confirmation->done) {
                        return;
                      }
                      if (!proceed) {
                        return FinishCompanionConfirmation(confirmation, false);
                      }
                      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
                          FROM_HERE,
                          base::BindOnce(
                              [](std::weak_ptr<base::RepeatingClosure> self) {
                                if (auto step = self.lock()) {
                                  step->Run();
                                }
                              },
                              self));
                    },
                    confirmation, self));
    if (waits) {
      return;
    }
  }
  if (confirmation->done) {
    FinishCompanionConfirmation(confirmation, true);
  }
}

void ShellHostView::ResetUnloadConfirmations() {
  for (const auto& companion : companions_) {
    if (!companion) {
      continue;
    }
    UnloadController* unload = UnloadController::From(companion.get());
    if (unload && unload->is_attempting_to_close_browser()) {
      unload->ResetBeforeUnloadForShutdown();
    }
  }
}

void ShellHostView::FinishCompanionConfirmation(
    std::shared_ptr<CompanionConfirmation> confirmation,
    bool proceed) {
  base::OnceCallback<void(bool)> done = std::move(confirmation->done);
  if (!done) {
    return;
  }
  if (!proceed) {
    for (const auto& browser : confirmation->browsers) {
      if (browser) {
        UnloadController::From(browser.get())->ResetBeforeUnloadForShutdown();
      }
    }
  }
  std::move(done).Run(proceed);
}

void ShellHostView::OnWidgetBoundsChanged(views::Widget* changed,
                                          const gfx::Rect& bounds) {
  ReportWindowState();
}

void ShellHostView::OnWidgetShowStateChanged(views::Widget* changed) {
  ReportWindowState();
}

void ShellHostView::OnWidgetActivationChanged(views::Widget* changed,
                                              bool active) {
  if (!active) {
    caption_->Reset();
    return;
  }
  if (!private_window() && !is_utility()) {
    RememberPlacement();
  }
}

void ShellHostView::OnWidgetThemeChanged(views::Widget* changed) {
  Decorate();
}

void ShellHostView::OnWidgetClosing(views::Widget* changed) {
  closing_ = true;
  RememberPlacement();
}

void ShellHostView::OnWidgetDestroying(views::Widget* changed) {
  RememberPlacement();
  caption_->Detach();
  widget_observation_.Reset();
}

void ShellHostView::WatchSystemState() {
  if (system_state_subscription_) {
    return;
  }
  system_state_subscription_ = ardia::desktop::Platform().WatchPower(
      base::BindRepeating(
          [](base::WeakPtr<ShellHostView> host, const base::DictValue& state) {
            if (host) {
              host->Emit("ArdiaEngine", "engine",
                         base::Value(base::DictValue()
                                         .Set("name", "engine.systemState")
                                         .Set("data", state.Clone())));
            }
          },
          GetWeakPtr()));
}

bool ShellHostView::PreTranslate(const MSG& msg) {
  return caption_ && caption_->PreTranslate(msg);
}

bool ShellHostView::HandleKeyboardEvent(
    content::WebContents* source,
    const input::NativeWebKeyboardEvent& event) {
  if (!focus_manager_) {
    return false;
  }
  return unhandled_keys_.HandleKeyboardEvent(event, focus_manager_);
}

content::WebContents* ShellHostView::OpenURLFromTab(
    content::WebContents* source,
    const content::OpenURLParams& params,
    base::OnceCallback<void(content::NavigationHandle&)>
        navigation_handle_callback) {
  return nullptr;
}

bool ShellHostView::CommandFocusesShell(const std::string& command) {
  return command == "focusCommandBar" || command == "newTab" ||
         command == "newTabInGroup" || command == "findInPage" ||
         command == "findAndReplace" || command == "searchTabs" ||
         command == "tabSwitcher" || command == "openProfileMenu" ||
         command == "closeTab";
}

bool ShellHostView::AcceleratorPressed(const ui::Accelerator& accelerator) {
  auto found = shortcuts_.find(accelerator);
  if (found == shortcuts_.end()) {
    return false;
  }
  const std::string command = Text(found->second, "command");
  if (CommandFocusesShell(command)) {
    FocusShell();
  }
  base::DictValue payload;
  payload.Set("command", command);
  if (const base::Value* arg = found->second.Find("arg")) {
    payload.Set("arg", arg->Clone());
  } else {
    payload.Set("arg", base::Value());
  }
  payload.Set("windowId", config_.window_id);
  payload.Set("shortcutModifiers", accelerator.modifiers());
  Emit("ArdiaShell", "onCommand", base::Value(std::move(payload)));
  return true;
}

bool ShellHostView::CanHandleAccelerators() const {
  return browser_ && handler_;
}

std::string ShellHostView::BootstrapJson() const {
  base::DictValue info;
  info.Set("appName", "Ardia");
  info.Set("appVersion", std::string(version_info::GetVersionNumber()));
  info.Set("appBuild", "windows-webui");
  info.Set("bundleId", "dev.ardia.windows.webui");
  info.Set("configuration", "Release");
  info.Set("osVersion", base::SysInfo::OperatingSystemVersion());
  info.Set("osBuild", "Windows");
  info.Set("arch", base::SysInfo::OperatingSystemArchitecture());
  info.Set("model", "Windows");
  info.Set("memoryGB", base::SysInfo::AmountOfTotalPhysicalMemory().InBytes() /
                           (1024.0 * 1024 * 1024));
  info.Set("locale", "en-US");
  info.Set("updates", false);
  info.Set("isolatedInstance", true);
  base::ListValue capabilities;
  for (std::string_view capability : HostCapabilities(is_utility())) {
    capabilities.Append(capability);
  }
  for (const auto& calls :
       {std::span<const std::string_view>(kDefaultBrowserCalls),
        std::span<const std::string_view>(kLoginItemCalls),
        std::span<const std::string_view>(kOpenExternalCalls),
        std::span<const std::string_view>(kUpdateCapabilities)}) {
    for (std::string_view call : calls) {
      capabilities.Append(call);
    }
  }
  for (const auto& route : ardia::desktop_routes::kRoutes) {
    capabilities.Append(route.name);
  }
  base::DictValue bootstrap;
  bootstrap.Set("windowId", config_.window_id);
  bootstrap.Set("startup", config_.startup);
  bootstrap.Set("profileId", kAppProfileName);
  bootstrap.Set("nativeModules",
                base::DictValue().Set(
                    "ArdiaApp", base::DictValue().Set("systemInfo", std::move(info))));
  bootstrap.Set("capabilities", std::move(capabilities));
  bootstrap.Set("glassPanels", false);
  bootstrap.Set("pageProfile", config_.page_profile);
  bootstrap.Set("windowKind", webui_window::WindowKindName(config_.kind));
  bootstrap.Set("shellZoom", 1.0);
  bootstrap.Set("documents", base::DictValue());
  if (is_utility()) {
    bootstrap.Set("utility", config_.utility.Clone());
  }
  if (!config_.private_window.empty()) {
    bootstrap.Set("privateWindow", config_.private_window.Clone());
  }
  if (config_.kind == webui_window::WindowKind::kSmall &&
      !config_.small_window.empty()) {
    bootstrap.Set("smallWindow", config_.small_window.Clone());
  }
  if (config_.chrome_made) {
    bootstrap.Set("chromeMade", true);
  }
  return base::WriteJson(bootstrap).value_or("{}");
}

void ShellHostView::OnTabStripModelChanged(
    TabStripModel* tab_strip_model,
    const TabStripModelChange& change,
    const TabStripSelectionChange& selection) {
  if (change.type() == TabStripModelChange::kInserted && !creating_tab_) {
    for (const auto& inserted : change.GetInsert()->contents) {
      NoteUnclaimedTab(inserted.contents,
                       inserted.contents == tab_strip_model->GetActiveWebContents());
    }
  }
  if (change.type() == TabStripModelChange::kReplaced) {
    const TabStripModelChange::Replace* replace = change.GetReplace();
    ReplaceTabContents(replace->old_contents, replace->new_contents);
  }
  ReattachViewports();
}

void ShellHostView::NavigateUtility(base::DictValue utility) {
  config_.utility = std::move(utility);
  if (utility_ready_) {
    Emit("ArdiaShell", "onUtilityNavigation",
         base::Value(config_.utility.Clone()));
  }
}

bool ShellHostView::OpenPrivateLink(content::WebContents* contents,
                                     const GURL& url) {
  PageBinding* binding = BindingForContents(contents);
  if (!binding) {
    return false;
  }
  return binding->ReportOpenPrivateWindow(url, binding->profile().empty()
                                                   ? config_.page_profile
                                                   : binding->profile());
}

bool ShellHostView::RequestPrivateWindow(const GURL& url) {
  if (!browser_ || is_utility() || closing_ || !handler_) {
    return false;
  }
  PageBinding* chosen = nullptr;
  for (const auto& [id, binding] : bindings_) {
    if (!binding->contents() || binding->claim.empty()) {
      continue;
    }
    if (binding->presented) {
      chosen = binding.get();
      break;
    }
    if (!chosen) {
      chosen = binding.get();
    }
  }
  const std::string& profile =
      chosen && !chosen->profile().empty() ? chosen->profile()
                                           : config_.page_profile;
  return chosen && chosen->ReportOpenPrivateWindow(
                       url, std::string(webui_window::OriginalProfileOf(profile)));
}

void ShellHostView::ReplaceTabContents(content::WebContents* old_contents,
                                       content::WebContents* contents) {
  PageBinding* binding = BindingForContents(old_contents);
  const int id = TabId(contents);
  if (!binding || !contents || id <= 0) {
    return;
  }
  const int old_id = binding->id();
  if (id != old_id && bindings_.contains(id)) {
    return;
  }
  binding->Rebind(contents);
  if (id != old_id) {
    std::unique_ptr<PageBinding> owned = std::move(bindings_[old_id]);
    bindings_.erase(old_id);
    bindings_[id] = std::move(owned);
  }
  const std::optional<uint64_t> next =
      webui_window::NextBindingGeneration(binding->binding_generation);
  if (!next) {
    binding->ReportClosed();
    binding->claim.clear();
    return;
  }
  if (!binding->claim.empty()) {
    base::DictValue delivery = binding->Envelope("pageLifecycle");
    binding->binding_generation = *next;
    base::DictValue creation =
        base::DictValue()
            .Set("browserId", id)
            .Set("chromeTabId", id)
            .Set("lease", binding->Envelope("pageLease"));
    creation.Set("snapshot",
                 base::DictValue()
                     .Set("watermark", static_cast<double>(binding->sequence))
                     .Set("events",
                          base::ListValue().Append(binding->NavigationEvent())));
    delivery.Set("action", "rebind");
    delivery.Set("creation", std::move(creation));
    Emit("ArdiaWebView", base::NumberToString(old_id),
         base::Value(std::move(delivery)));
  } else {
    binding->binding_generation = *next;
  }
  Note("tab " + base::NumberToString(old_id) + " now shows tab " +
       base::NumberToString(id) + " after Chromium replaced its page");
}

BEGIN_METADATA(ShellHostView)
END_METADATA

}
