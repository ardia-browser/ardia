#include "ardia/mac/ac_mac_swipe.h"

#import <AppKit/AppKit.h>

#include <cmath>
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/mac/ac_mac_shell_host.h"
#include "ardia/mac/ac_mac_swipe_policy.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "chrome/browser/renderer_host/chrome_render_widget_host_view_mac_history_swiping_control.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_observer.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "third_party/blink/public/common/input/web_gesture_event.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/input/web_mouse_wheel_event.h"
#include "third_party/blink/public/mojom/input/input_event_result.mojom-shared.h"
#include "ui/events/base_event_utils.h"
#include "ui/views/widget/widget.h"

namespace ardia_mac {

namespace sp = swipe_policy;

namespace {

NSView* ViewOf(content::WebContents* contents) {
  return contents ? contents->GetNativeView().GetNativeNSView() : nil;
}

void KeepChromeHistorySwiperOff(content::WebContents* contents) {
  if (contents) {
    history_swiper::HistorySwipingControl::CreateForWebContents(contents,
                                                               base::BindRepeating([] { return false; }));
  }
}

bool WheelBegins(const blink::WebInputEvent& event) {
  return event.GetType() == blink::WebInputEvent::Type::kMouseWheel &&
         static_cast<const blink::WebMouseWheelEvent&>(event).phase == blink::WebMouseWheelEvent::kPhaseBegan;
}

std::vector<sp::Ack> AcksFor(blink::mojom::InputEventResultState state, const blink::WebInputEvent& event) {
  using Result = blink::mojom::InputEventResultState;
  using Type = blink::WebInputEvent::Type;
  const bool consumed = state == Result::kConsumed;
  const bool unconsumed = state == Result::kNotConsumed || state == Result::kNoConsumerExists;
  if (event.GetType() == Type::kMouseWheel) {
    const auto& wheel = static_cast<const blink::WebMouseWheelEvent&>(event);
    std::vector<sp::Ack> acks;
    if (WheelBegins(event)) {
      acks.push_back(sp::Ack::kWheelBegan);
    }
    if (consumed && wheel.momentum_phase == blink::WebMouseWheelEvent::kPhaseNone) {
      acks.push_back(sp::Ack::kWheelConsumed);
    }
    return acks;
  }
  if (!blink::WebInputEvent::IsGestureEventType(event.GetType())) {
    return {};
  }
  const auto& gesture = static_cast<const blink::WebGestureEvent&>(event);
  if (gesture.SourceDevice() != blink::mojom::GestureDevice::kTouchpad) {
    return {};
  }
  constexpr auto kMomentum = blink::WebGestureEvent::InertialPhaseState::kMomentum;
  if (event.GetType() == Type::kGestureScrollBegin) {
    if (gesture.data.scroll_begin.inertial_phase == kMomentum) {
      return {};
    }
    return {sp::Ack::kScrollBegin};
  }
  if (event.GetType() != Type::kGestureScrollUpdate || gesture.data.scroll_update.inertial_phase == kMomentum) {
    return {};
  }
  if (consumed) {
    return {sp::Ack::kScrollConsumed};
  }
  if (unconsumed) {
    return {sp::Ack::kScrollUnconsumed};
  }
  return {};
}

std::int64_t EventMicros(base::TimeTicks time) {
  return (time - base::TimeTicks()).InMicroseconds();
}

class PageWatch : public content::RenderWidgetHost::InputEventObserver,
                  public content::RenderWidgetHostObserver,
                  public content::WebContentsObserver {
 public:
  using Acked = base::RepeatingCallback<void(sp::AckEvent)>;
  using Gone = base::RepeatingClosure;

  PageWatch(Acked acked, Gone gone) : acked_(std::move(acked)), gone_(std::move(gone)) {}
  PageWatch(const PageWatch&) = delete;
  PageWatch& operator=(const PageWatch&) = delete;
  ~PageWatch() override { Stop(); }

  void Watch(content::WebContents* contents, content::RenderWidgetHost* main) {
    Stop();
    if (!contents || !main) {
      return;
    }
    main_ = main;
    Observe(contents);
    Add(main);
    contents->ForEachRenderFrameHost([this](content::RenderFrameHost* frame) { Add(frame->GetRenderWidgetHost()); });
  }

  void Stop() {
    main_ = nullptr;
    Observe(nullptr);
    std::set<raw_ptr<content::RenderWidgetHost>> widgets = std::move(widgets_);
    widgets_.clear();
    for (content::RenderWidgetHost* widget : widgets) {
      widget->RemoveInputEventObserver(this);
      widget->RemoveObserver(this);
    }
  }

  content::RenderWidgetHost* host() const { return main_; }

 private:
  void Add(content::RenderWidgetHost* widget) {
    if (!main_ || !widget || widgets_.contains(widget)) {
      return;
    }
    widgets_.insert(widget);
    widget->AddInputEventObserver(this);
    widget->AddObserver(this);
  }

  bool Watches(const content::RenderWidgetHost* widget) const {
    return widgets_.contains(const_cast<content::RenderWidgetHost*>(widget));
  }

  void Lost() {
    Stop();
    gone_.Run();
  }

  void RenderFrameCreated(content::RenderFrameHost* frame) override { Add(frame->GetRenderWidgetHost()); }

  void RenderFrameHostChanged(content::RenderFrameHost* old_host, content::RenderFrameHost* new_host) override {
    if (new_host) {
      Add(new_host->GetRenderWidgetHost());
    }
  }

  void PrimaryPageChanged(content::Page& page) override { Lost(); }

  void WebContentsDestroyed() override { Lost(); }

  void OnInputEvent(const content::RenderWidgetHost& host,
                    const blink::WebInputEvent& event,
                    InputEventSource source) override {
    if (Watches(&host) && WheelBegins(event)) {
      acked_.Run(sp::AckEvent{sp::Ack::kWheelBegan, EventMicros(event.TimeStamp()), &host == main_});
    }
  }

  void OnInputEventAck(const content::RenderWidgetHost& host,
                       blink::mojom::InputEventResultSource source,
                       blink::mojom::InputEventResultState state,
                       const blink::WebInputEvent& event) override {
    if (!Watches(&host)) {
      return;
    }
    const std::int64_t time = EventMicros(event.TimeStamp());
    for (sp::Ack ack : AcksFor(state, event)) {
      if (!Watches(&host)) {
        return;
      }
      acked_.Run(sp::AckEvent{ack, time, &host == main_});
    }
  }

  void RenderWidgetHostDestroyed(content::RenderWidgetHost* host) override {
    if (host == main_) {
      Lost();
      return;
    }
    if (widgets_.erase(host)) {
      host->RemoveInputEventObserver(this);
      host->RemoveObserver(this);
    }
  }

  raw_ptr<content::RenderWidgetHost> main_ = nullptr;
  std::set<raw_ptr<content::RenderWidgetHost>> widgets_;
  Acked acked_;
  Gone gone_;
};

struct Hit {
  sp::Route route = sp::Route::kNone;
  raw_ptr<PageBinding> binding = nullptr;
};

}

struct ScrollGestures::Native {
  raw_ptr<ShellHostView> host;
  NSWindow* __weak window = nil;
  id monitor = nil;
  NSMutableArray* observers = [NSMutableArray array];
  sp::RouteLatch routes;
  sp::PageSwipe page;
  std::unique_ptr<PageWatch> watch;
  std::uint64_t next_gesture = 0;
  int page_binding = 0;
  std::uint64_t page_generation = 0;
  base::WeakPtr<content::WebContents> page_contents;
  content::WeakDocumentPtr page_document;
  std::string page_key;
  double page_x = 0;
  double page_y = 0;
  double page_time = 0;
  double shell_x = 0;
  double shell_y = 0;
  double shell_time = 0;
  base::WeakPtrFactory<Native> weak_factory{this};

  bool Handle(NSEvent* event) {
    NSWindow* own = window;
    if (!own || event.window != own || !host) {
      return false;
    }
    const sp::Phase phase = sp::PhaseOf(static_cast<std::uint64_t>(event.phase));
    const sp::Phase momentum = sp::PhaseOf(static_cast<std::uint64_t>(event.momentumPhase));
    const sp::Kind kind = sp::Classify(phase, momentum, event.hasPreciseScrollingDeltas);
    const bool starts = kind == sp::Kind::kGesture && (phase == sp::Phase::kMayBegin || phase == sp::Phase::kBegan);
    const Hit hit = kind == sp::Kind::kWheel || starts ? HitAt(event) : Hit();
    const sp::Route route = routes.Next(kind, phase, hit.route);
    const std::optional<double> zoom = Zoom();
    if (!zoom || !sp::FiniteTime(event.timestamp)) {
      return false;
    }
    Abandon(routes.TakeAbandoned(), event.timestamp);
    if (starts && route != sp::Route::kPage) {
      FinishPage(true, event.timestamp);
    }
    const std::optional<double> dx = sp::Delta(event.scrollingDeltaX / *zoom);
    const std::optional<double> dy = sp::Delta(event.scrollingDeltaY / *zoom);
    if (!dx || !dy) {
      return false;
    }
    if (route == sp::Route::kShell) {
      EmitShell(kind, phase, momentum, *dx, *dy, event);
      return false;
    }
    if (route == sp::Route::kPage && kind == sp::Kind::kGesture) {
      return PageGesture(phase, *dx, *dy, hit, event);
    }
    return false;
  }

  void Abandon(sp::Route route, double time) {
    if (route == sp::Route::kShell) {
      EmitShellCancel(time);
    } else if (route == sp::Route::kPage) {
      FinishPage(true, time);
    }
  }

  void Interrupt() {
    const double time = std::fmax(page_time, shell_time);
    Abandon(routes.Interrupt(), time);
    FinishPage(true, time);
  }

  std::optional<double> Zoom() const {
    const double zoom = host ? host->ShellZoom() : 1;
    return std::isfinite(zoom) && zoom > 0 ? std::optional<double>(zoom) : std::nullopt;
  }

  std::optional<std::pair<double, double>> ShellPoint(NSEvent* event) const {
    NSView* shell = host ? ViewOf(host->shell_contents()) : nil;
    const std::optional<double> zoom = Zoom();
    if (!shell || !zoom) {
      return std::nullopt;
    }
    const NSPoint local = [shell convertPoint:event.locationInWindow fromView:nil];
    const double x = local.x / *zoom;
    const double y = (shell.isFlipped ? local.y : NSHeight(shell.bounds) - local.y) / *zoom;
    if (!sp::FinitePoint(x, y)) {
      return std::nullopt;
    }
    return std::make_pair(x, y);
  }

  Hit HitAt(NSEvent* event) const {
    NSWindow* own = window;
    NSView* content = own.contentView;
    if (!content || !host) {
      return Hit();
    }
    const NSPoint location = event.locationInWindow;
    NSView* hit = [content hitTest:content.superview ? [content.superview convertPoint:location fromView:nil] : location];
    if (!hit) {
      return Hit();
    }
    content::WebContents* shell_contents = host->shell_contents();
    NSView* shell = ViewOf(shell_contents);
    if (shell && [hit isDescendantOf:shell]) {
      KeepChromeHistorySwiperOff(shell_contents);
      return Hit{sp::Route::kShell, nullptr};
    }
    for (const auto& [id, binding] : host->bindings_) {
      NSView* view = ViewOf(binding->contents());
      if (view && [hit isDescendantOf:view]) {
        KeepChromeHistorySwiperOff(binding->contents());
        return Hit{sp::Route::kPage, binding.get()};
      }
    }
    return Hit();
  }

  void SendShell(std::string_view phase, std::string_view momentum, double dx, double dy, double x, double y,
                 double time) {
    host->Emit("ArdiaShell", sp::kScrollGestureEvent,
               base::Value(base::DictValue()
                               .Set("phase", std::string(phase))
                               .Set("momentum", std::string(momentum))
                               .Set("dx", dx)
                               .Set("dy", dy)
                               .Set("x", x)
                               .Set("y", y)
                               .Set("t", time)));
  }

  void EmitShell(sp::Kind kind, sp::Phase phase, sp::Phase momentum, double dx, double dy, NSEvent* event) {
    const std::optional<std::pair<double, double>> point = ShellPoint(event);
    if (!point) {
      return;
    }
    shell_x = point->first;
    shell_y = point->second;
    shell_time = event.timestamp;
    SendShell(sp::KindPhaseName(kind, phase), sp::PhaseName(momentum), dx, dy, shell_x, shell_y, shell_time);
  }

  void EmitShellCancel(double time) {
    if (host) {
      SendShell(sp::PhaseName(sp::Phase::kCancelled), sp::PhaseName(sp::Phase::kNone), 0, 0, shell_x, shell_y,
                std::fmax(time, shell_time));
    }
  }

  bool PageGesture(sp::Phase phase, double dx, double dy, const Hit& hit, NSEvent* event) {
    page_time = event.timestamp;
    switch (phase) {
      case sp::Phase::kNone:
      case sp::Phase::kMayBegin:
        return false;
      case sp::Phase::kBegan:
        StartPage(hit, event);
        Scroll(dx, dy);
        return false;
      case sp::Phase::kChanged:
        Scroll(dx, dy);
        return page.Swallows();
      case sp::Phase::kEnded:
      case sp::Phase::kCancelled:
        Scroll(dx, dy);
        FinishPage(phase == sp::Phase::kCancelled, event.timestamp);
        return false;
    }
    return false;
  }

  void StartPage(const Hit& hit, NSEvent* event) {
    FinishPage(true, event.timestamp);
    PageBinding* binding = hit.binding;
    content::WebContents* contents = binding ? binding->contents() : nullptr;
    content::RenderWidgetHostView* view = contents ? contents->GetRenderWidgetHostView() : nullptr;
    content::RenderFrameHost* frame = contents ? contents->GetPrimaryMainFrame() : nullptr;
    const std::optional<std::pair<double, double>> point = ShellPoint(event);
    const bool enabled = view && frame && point && binding->presented && binding->visible &&
                         NSEvent.isSwipeTrackingFromScrollEventsEnabled;
    page.Begin(enabled, ++next_gesture, EventMicros(ui::EventTimeStampFromSeconds(event.timestamp)));
    if (!enabled) {
      return;
    }
    page_binding = binding->id();
    page_generation = binding->binding_generation;
    page_contents = contents->GetWeakPtr();
    page_document = frame->GetWeakDocumentPtr();
    page_key = binding->key();
    page_x = point->first;
    page_y = point->second;
    watch->Watch(contents, view->GetRenderWidgetHost());
  }

  bool PageLive() const {
    if (!host || !page_contents || !watch->host()) {
      return false;
    }
    const auto found = host->bindings_.find(page_binding);
    if (found == host->bindings_.end()) {
      return false;
    }
    PageBinding* binding = found->second.get();
    content::WebContents* contents = binding->contents();
    if (contents != page_contents.get() || binding->binding_generation != page_generation ||
        binding->key() != page_key || !binding->presented || !binding->visible) {
      return false;
    }
    content::RenderFrameHost* frame = page_document.AsRenderFrameHostIfValid();
    content::RenderWidgetHostView* view = contents->GetRenderWidgetHostView();
    return frame && frame == contents->GetPrimaryMainFrame() && view &&
           view->GetRenderWidgetHost() == watch->host();
  }

  bool KeepPage() {
    if (!page.active()) {
      return false;
    }
    if (PageLive()) {
      return true;
    }
    FinishPage(true, page_time);
    return false;
  }

  void Scroll(double dx, double dy) {
    if (!KeepPage()) {
      return;
    }
    if (std::optional<sp::Step> step = page.Scroll(dx, dy)) {
      ForwardPage(*step, page_time);
    }
  }

  void Acknowledged(const sp::AckEvent& ack) {
    if (!KeepPage()) {
      return;
    }
    if (std::optional<sp::Step> step = page.Acknowledge(ack)) {
      ForwardPage(*step, page_time);
    }
  }

  void FinishPage(bool cancelled, double time) {
    const bool live = page.active() && PageLive();
    const std::optional<sp::Step> step = page.End(cancelled || !live);
    if (step) {
      ForwardPage(*step, time);
    }
    watch->Stop();
    page_contents = nullptr;
    page_document = content::WeakDocumentPtr();
    page_key.clear();
    page_binding = 0;
    page_generation = 0;
  }

  void ForwardPage(const sp::Step& step, double time) {
    if (!host || page_key.empty()) {
      return;
    }
    base::DictValue swipe = base::DictValue()
                                .Set("phase", std::string(sp::PhaseName(step.phase)))
                                .Set("dx", step.dx)
                                .Set("dy", step.dy)
                                .Set("t", time)
                                .Set("tabId", page_key)
                                .Set("gesture", static_cast<double>(page.gesture()));
    if (step.phase == sp::Phase::kBegan) {
      swipe.Set("x", page_x);
      swipe.Set("y", page_y);
    }
    host->Emit("ArdiaShell", sp::kPageSwipeEvent, base::Value(std::move(swipe)));
  }

  bool Claim(const base::DictValue& args) {
    const std::optional<std::uint64_t> gesture = sp::GestureId(args.FindDouble("gesture"));
    const std::string* tab = args.FindString("tabId");
    const std::optional<bool> claimed = args.FindBool("claimed");
    if (!gesture || !tab || !claimed || *tab != page_key || page_key.empty() || !KeepPage()) {
      return false;
    }
    return page.Claim(*gesture, *claimed);
  }
};

ScrollGestures::ScrollGestures(ShellHostView* host, views::Widget* widget) : state_(std::make_unique<Native>()) {
  Native* state = state_.get();
  state->host = host;
  base::WeakPtr<Native> weak = state->weak_factory.GetWeakPtr();
  state->watch = std::make_unique<PageWatch>(
      base::BindRepeating(
          [](base::WeakPtr<Native> native, sp::AckEvent ack) {
            if (native) {
              native->Acknowledged(ack);
            }
          },
          weak),
      base::BindRepeating(
          [](base::WeakPtr<Native> native) {
            if (native) {
              native->FinishPage(true, native->page_time);
            }
          },
          weak));
  NSWindow* window = widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
  state->window = window;
  if (!window) {
    return;
  }
  state->monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                                         handler:^NSEvent*(NSEvent* event) {
                                                           return state->Handle(event) ? nil : event;
                                                         }];
  const auto interrupt = ^(NSNotification*) {
    state->Interrupt();
  };
  [state->observers addObject:[NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidResignKeyNotification
                                                                              object:window
                                                                               queue:nil
                                                                          usingBlock:interrupt]];
  [state->observers addObject:[NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidResignActiveNotification
                                                                              object:NSApp
                                                                               queue:nil
                                                                          usingBlock:interrupt]];
}

ScrollGestures::~ScrollGestures() {
  if (state_->monitor) {
    [NSEvent removeMonitor:state_->monitor];
    state_->monitor = nil;
  }
  for (id observer in state_->observers) {
    [NSNotificationCenter.defaultCenter removeObserver:observer];
  }
  [state_->observers removeAllObjects];
  state_->weak_factory.InvalidateWeakPtrs();
  state_->watch->Stop();
  state_->page.End(true);
  state_->host = nullptr;
}

void ScrollGestures::AppendCapabilities(base::ListValue& capabilities) {
  capabilities.Append(sp::kScrollGesturesCapability);
  capabilities.Append(sp::kPageSwipeClaimCall);
}

bool ScrollGestures::Handles(const std::string& method) {
  return method == sp::kPageSwipeClaimCall;
}

void ScrollGestures::Invoke(const std::string& method, const base::DictValue& args, Done done) {
  if (method != sp::kPageSwipeClaimCall) {
    std::move(done).Run(false, base::Value("Unknown scroll gesture call"));
    return;
  }
  const bool claimed = state_->Claim(args);
  std::move(done).Run(true, base::Value(base::DictValue().Set("claimed", claimed)));
}

void ScrollGestures::Revalidate() {
  state_->KeepPage();
}

}
