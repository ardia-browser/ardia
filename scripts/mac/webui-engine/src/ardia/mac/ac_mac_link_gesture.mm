#include "ardia/mac/ac_mac_link_gesture.h"

#import <AppKit/AppKit.h>

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/mac/ac_mac_link_policy.h"
#include "ardia/mac/ac_mac_shell_host.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "components/zoom/page_zoom.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/page.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/page_zoom.h"
#include "net/base/registry_controlled_domains/registry_controlled_domain.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "ui/base/page_transition_types.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/native_ui_types.h"
#include "url/origin.h"

extern void (*g_ardia_mac_add_navigation_throttles)(content::NavigationThrottleRegistry& registry);

namespace content {
void SetArdiaMacDownloadUrlHook(bool (*hook)(RenderFrameHost*, const GURL&, bool, bool, bool));
void SetArdiaMacNewWindowInPlaceHook(bool (*hook)(WebContents*, const GURL&, WindowOpenDisposition, bool, bool));
}

namespace ardia_mac {

namespace {

namespace lp = link_policy;

struct LinkState {
  lp::PageOptions options;
  lp::GestureGate gate;
  lp::TabKeys site_tabs;
  bool new_tab_links_in_place = false;
  bool popups_as_tabs = false;
  bool command_scroll_zoom = true;
  lp::ScrollZoom scroll_zoom;
};

LinkState& State() {
  static base::NoDestructor<LinkState> state;
  return *state;
}

double Now() {
  return (base::TimeTicks::Now() - base::TimeTicks()).InSecondsF();
}

std::int64_t Micros(base::TimeTicks ticks) {
  return ticks.is_null() ? 0 : (ticks - base::TimeTicks()).InMicroseconds();
}

int LinkFlags(int modifiers) {
  int flags = 0;
  if (modifiers & blink::WebInputEvent::kAltKey) flags |= lp::kAlt;
  if (modifiers & blink::WebInputEvent::kShiftKey) flags |= lp::kShift;
  if (modifiers & blink::WebInputEvent::kControlKey) flags |= lp::kControl;
  if (modifiers & blink::WebInputEvent::kMetaKey) flags |= lp::kMeta;
  return flags;
}

std::uintptr_t SurfaceOf(const content::WebContents* contents) {
  return reinterpret_cast<std::uintptr_t>(contents);
}

PageBinding* BindingFor(const content::WebContents* contents) {
  if (!contents) return nullptr;
  for (ShellHostView* host : Hosts()) {
    if (PageBinding* binding = host->BindingForContents(contents)) return binding;
  }
  return nullptr;
}

bool Shown(const PageBinding* binding) {
  return binding && binding->visible && binding->host() && !binding->claim.empty();
}

bool SmallWindow(const PageBinding* binding) {
  return binding && binding->host() && binding->host()->is_small();
}

lp::Opening OpeningFor(WindowOpenDisposition disposition) {
  switch (disposition) {
    case WindowOpenDisposition::kNewForegroundTab: return lp::Opening::kForeground;
    case WindowOpenDisposition::kNewBackgroundTab: return lp::Opening::kBackground;
    case WindowOpenDisposition::kNewWindow: return lp::Opening::kWindow;
    case WindowOpenDisposition::kNewPopup: return lp::Opening::kPopup;
    case WindowOpenDisposition::kNewSplitView: return lp::Opening::kSplit;
    case WindowOpenDisposition::kSaveToDisk: return lp::Opening::kDownload;
    default: return lp::Opening::kOther;
  }
}

bool Http(const GURL& url) {
  return url.is_valid() && url.SchemeIsHTTPOrHTTPS() && url.spec().size() <= lp::kUrlMax;
}

bool SameOrigin(content::WebContents* contents, const GURL& url) {
  content::RenderFrameHost* main = contents ? contents->GetPrimaryMainFrame() : nullptr;
  return main && url::Origin::Create(url).IsSameOriginWith(main->GetLastCommittedOrigin());
}

base::DictValue OpenEvent(const GURL& url, std::string_view disposition) {
  return base::DictValue().Set("url", url.spec()).Set("disposition", disposition).Set("userGesture", true);
}

bool Emit(PageBinding* binding, base::DictValue open) {
  if (!binding || binding->claim.empty()) return false;
  binding->Report("openWindow", base::Value(std::move(open)));
  return true;
}

lp::Decision Decide(PageBinding* binding, std::string key, const GURL& url) {
  lp::Request request;
  request.surface = binding ? SurfaceOf(binding->contents()) : 0;
  request.key = std::move(key);
  request.http = Http(url);
  request.visible = Shown(binding);
  request.same_origin = binding && SameOrigin(binding->contents(), url);
  request.main = true;
  request.other_sites = request.key == lp::kOtherSiteKey && binding &&
                        State().site_tabs.contains(binding->key());
  request.now = Now();
  return State().gate.Decide(request, State().options);
}

bool EmitDecision(PageBinding* binding, const GURL& url, const lp::Decision& decision) {
  const char* disposition = lp::DispositionName(decision.outcome);
  if (!disposition) return false;
  base::DictValue open = OpenEvent(url, disposition);
  if (decision.point && binding && binding->host()) {
    if (std::optional<gfx::PointF> point =
            binding->host()->ShellPointFor(binding, gfx::PointF(decision.point->x, decision.point->y))) {
      open.Set("point", base::DictValue().Set("x", point->x()).Set("y", point->y()));
    }
  }
  if (decision.site) open.Set("site", true);
  return Emit(binding, std::move(open));
}

std::optional<base::DictValue> ParsedInput(const base::Value* args) {
  std::optional<base::Value> parsed =
      args && args->is_string() ? base::JSONReader::Read(args->GetString(), base::JSON_PARSE_RFC, 4)
                                : std::nullopt;
  if (!parsed || !parsed->is_dict()) return std::nullopt;
  return std::move(parsed->GetDict());
}

base::Value RouteError(std::string_view message) {
  return base::Value(base::DictValue().Set("code", "ERR_ENGINE").Set("message", message));
}

class SitePeekThrottle : public content::NavigationThrottle {
 public:
  explicit SitePeekThrottle(content::NavigationThrottleRegistry& registry)
      : content::NavigationThrottle(registry) {}

  ThrottleCheckResult WillStartRequest() override {
    content::NavigationHandle* handle = navigation_handle();
    PageBinding* binding = handle ? BindingFor(handle->GetWebContents()) : nullptr;
    PageLinks* links = binding ? binding->links() : nullptr;
    return links && links->PeeksInsteadOf(*handle) ? CANCEL_AND_IGNORE : PROCEED;
  }

  const char* GetNameForLogging() override { return "ArdiaMacSitePeekThrottle"; }
};

void AddLinkNavigationThrottles(content::NavigationThrottleRegistry& registry) {
  content::NavigationHandle& handle = registry.GetNavigationHandle();
  if (!handle.IsInPrimaryMainFrame() || State().site_tabs.empty() || !BindingFor(handle.GetWebContents())) {
    return;
  }
  registry.AddThrottle(std::make_unique<SitePeekThrottle>(registry));
}

bool OptionClickDownloadIntercepted(content::RenderFrameHost* frame,
                                    const GURL& url,
                                    bool follows_redirects,
                                    bool names_file,
                                    bool user_gesture) {
  content::WebContents* source = frame ? content::WebContents::FromRenderFrameHost(frame) : nullptr;
  PageBinding* binding = BindingFor(source);
  if (!binding || !Http(url)) return false;
  const lp::GestureGate::Release release = State().gate.FreshRelease(SurfaceOf(source), Now());
  lp::DownloadClick click;
  click.follows_redirects = follows_redirects;
  click.names_file = names_file;
  click.user_gesture = user_gesture;
  click.target_matches = lp::TargetMatches(release.target, url.spec());
  click.up_flags = release.flags;
  click.since = release.since;
  if (!lp::OptionClickDownload(click)) return false;
  return EmitDecision(binding, url, Decide(binding, "alt", url));
}

bool NoOpenerWindowOpensInPlace(content::WebContents* source,
                                const GURL& url,
                                WindowOpenDisposition disposition,
                                bool form_submission,
                                bool user_gesture) {
  PageBinding* binding = BindingFor(source);
  PageLinks* links = binding ? binding->links() : nullptr;
  return links && links->OpensInPlace(url, disposition, form_submission, user_gesture);
}

PageBinding* BindingUnder(NSEvent* event) {
  NSWindow* window = event.window;
  NSView* content = window.contentView;
  if (!content) return nullptr;
  NSView* root = content.superview ?: content;
  NSView* hit = [root hitTest:[root.superview ?: root convertPoint:event.locationInWindow fromView:nil]];
  if (!hit) return nullptr;
  for (ShellHostView* host : Hosts()) {
    if (PageBinding* binding = host->BindingHit(gfx::NativeView(hit))) return binding;
  }
  return nullptr;
}

void InstallCommandScrollZoom() {
  static id monitor;
  if (monitor) return;
  monitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                   handler:^NSEvent*(NSEvent* event) {
                                     LinkState& state = State();
                                     const bool command = event.modifierFlags & NSEventModifierFlagCommand;
                                     if (!lp::CommandScrollZooms(state.command_scroll_zoom, command,
                                                                 event.hasPreciseScrollingDeltas,
                                                                 event.phase != NSEventPhaseNone,
                                                                 event.momentumPhase != NSEventPhaseNone)) {
                                       state.scroll_zoom.Reset();
                                       return event;
                                     }
                                     PageBinding* binding = BindingUnder(event);
                                     content::WebContents* contents = binding ? binding->contents() : nullptr;
                                     if (!contents || !binding->visible) {
                                       state.scroll_zoom.Reset();
                                       return event;
                                     }
                                     const int step = state.scroll_zoom.Add(event.scrollingDeltaY * lp::kWheelLineDelta,
                                                                            SurfaceOf(contents));
                                     if (step) {
                                       zoom::PageZoom::Zoom(contents, step > 0 ? content::PAGE_ZOOM_IN
                                                                               : content::PAGE_ZOOM_OUT);
                                     }
                                     return nil;
                                   }];
}

}

PageLinks::PageLinks(PageBinding* binding, content::WebContents* contents)
    : content::WebContentsObserver(contents), binding_(binding), surface_(SurfaceOf(contents)) {
  if (contents) {
    contents->ForEachRenderFrameHost(
        [this](content::RenderFrameHost* frame) { Watch(frame->GetRenderWidgetHost()); });
  }
}

PageLinks::~PageLinks() {
  Unwatch();
  State().gate.Forget(surface_);
}

std::uintptr_t PageLinks::surface() const {
  return surface_;
}

void PageLinks::NoteTarget(const GURL& url) {
  target_ = url.is_valid() && url.spec().size() <= lp::kUrlMax ? url.spec() : std::string();
}

void PageLinks::Watch(content::RenderWidgetHost* widget) {
  if (!widget || !widgets_.insert(widget).second) return;
  widget->AddInputEventObserver(this);
  widget->AddObserver(this);
}

void PageLinks::Unwatch() {
  for (content::RenderWidgetHost* widget : widgets_) {
    widget->RemoveInputEventObserver(this);
    widget->RemoveObserver(this);
  }
  widgets_.clear();
}

void PageLinks::RenderFrameCreated(content::RenderFrameHost* frame) {
  Watch(frame->GetRenderWidgetHost());
}

void PageLinks::RenderFrameHostChanged(content::RenderFrameHost* old_host,
                                       content::RenderFrameHost* new_host) {
  if (new_host) Watch(new_host->GetRenderWidgetHost());
}

void PageLinks::PrimaryPageChanged(content::Page& page) {
  target_.clear();
}

void PageLinks::RenderWidgetHostDestroyed(content::RenderWidgetHost* widget) {
  widget->RemoveInputEventObserver(this);
  widget->RemoveObserver(this);
  widgets_.erase(widget);
}

void PageLinks::WebContentsDestroyed() {
  Unwatch();
  State().gate.Forget(surface_);
  surface_ = 0;
}

void PageLinks::OnInputEvent(const content::RenderWidgetHost& widget,
                             const blink::WebInputEvent& event,
                             input::InputEventSource source) {
  const auto type = event.GetType();
  if (type != blink::WebInputEvent::Type::kMouseDown && type != blink::WebInputEvent::Type::kMouseUp) return;
  const auto& mouse = static_cast<const blink::WebMouseEvent&>(event);
  if (mouse.button != blink::WebPointerProperties::Button::kLeft) return;
  if (type == blink::WebInputEvent::Type::kMouseDown) return State().gate.NotePress(surface_);
  std::optional<lp::Point> point;
  content::RenderFrameHost* main = web_contents() ? web_contents()->GetPrimaryMainFrame() : nullptr;
  if (main && main->GetRenderWidgetHost() == &widget) {
    point = lp::Point{mouse.PositionInWidget().x(), mouse.PositionInWidget().y()};
  }
  State().gate.NoteRelease(surface_, LinkFlags(mouse.GetModifiers()), Now(), point, target_,
                           Micros(mouse.TimeStamp()));
}

bool PageLinks::PeeksInsteadOf(content::NavigationHandle& handle) {
  content::WebContents* contents = web_contents();
  if (!contents || !binding_ || handle.GetWebContents() != contents) return false;
  const GURL& url = handle.GetURL();
  const GURL& current = contents->GetLastCommittedURL();
  const lp::GestureGate::Release release = State().gate.FreshRelease(surface_, Now());
  lp::SitePeekNavigation navigation;
  navigation.primary_main_frame = handle.IsInPrimaryMainFrame();
  navigation.renderer_initiated = handle.IsRendererInitiated();
  navigation.user_gesture = handle.HasUserGesture();
  navigation.link = ui::PageTransitionCoreTypeIs(handle.GetPageTransition(), ui::PAGE_TRANSITION_LINK);
  navigation.link_click = handle.WasInitiatedByLinkClick();
  content::RenderFrameHost* main = contents->GetPrimaryMainFrame();
  const std::optional<blink::LocalFrameToken>& initiator = handle.GetInitiatorFrameToken();
  navigation.main_frame_initiated =
      main && initiator &&
      main->GetGlobalFrameToken() == content::GlobalRenderFrameHostToken(handle.GetInitiatorProcessId(), *initiator);
  navigation.input_matches = lp::SameInput(Micros(handle.NavigationInputStart()), release.input_us) &&
                             lp::TargetMatches(release.target, url.spec());
  navigation.post = handle.IsPost();
  navigation.same_document = handle.IsSameDocument();
  navigation.history = handle.IsHistory() || handle.IsPrerenderedPageActivation();
  navigation.http = Http(url) && current.SchemeIsHTTPOrHTTPS();
  navigation.cross_site = !net::registry_controlled_domains::SameDomainOrHost(
      url, current, net::registry_controlled_domains::INCLUDE_PRIVATE_REGISTRIES);
  navigation.tab_listed = State().site_tabs.contains(binding_->key());
  navigation.up_flags = release.flags;
  if (!lp::SitePeekCandidate(navigation)) return false;
  const lp::Decision decision = Decide(binding_, std::string(lp::kOtherSiteKey), url);
  if (decision.outcome != lp::Outcome::kPeek) return false;
  peek_navigation_ = handle.GetNavigationId();
  peek_url_ = url;
  peek_point_ = decision.point;
  return true;
}

void PageLinks::DidFinishNavigation(content::NavigationHandle* handle) {
  if (!peek_navigation_ || handle->GetNavigationId() != peek_navigation_) return;
  const GURL url = peek_url_;
  lp::Decision decision;
  decision.outcome = lp::Outcome::kPeek;
  decision.site = true;
  decision.point = peek_point_;
  peek_navigation_ = 0;
  peek_url_ = GURL();
  peek_point_.reset();
  content::WebContents* contents = web_contents();
  if (!lp::AnnouncesSitePeek(true, handle->HasCommitted(), !contents || contents->IsBeingDestroyed())) return;
  EmitDecision(binding_, url, decision);
}

bool PageLinks::OpensInPlace(const GURL& url, WindowOpenDisposition disposition, bool form_submission,
                             bool user_gesture) {
  content::WebContents* contents = web_contents();
  if (!contents || !binding_ || contents->IsBeingDestroyed()) return false;
  const lp::GestureGate::Release release = State().gate.FreshRelease(surface_, Now());
  lp::InPlaceLink link;
  link.enabled = State().new_tab_links_in_place;
  link.small_window = SmallWindow(binding_);
  link.opening = OpeningFor(disposition);
  link.renderer_initiated = true;
  link.user_gesture = user_gesture;
  link.http = Http(url);
  link.post = form_submission;
  link.opener = false;
  link.target_matches = lp::TargetMatches(release.target, url.spec());
  link.up_flags = release.flags;
  if (!lp::OpensInPlace(link)) return false;
  return Emit(binding_, OpenEvent(url, "current"));
}

bool HandlesLinkRoute(std::string_view name) {
  return lp::IsRoute(name);
}

void AppendLinkCapabilities(base::ListValue& capabilities) {
  for (std::string_view route : lp::kRoutes) capabilities.Append(route);
}

void LinkRouteCall(std::string_view name,
                   const base::Value* args,
                   base::OnceCallback<void(bool, base::Value)> done) {
  std::optional<base::DictValue> input = ParsedInput(args);
  if (!input) return std::move(done).Run(false, RouteError("Invalid page option request"));
  LinkState& state = State();
  if (name == lp::kPeekModifierRoute || name == lp::kSplitModifierRoute) {
    const std::string* modifier = input->FindString("modifier");
    if (!modifier || modifier->size() > lp::kModifierMax) {
      return std::move(done).Run(false, RouteError("A link modifier is required"));
    }
    if (name == lp::kPeekModifierRoute) state.options.SetPeek(*modifier);
    else state.options.SetSplit(*modifier);
    return std::move(done).Run(true, base::Value("null"));
  }
  if (name == lp::kPeekSiteTabsRoute) {
    const base::ListValue* ids = input->FindList("tabIds");
    std::vector<std::optional<std::string>> keys;
    if (ids && ids->size() <= lp::kSiteTabsMax) {
      for (const base::Value& id : *ids) {
        keys.push_back(id.is_string() ? std::optional<std::string>(id.GetString()) : std::nullopt);
      }
    }
    std::optional<lp::TabKeys> parsed =
        ids && ids->size() <= lp::kSiteTabsMax ? lp::SiteTabKeys(keys) : std::nullopt;
    if (!parsed) {
      return std::move(done).Run(
          false, RouteError("webView.setPeekOtherSiteTabs requires {tabIds} as a list of tab ids"));
    }
    state.site_tabs = std::move(*parsed);
    return std::move(done).Run(true, base::Value("null"));
  }
  const std::optional<bool> enabled = input->FindBool("enabled");
  if (!enabled) return std::move(done).Run(false, RouteError("A boolean enabled is required"));
  if (name == lp::kNewTabLinksRoute) {
    state.new_tab_links_in_place = *enabled;
  } else if (name == lp::kPopupsAsTabsRoute) {
    state.popups_as_tabs = *enabled;
  } else if (name == lp::kCommandScrollZoomRoute) {
    state.command_scroll_zoom = *enabled;
    state.scroll_zoom.Reset();
  } else {
    return std::move(done).Run(false, RouteError("Unknown page option"));
  }
  std::move(done).Run(true, base::Value("null"));
}

void NoteLinkTarget(content::WebContents* source, const GURL& url) {
  PageBinding* binding = BindingFor(source);
  if (PageLinks* links = binding ? binding->links() : nullptr) links->NoteTarget(url);
}

bool InterceptLinkOpen(content::WebContents* source, const content::OpenURLParams& params) {
  PageBinding* binding = BindingFor(source);
  if (!binding) return false;
  const lp::GestureGate::Release release = State().gate.FreshRelease(SurfaceOf(source), Now());
  const bool target_matches = lp::TargetMatches(release.target, params.url.spec());
  const lp::Opening opening = OpeningFor(params.disposition);
  lp::InPlaceLink in_place;
  in_place.enabled = State().new_tab_links_in_place;
  in_place.small_window = SmallWindow(binding);
  in_place.opening = opening;
  in_place.renderer_initiated = params.is_renderer_initiated;
  in_place.user_gesture = params.user_gesture;
  in_place.http = Http(params.url);
  in_place.post = params.post_data != nullptr;
  in_place.target_matches = target_matches;
  in_place.up_flags = release.flags;
  if (lp::OpensInPlace(in_place)) return Emit(binding, OpenEvent(params.url, "current"));
  const lp::OpenRoute route =
      lp::RouteForOpening(opening, release.flags, params.is_renderer_initiated, params.user_gesture, target_matches);
  if (!route.ours) return false;
  return EmitDecision(binding, params.url, Decide(binding, route.key, params.url));
}

WindowOpenDisposition OpeningDisposition(content::WebContents* source, const content::OpenURLParams& params) {
  return BindingFor(source) && lp::WindowOpensAsTab(OpeningFor(params.disposition), params.is_renderer_initiated)
             ? WindowOpenDisposition::kNewForegroundTab
             : params.disposition;
}

WindowOpenDisposition PopupDisposition(content::WebContents* source,
                                       WindowOpenDisposition disposition) {
  PageBinding* binding = BindingFor(source);
  if (!binding) return disposition;
  return lp::PopupOpensAsTab(State().popups_as_tabs, SmallWindow(binding), OpeningFor(disposition))
             ? WindowOpenDisposition::kNewForegroundTab
             : disposition;
}

void InstallLinkHooks() {
  if (g_ardia_mac_add_navigation_throttles != &AddLinkNavigationThrottles) {
    g_ardia_mac_add_navigation_throttles = &AddLinkNavigationThrottles;
  }
  content::SetArdiaMacDownloadUrlHook(&OptionClickDownloadIntercepted);
  content::SetArdiaMacNewWindowInPlaceHook(&NoOpenerWindowOpensInPlace);
  InstallCommandScrollZoom();
}

}
