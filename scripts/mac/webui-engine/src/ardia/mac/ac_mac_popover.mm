#include "ardia/mac/ac_mac_popover.h"

#import <AppKit/AppKit.h>

#include <utility>
#include <vector>

#include "ardia/mac/ac_mac_glass.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/profiles/profile.h"
#include "components/input/native_web_keyboard_event.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/common/referrer.h"
#include "ui/base/page_transition_types.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

@interface ArdiaMacPopoverPanel : NSPanel
@property(nonatomic) BOOL takesFocus;
@property(nonatomic, copy, nullable) void (^onEscape)(void);
@end

@implementation ArdiaMacPopoverPanel

@synthesize takesFocus = _takesFocus;
@synthesize onEscape = _onEscape;

- (BOOL)canBecomeKeyWindow {
  return self.takesFocus;
}

- (BOOL)canBecomeMainWindow {
  return NO;
}

- (void)cancelOperation:(id)sender {
  if (self.onEscape) {
    self.onEscape();
  }
}

@end

namespace ardia_mac {

namespace {

constexpr double kPanelRadius = 12;

std::optional<double> Number(const base::DictValue* dict, std::string_view key) {
  if (!dict) return std::nullopt;
  const base::Value* value = dict->Find(key);
  if (!value) return std::nullopt;
  if (value->is_int()) return static_cast<double>(value->GetInt());
  if (value->is_double()) return value->GetDouble();
  return std::nullopt;
}

std::optional<popover::Rect> RectOf(const base::DictValue* dict) {
  const std::optional<double> x = Number(dict, "x");
  const std::optional<double> y = Number(dict, "y");
  const std::optional<double> width = Number(dict, "width");
  const std::optional<double> height = Number(dict, "height");
  if (!x || !y || !width || !height) return std::nullopt;
  const popover::Rect rect{*x, *y, *width, *height};
  return popover::ValidRect(rect) ? std::optional<popover::Rect>(rect) : std::nullopt;
}

double PrimaryHeight() {
  NSScreen* primary = NSScreen.screens.firstObject;
  return primary ? NSMaxY(primary.frame) : 0;
}

popover::Rect TopLeft(NSRect rect) {
  return popover::FlipVertical(
      popover::Rect{NSMinX(rect), NSMinY(rect), NSWidth(rect), NSHeight(rect)},
      PrimaryHeight());
}

std::vector<popover::Rect> VisibleScreens() {
  std::vector<popover::Rect> screens;
  for (NSScreen* screen in NSScreen.screens) {
    screens.push_back(TopLeft(screen.visibleFrame));
  }
  return screens;
}

std::optional<popover::Rect> ContentOnScreen(gfx::NativeView shell_view) {
  NSView* view = shell_view.GetNativeNSView();
  if (!view.window) return std::nullopt;
  const NSRect in_window = [view convertRect:view.bounds toView:nil];
  return TopLeft([view.window convertRectToScreen:in_window]);
}

std::string Text(const base::DictValue& dict, std::string_view key) {
  const std::string* found = dict.FindString(key);
  return found ? *found : std::string();
}

std::optional<std::size_t> SerializedSize(const base::Value& value) {
  const std::optional<std::string> json = base::WriteJson(value);
  return json ? std::optional<std::size_t>(json->size()) : std::nullopt;
}

bool PropsAccepted(const base::Value& props) {
  return props.is_dict() && popover::PropsFit(SerializedSize(props));
}

NSView* MakeBackground() {
  if (LiquidGlassAvailable()) {
    NSView* view = [[NSClassFromString(@"NSGlassEffectView") alloc] initWithFrame:NSZeroRect];
    if ([view respondsToSelector:NSSelectorFromString(@"setCornerRadius:")]) {
      [view setValue:@(kPanelRadius) forKey:@"cornerRadius"];
    }
    return view;
  }
  NSVisualEffectView* view = [[NSVisualEffectView alloc] initWithFrame:NSZeroRect];
  view.material = NSVisualEffectMaterialPopover;
  view.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  view.state = NSVisualEffectStateActive;
  view.wantsLayer = YES;
  view.layer.cornerRadius = kPanelRadius;
  view.layer.cornerCurve = kCACornerCurveContinuous;
  view.layer.masksToBounds = YES;
  return view;
}

void Embed(NSView* background, NSView* content) {
  content.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  content.wantsLayer = YES;
  content.layer.cornerRadius = kPanelRadius;
  content.layer.cornerCurve = kCACornerCurveContinuous;
  content.layer.masksToBounds = YES;
  if ([background respondsToSelector:NSSelectorFromString(@"setContentView:")]) {
    [background setValue:content forKey:@"contentView"];
    return;
  }
  content.frame = background.bounds;
  [background addSubview:content];
}

}

struct PopoverHost::Panel : public content::WebContentsDelegate,
                            public content::WebContentsObserver {
  Panel(PopoverHost* owner, std::string popover_key)
      : host(owner), key(std::move(popover_key)) {}

  void Attach(std::unique_ptr<content::WebContents> created) {
    contents = std::move(created);
    contents->SetDelegate(this);
    Observe(contents.get());
    Transparent();
  }

  void Transparent() {
    if (!contents) return;
    contents->SetPageBaseBackgroundColor(SK_ColorTRANSPARENT);
    if (content::RenderWidgetHostView* view = contents->GetRenderWidgetHostView()) {
      view->SetBackgroundColor(SK_ColorTRANSPARENT);
    }
  }

  void RenderViewReady() override { Transparent(); }
  void PrimaryPageChanged(content::Page& page) override { Transparent(); }
  void PrimaryMainFrameRenderProcessGone(base::TerminationStatus status) override {
    if (host) host->Dismiss(key, popover::Event::kContentFailed);
  }

  ~Panel() override {
    for (id observer in observers) {
      [NSNotificationCenter.defaultCenter removeObserver:observer];
    }
    if (monitor) {
      [NSEvent removeMonitor:monitor];
    }
    ArdiaMacPopoverPanel* window = panel;
    panel.onEscape = nil;
    [window.parentWindow removeChildWindow:window];
    [window orderOut:nil];
    Observe(nullptr);
    if (contents) {
      contents->SetDelegate(nullptr);
    }
    [window close];
  }

  bool HandleKeyboardEvent(content::WebContents* source,
                           const input::NativeWebKeyboardEvent& event) override {
    if (event.GetType() == blink::WebInputEvent::Type::kRawKeyDown &&
        event.windows_key_code == ui::VKEY_ESCAPE && host) {
      host->Dismiss(key, popover::Event::kEscape);
      return true;
    }
    return false;
  }

  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)> callback) override {
    return nullptr;
  }

  raw_ptr<PopoverHost> host;
  std::string key;
  popover::State state = popover::State::kClosed;
  popover::Options options;
  std::optional<bool> beyond_window;
  popover::Rect frame;
  std::string route;
  base::Value props;
  Sink sink;
  std::unique_ptr<content::WebContents> contents;
  ArdiaMacPopoverPanel* panel = nil;
  NSMutableArray* observers = [NSMutableArray array];
  id monitor = nil;
};

PopoverHost::PopoverHost(views::Widget* parent,
                         Profile* profile,
                         std::string window_id,
                         bool background_instance,
                         Dismissed dismissed)
    : parent_(parent),
      profile_(profile),
      window_id_(std::move(window_id)),
      background_(background_instance),
      dismissed_(std::move(dismissed)) {}

PopoverHost::~PopoverHost() {
  panels_.clear();
}

bool PopoverHost::Owns(const content::WebContents* contents) const {
  return IdFor(contents).has_value();
}

std::optional<std::string> PopoverHost::IdFor(const content::WebContents* contents) const {
  for (const auto& [key, panel] : panels_) {
    if (contents && panel->contents.get() == contents) {
      return key;
    }
  }
  return std::nullopt;
}

std::optional<std::string> PopoverHost::BootstrapJson(
    const content::WebContents* contents) const {
  const std::optional<std::string> key = IdFor(contents);
  if (!key) {
    return std::nullopt;
  }
  const Panel& panel = *panels_.at(*key);
  base::DictValue bootstrap;
  bootstrap.Set("windowId", window_id_);
  bootstrap.Set("windowKind", "popover");
  bootstrap.Set("surface", "popover");
  bootstrap.Set("startup", false);
  bootstrap.Set("capabilities", base::ListValue()
                                    .Append("shell.popover.close")
                                    .Append("shell.popover.message")
                                    .Append("shell.popover.props"));
  bootstrap.Set("popover", base::DictValue()
                               .Set("id", panel.key)
                               .Set("route", panel.route)
                               .Set("props", panel.props.Clone()));
  return base::WriteJson(bootstrap);
}

std::optional<base::Value> PopoverHost::PropsFor(
    const content::WebContents* contents) const {
  const std::optional<std::string> key = IdFor(contents);
  if (!key) {
    return std::nullopt;
  }
  return panels_.at(*key)->props.Clone();
}

void PopoverHost::Connect(const content::WebContents* contents, Sink sink) {
  const std::optional<std::string> key = IdFor(contents);
  if (key) {
    panels_.at(*key)->sink = std::move(sink);
  }
}

std::optional<std::string> PopoverHost::Place(Panel& panel,
                                              const base::DictValue& args,
                                              gfx::NativeView shell_view,
                                              double shell_zoom) {
  const std::optional<popover::Rect> content = ContentOnScreen(shell_view);
  if (!content) {
    return "The shell has no window";
  }
  const std::optional<popover::Rect> anchor_css = RectOf(args.FindDict("anchor"));
  const std::optional<popover::Rect> rect_css = RectOf(args.FindDict("rect"));
  const std::vector<popover::Rect> screens = VisibleScreens();
  const bool beyond =
      popover::ResolveBeyondWindow(args.FindBool("beyondWindow"), panel.beyond_window);
  std::optional<popover::Rect> anchor;
  if (anchor_css) {
    anchor = popover::WindowToScreen(
        popover::Rect{anchor_css->x, anchor_css->y, std::max(1.0, anchor_css->width),
                      std::max(1.0, anchor_css->height)},
        *content, shell_zoom);
  }
  std::optional<popover::Rect> wanted;
  if (rect_css) {
    wanted = popover::WindowToScreen(*rect_css, *content, shell_zoom);
  } else if (anchor) {
    const base::DictValue* size = args.FindDict("size");
    popover::Request request;
    request.anchor = *anchor;
    request.size = {Number(size, "width").value_or(0), Number(size, "height").value_or(0)};
    const std::string* side = args.FindString("side");
    request.edge = popover::EdgeNamed(side ? *side : std::string_view()).value_or(popover::Edge::kBelow);
    if (std::optional<popover::Placed> placed = popover::Place(request, screens)) {
      wanted = placed->frame;
    }
  }
  if (!wanted) {
    return "A popover needs a finite rect in window pixels";
  }
  const std::optional<popover::Clamped> clamped = popover::ClampToScreen(
      *wanted, anchor.value_or(popover::Rect{}), screens, beyond, *content);
  if (!clamped) {
    return "The popover has no screen to show on";
  }
  panel.beyond_window = beyond;
  panel.frame = clamped->frame;
  const popover::Rect cocoa = popover::FlipVertical(panel.frame, PrimaryHeight());
  [panel.panel setFrame:NSMakeRect(cocoa.x, cocoa.y, cocoa.width, cocoa.height)
                display:!background_];
  if (panel.panel.hasShadow) {
    [panel.panel invalidateShadow];
  }
  return std::nullopt;
}

void PopoverHost::Show(Panel& panel) {
  NSWindow* parent = parent_ ? parent_->GetNativeWindow().GetNativeNSWindow() : nil;
  const popover::Focus focus =
      popover::FocusFor(background_, panel.options.takes_focus, NSApp.isActive, parent.isKeyWindow);
  if (focus.logged) {
    LOG(WARNING) << "Ardia Mac WebUI: popover " << panel.key << " route=" << panel.route
                 << " frame=" << panel.frame.x << "," << panel.frame.y << " "
                 << panel.frame.width << "x" << panel.frame.height << " (background, not shown)";
  }
  if (!focus.shown || !parent) {
    return;
  }
  [parent addChildWindow:panel.panel ordered:NSWindowAbove];
  [panel.panel orderFront:nil];
  if (focus.becomes_key) {
    [panel.panel makeKeyWindow];
  }
  base::WeakPtr<PopoverHost> weak = weak_factory_.GetWeakPtr();
  const std::string key = panel.key;
  NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
  const auto observe = [&](NSNotificationName name, id object, popover::Event event) {
    [panel.observers addObject:[center addObserverForName:name
                                                   object:object
                                                    queue:nil
                                               usingBlock:^(NSNotification*) {
                                                 if (weak) weak->Dismiss(key, event);
                                               }]];
  };
  observe(NSWindowDidResizeNotification, parent, popover::Event::kParentResized);
  observe(NSWindowWillCloseNotification, parent, popover::Event::kParentClosed);
  observe(NSWindowWillMiniaturizeNotification, parent, popover::Event::kParentMinimized);
  observe(NSApplicationDidResignActiveNotification, nil, popover::Event::kAppDeactivated);
  ArdiaMacPopoverPanel* own = panel.panel;
  [panel.observers
      addObject:[center addObserverForName:NSWindowDidResignKeyNotification
                                    object:own
                                     queue:nil
                                usingBlock:^(NSNotification*) {
                                  NSWindow* now_key = NSApp.keyWindow;
                                  if (weak && ![now_key isKindOfClass:ArdiaMacPopoverPanel.class]) {
                                    weak->Dismiss(key, popover::Event::kResignedKey);
                                  }
                                }]];
  panel.monitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown |
                                           NSEventMaskOtherMouseDown
                                   handler:^NSEvent*(NSEvent* event) {
                                     if (!weak || [event.window isKindOfClass:ArdiaMacPopoverPanel.class]) {
                                       return event;
                                     }
                                     const NSPoint at = NSEvent.mouseLocation;
                                     const popover::Rect point = TopLeft(NSMakeRect(at.x, at.y, 0, 0));
                                     const popover::Rect frame = TopLeft(own.frame);
                                     if (popover::ClassifyClick({point.x, point.y}, frame) ==
                                         popover::Event::kOutsideClick) {
                                       weak->Dismiss(key, popover::Event::kOutsideClick);
                                     }
                                     return event;
                                   }];
}

std::optional<std::string> PopoverHost::Open(const base::DictValue& args,
                                             gfx::NativeView shell_view,
                                             double shell_zoom) {
  const std::string key = Text(args, "id");
  if (!popover::ValidId(key)) {
    return "A popover needs an id";
  }
  if (Text(args, "windowId") != window_id_) {
    return "The popover belongs to another window";
  }
  if (panels_.contains(key)) {
    return Update(args, shell_view, shell_zoom);
  }
  if (panels_.size() >= popover::kMaxOpen) {
    return "Too many popovers are open";
  }
  const base::DictValue* content = args.FindDict("content");
  const std::string route = content ? Text(*content, "route") : std::string();
  if (!popover::ValidRoute(route)) {
    return "A popover needs a content route";
  }
  if (!profile_) {
    return "The window has no profile";
  }
  auto panel = std::make_unique<Panel>(this, key);
  panel->route = route;
  const base::Value* props = content->Find("props");
  if (props && !PropsAccepted(*props)) {
    return "Popover props must be an object of at most 256 KiB";
  }
  panel->props = props ? props->Clone() : base::Value(base::DictValue());
  panel->options.takes_focus = args.FindBool("takesFocus").value_or(true);
  panel->panel = [[ArdiaMacPopoverPanel alloc]
      initWithContentRect:NSMakeRect(0, 0, 10, 10)
                styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                  backing:NSBackingStoreBuffered
                    defer:YES];
  ArdiaMacPopoverPanel* window = panel->panel;
  window.takesFocus = panel->options.takes_focus;
  window.becomesKeyOnlyIfNeeded = !panel->options.takes_focus;
  window.floatingPanel = NO;
  window.hidesOnDeactivate = NO;
  window.releasedWhenClosed = NO;
  window.opaque = NO;
  window.backgroundColor = NSColor.clearColor;
  window.hasShadow = !LiquidGlassAvailable();
  window.animationBehavior = NSWindowAnimationBehaviorNone;
  window.collectionBehavior = NSWindowCollectionBehaviorFullScreenAuxiliary |
                              NSWindowCollectionBehaviorTransient |
                              NSWindowCollectionBehaviorIgnoresCycle;
  if (NSWindow* parent = parent_ ? parent_->GetNativeWindow().GetNativeNSWindow() : nil) {
    window.level = parent.level;
  }
  base::WeakPtr<PopoverHost> weak = weak_factory_.GetWeakPtr();
  window.onEscape = ^{
    if (weak) weak->Dismiss(key, popover::Event::kEscape);
  };
  NSView* background = MakeBackground();
  window.contentView = background;
  panel->Attach(content::WebContents::Create(content::WebContents::CreateParams(profile_)));
  Embed(background, panel->contents->GetNativeView().GetNativeNSView());
  Panel& placed = *panel;
  panels_.emplace(key, std::move(panel));
  if (std::optional<std::string> error = Place(placed, args, shell_view, shell_zoom)) {
    panels_.erase(key);
    return error;
  }
  placed.state = popover::Step(placed.state, popover::Event::kOpen, placed.options).next;
  placed.contents->GetController().LoadURL(
      GURL("chrome://ardia/?popover=" + key), content::Referrer(),
      ui::PAGE_TRANSITION_AUTO_TOPLEVEL, std::string());
  Show(placed);
  return std::nullopt;
}

std::optional<std::string> PopoverHost::Update(const base::DictValue& args,
                                               gfx::NativeView shell_view,
                                               double shell_zoom) {
  const std::string key = Text(args, "id");
  if (Text(args, "windowId") != window_id_) {
    return "The popover belongs to another window";
  }
  auto found = panels_.find(key);
  if (found == panels_.end()) {
    return "No such popover";
  }
  Panel& panel = *found->second;
  const popover::Transition transition =
      popover::Step(panel.state, popover::Event::kUpdate, panel.options);
  if (!transition.reposition) {
    return std::nullopt;
  }
  const base::DictValue* content = args.FindDict("content");
  if (const base::Value* props = content ? content->Find("props") : nullptr) {
    if (!PropsAccepted(*props)) {
      return "Popover props must be an object of at most 256 KiB";
    }
    panel.props = props->Clone();
    if (panel.sink) {
      panel.sink.Run("props", base::Value(base::DictValue()
                                              .Set("id", panel.key)
                                              .Set("props", panel.props.Clone())));
    }
  }
  if (!args.FindDict("rect") && !args.FindDict("anchor")) {
    return std::nullopt;
  }
  return Place(panel, args, shell_view, shell_zoom);
}

std::optional<std::string> PopoverHost::Close(const base::DictValue& args) {
  const std::string key = Text(args, "id");
  if (Text(args, "windowId") != window_id_) {
    return "The popover belongs to another window";
  }
  const std::string reason = Text(args, "reason");
  if (!popover::ReasonNamed(reason)) {
    return "Unknown popover close reason";
  }
  Dismiss(key, reason == "replaced" ? popover::Event::kReplaced : popover::Event::kClose);
  return std::nullopt;
}

void PopoverHost::Dismiss(const std::string& key, popover::Event event) {
  auto found = panels_.find(key);
  if (found == panels_.end()) {
    return;
  }
  Panel& panel = *found->second;
  const popover::Transition transition = popover::Step(panel.state, event, panel.options);
  if (!transition.hide) {
    return;
  }
  panel.state = transition.next;
  std::unique_ptr<Panel> gone = std::move(found->second);
  panels_.erase(found);
  gone->host = nullptr;
  [gone->panel orderOut:nil];
  if (transition.notify && dismissed_) {
    dismissed_.Run(key, popover::ReasonName(transition.reason));
  }
  base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE, std::move(gone));
}

void PopoverHost::CloseAll(popover::Event event) {
  std::vector<std::string> keys;
  for (const auto& [key, panel] : panels_) {
    keys.push_back(key);
  }
  for (const std::string& key : keys) {
    Dismiss(key, event);
  }
}

}
