// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/strings/utf_string_conversions.h"
#include "ardia/core/ac_tab_input_internal.h"
#include "content/public/browser/host_zoom_map.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/common/input/web_keyboard_event.h"
#include "third_party/blink/public/common/input/web_pointer_properties.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "ui/events/keycodes/dom/dom_code.h"
#include "ui/events/keycodes/dom/dom_key.h"
#include "ui/events/keycodes/dom/keycode_converter.h"
#include "ui/events/keycodes/keyboard_code_conversion.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/events/types/scroll_types.h"
#include "ui/gfx/geometry/point_f.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "url/scheme_host_port.h"
#include "url/url_constants.h"

namespace ardiacore::tab_input_internal {

using blink::WebInputEvent;
using blink::WebMouseEvent;
using blink::WebMouseWheelEvent;
using blink::WebPointerProperties;

namespace {

constexpr size_t kMaxTextUnits = 4096;
constexpr size_t kMaxKeyBytes = 32;
constexpr double kMaxDelta = 10000;
constexpr double kMaxCoordinate = 100000;

bool KnownAction(std::string_view action) {
  return action == "click" || action == "dblclick" || action == "move" || action == "down" ||
         action == "up" || action == "wheel" || action == "key" || action == "text";
}

bool Takes(std::string_view action, std::string_view field) {
  if (field == "tab" || field == "action" || field == "prime" || field == "token") {
    return true;
  }
  const bool press = action == "down" || action == "up";
  const bool clicks = press || action == "click" || action == "dblclick";
  const bool pointer = clicks || action == "move" || action == "wheel";
  if (pointer && (field == "x" || field == "y" || field == "modifiers")) {
    return true;
  }
  if (clicks && field == "button") {
    return true;
  }
  if (press && field == "clickCount") {
    return true;
  }
  if (action == "wheel" && (field == "deltaX" || field == "deltaY")) {
    return true;
  }
  if (action == "key" && (field == "key" || field == "code" || field == "modifiers")) {
    return true;
  }
  return action == "text" && field == "text";
}

bool WebScheme(const std::string& scheme) {
  return scheme == url::kHttpScheme || scheme == url::kHttpsScheme || scheme == url::kFileScheme;
}

bool TakesInput(content::RenderFrameHost* frame) {
  if (!frame || frame->IsErrorDocument()) {
    return false;
  }
  const GURL& url = frame->GetLastCommittedURL();
  if (!url.SchemeIsHTTPOrHTTPS() && !url.SchemeIsFile() && !url.IsAboutBlank()) {
    return false;
  }
  const url::SchemeHostPort& tuple =
      frame->GetLastCommittedOrigin().GetTupleOrPrecursorTupleIfOpaque();
  return !tuple.IsValid() || WebScheme(tuple.scheme());
}

int Modifiers(const base::DictValue& args) {
  int flags = 0;
  const base::ListValue* list = args.FindList("modifiers");
  if (!list) {
    return args.Find("modifiers") ? -1 : flags;
  }
  if (list->size() > 4) {
    return -1;
  }
  for (const base::Value& item : *list) {
    if (!item.is_string()) {
      return -1;
    }
    const std::string& name = item.GetString();
    if (name == "shift") {
      flags |= WebInputEvent::kShiftKey;
    } else if (name == "control") {
      flags |= WebInputEvent::kControlKey;
    } else if (name == "alt") {
      flags |= WebInputEvent::kAltKey;
    } else if (name == "meta") {
      flags |= WebInputEvent::kMetaKey;
    } else {
      return -1;
    }
  }
  return flags;
}

std::optional<WebPointerProperties::Button> ButtonOf(const base::DictValue& args) {
  const std::string* name = args.FindString("button");
  if (!name) {
    return args.Find("button") ? std::nullopt
                               : std::optional(WebPointerProperties::Button::kLeft);
  }
  if (*name == "left") {
    return WebPointerProperties::Button::kLeft;
  }
  if (*name == "middle") {
    return WebPointerProperties::Button::kMiddle;
  }
  return std::nullopt;
}

int ButtonDownFlag(WebPointerProperties::Button button) {
  return button == WebPointerProperties::Button::kMiddle
             ? WebInputEvent::kMiddleButtonDown
             : WebInputEvent::kLeftButtonDown;
}

std::optional<gfx::PointF> PointOf(const base::DictValue& args, const Target& target) {
  std::optional<double> x = args.FindDouble("x");
  std::optional<double> y = args.FindDouble("y");
  if (!x || !y || !std::isfinite(*x) || !std::isfinite(*y) || *x < 0 || *y < 0) {
    return std::nullopt;
  }
  const double dip_x = *x * target.zoom;
  const double dip_y = *y * target.zoom;
  const double width = target.bounds.width();
  const double height = target.bounds.height();
  if (dip_x >= width || dip_y >= height) {
    return std::nullopt;
  }
  const float inside_x = std::nextafter(static_cast<float>(width), 0.0f);
  const float inside_y = std::nextafter(static_cast<float>(height), 0.0f);
  return gfx::PointF(std::min(static_cast<float>(dip_x), inside_x),
                     std::min(static_cast<float>(dip_y), inside_y));
}

WebMouseEvent MouseEvent(WebInputEvent::Type type,
                         int modifiers,
                         WebPointerProperties::Button button,
                         int clicks,
                         gfx::PointF point,
                         const Target& target) {
  WebMouseEvent event(type, modifiers, NextStamp());
  event.button = button;
  event.click_count = clicks;
  event.pointer_type = WebPointerProperties::PointerType::kMouse;
  event.SetPositionInWidget(point);
  event.SetPositionInScreen(gfx::PointF(point.x() + target.bounds.x(),
                                        point.y() + target.bounds.y()));
  return event;
}

struct KeySpec {
  ui::DomKey key;
  ui::DomCode code;
  ui::KeyboardCode windows;
  std::u16string text;
};

std::optional<KeySpec> KeyOf(const base::DictValue& args, int modifiers) {
  const std::string* key = args.FindString("key");
  const std::string* code = args.FindString("code");
  if (!key || key->empty() || key->size() > kMaxKeyBytes ||
      key->find('\0') != std::string::npos || (!code && args.Find("code")) ||
      (code && (code->empty() || code->size() > kMaxKeyBytes ||
                code->find('\0') != std::string::npos))) {
    return std::nullopt;
  }
  const ui::DomKey dom_key = ui::KeycodeConverter::KeyStringToDomKey(*key);
  if (dom_key == ui::DomKey::NONE) {
    return std::nullopt;
  }
  const ui::DomCode dom_code = code && !code->empty()
                                   ? ui::KeycodeConverter::CodeStringToDomCode(*code)
                                   : ui::UsLayoutDomKeyToDomCode(dom_key);
  if (code && !code->empty() && dom_code == ui::DomCode::NONE) {
    return std::nullopt;
  }
  const ui::KeyboardCode windows = dom_code != ui::DomCode::NONE
                                       ? ui::DomCodeToUsLayoutKeyboardCode(dom_code)
                                       : ui::NonPrintableDomKeyToKeyboardCode(dom_key);
  std::u16string text;
  const bool command = modifiers & (WebInputEvent::kControlKey | WebInputEvent::kMetaKey);
  if (dom_key == ui::DomKey::ENTER) {
    text = u"\r";
  } else if (dom_key.IsCharacter() && !command) {
    const uint32_t character = dom_key.ToCharacter();
    if (character >= 0x20 && character != 0x7F) {
      text = base::UTF8ToUTF16(*key);
    }
  }
  return KeySpec{dom_key, dom_code, windows, std::move(text)};
}

input::NativeWebKeyboardEvent KeyEvent(WebInputEvent::Type type,
                                       int modifiers,
                                       const KeySpec& spec) {
  input::NativeWebKeyboardEvent event(type, modifiers, NextStamp());
  event.windows_key_code = spec.windows;
  event.dom_key = static_cast<int>(spec.key);
  event.dom_code = static_cast<int>(spec.code);
  event.skip_if_unhandled = true;
  if (type == WebInputEvent::Type::kChar) {
    const size_t units =
        std::min(spec.text.size(), blink::WebKeyboardEvent::kTextLengthCap - 1);
    for (size_t i = 0; i < units; ++i) {
      event.text[i] = spec.text[i];
      event.unmodified_text[i] = spec.text[i];
    }
  }
  return event;
}

WebPointerProperties::Button HeldButton(int held) {
  if (held & WebInputEvent::kLeftButtonDown) {
    return WebPointerProperties::Button::kLeft;
  }
  if (held & WebInputEvent::kMiddleButtonDown) {
    return WebPointerProperties::Button::kMiddle;
  }
  return WebPointerProperties::Button::kNoButton;
}

Built Mouse(const base::DictValue& args, const std::string& action, const Target& target, int held) {
  const int modifiers = Modifiers(args);
  std::optional<WebPointerProperties::Button> button = ButtonOf(args);
  if (modifiers < 0 || !button) {
    return base::unexpected(Refusal("bad_request", "Unknown modifier or button."));
  }
  const bool press = action == "click" || action == "dblclick" || action == "down" || action == "up";
  if (press && (modifiers & WebInputEvent::kControlKey)) {
    return base::unexpected(Refusal("bad_request", "A Control-click opens Ardia's own menu, so tabs.input doesn't send one."));
  }
  if (action == "wheel" && (modifiers & (WebInputEvent::kControlKey | WebInputEvent::kMetaKey))) {
    return base::unexpected(Refusal("bad_request", "A wheel with Control or Command zooms the page, so tabs.input doesn't send one."));
  }
  const base::Value* x = args.Find("x");
  const base::Value* y = args.Find("y");
  if (!x || !y || !(x->is_int() || x->is_double()) || !(y->is_int() || y->is_double())) {
    return base::unexpected(Refusal("bad_request", "x and y must be numbers."));
  }
  if (x->GetDouble() > kMaxCoordinate || y->GetDouble() > kMaxCoordinate) {
    return base::unexpected(Refusal("bad_request", "x and y must be at most 100000."));
  }
  std::optional<gfx::PointF> point = PointOf(args, target);
  if (!point) {
    return base::unexpected(Refusal("out_of_bounds", "That point is outside the tab's page."));
  }
  const base::Value* click_count = args.Find("clickCount");
  if (click_count && (!click_count->is_int() || click_count->GetInt() < 1 || click_count->GetInt() > 3)) {
    return base::unexpected(Refusal("bad_request", "clickCount must be 1, 2 or 3."));
  }
  const int clicks = click_count ? click_count->GetInt() : 1;
  const int flag = ButtonDownFlag(*button);
  if (action == "down" && (held & flag)) {
    return base::unexpected(Refusal("bad_request", "That button is already down; send up first."));
  }
  if (action == "up" && !(held & flag)) {
    return base::unexpected(Refusal("bad_request", "That button isn't down; send down first."));
  }
  if ((action == "click" || action == "dblclick") && (held & flag)) {
    return base::unexpected(Refusal("bad_request", "That button is down; send up before clicking it."));
  }
  const int moving = modifiers | held;
  const int down = moving | flag;
  const int up = modifiers | (held & ~flag);
  const auto dragging = HeldButton(held);
  Prepared prepared;
  prepared.target = target;
  std::vector<WebMouseEvent>& events = prepared.mice;
  if (action == "move") {
    events.push_back(MouseEvent(WebInputEvent::Type::kMouseMove, moving, dragging, 0, *point, target));
  } else if (action == "down") {
    events.push_back(MouseEvent(WebInputEvent::Type::kMouseMove, moving, dragging, 0, *point, target));
    events.push_back(MouseEvent(WebInputEvent::Type::kMouseDown, down, *button, clicks, *point, target));
    prepared.transition = flag;
    prepared.pressing = true;
  } else if (action == "up") {
    events.push_back(MouseEvent(WebInputEvent::Type::kMouseUp, up, *button, clicks, *point, target));
    prepared.transition = flag;
  } else if (action == "click" || action == "dblclick") {
    events.push_back(MouseEvent(WebInputEvent::Type::kMouseMove, moving, dragging, 0, *point, target));
    const int presses = action == "click" ? 1 : 2;
    for (int count = 1; count <= presses; ++count) {
      events.push_back(MouseEvent(WebInputEvent::Type::kMouseDown, down, *button, count, *point, target));
      events.push_back(MouseEvent(WebInputEvent::Type::kMouseUp, up, *button, count, *point, target));
    }
    prepared.transition = flag;
  } else if (action == "wheel") {
    for (const char* delta : {"deltaX", "deltaY"}) {
      const base::Value* given = args.Find(delta);
      if (given && !(given->is_int() || given->is_double())) {
        return base::unexpected(Refusal("bad_request", "deltaX and deltaY must be numbers."));
      }
    }
    const double dx = args.FindDouble("deltaX").value_or(0);
    const double dy = args.FindDouble("deltaY").value_or(0);
    if (!std::isfinite(dx) || !std::isfinite(dy) || std::abs(dx) > kMaxDelta ||
        std::abs(dy) > kMaxDelta || (dx == 0 && dy == 0)) {
      return base::unexpected(Refusal("bad_request", "A wheel needs a deltaX or deltaY within ±10000."));
    }
    events.push_back(MouseEvent(WebInputEvent::Type::kMouseMove, moving, dragging, 0, *point, target));
    WebMouseWheelEvent wheel(WebInputEvent::Type::kMouseWheel, moving, NextStamp());
    wheel.SetPositionInWidget(*point);
    wheel.SetPositionInScreen(gfx::PointF(point->x() + target.bounds.x(),
                                          point->y() + target.bounds.y()));
    wheel.delta_x = static_cast<float>(-dx * target.zoom);
    wheel.delta_y = static_cast<float>(-dy * target.zoom);
    wheel.wheel_ticks_x = wheel.delta_x == 0 ? 0 : (wheel.delta_x > 0 ? 1 : -1);
    wheel.wheel_ticks_y = wheel.delta_y == 0 ? 0 : (wheel.delta_y > 0 ? 1 : -1);
    wheel.phase = WebMouseWheelEvent::kPhaseBegan;
    wheel.delta_units = ui::ScrollGranularity::kScrollByPrecisePixel;
    wheel.dispatch_type = WebInputEvent::DispatchType::kBlocking;
    prepared.wheel = wheel;
    prepared.awaited = WebInputEvent::Type::kMouseWheel;
    prepared.stamp = wheel.TimeStamp();
    return prepared;
  } else {
    return base::unexpected(Refusal("bad_request", "Unknown input action."));
  }
  prepared.awaited = events.back().GetType();
  prepared.stamp = events.back().TimeStamp();
  return prepared;
}

Built Key(const base::DictValue& args, const Target& target) {
  const int modifiers = Modifiers(args);
  if (modifiers < 0) {
    return base::unexpected(Refusal("bad_request", "Unknown modifier."));
  }
  std::optional<KeySpec> spec = KeyOf(args, modifiers);
  if (!spec) {
    return base::unexpected(Refusal("bad_key", "Ardia doesn't know that key or code."));
  }
  if (spec->windows == ui::VKEY_APPS || spec->key == ui::DomKey::CONTEXT_MENU ||
      spec->code == ui::DomCode::CONTEXT_MENU ||
      (spec->windows == ui::VKEY_F10 && (modifiers & WebInputEvent::kShiftKey))) {
    return base::unexpected(Refusal("bad_request", "The context menu key opens Ardia's own menu, so tabs.input doesn't send it."));
  }
  Prepared prepared;
  prepared.target = target;
  prepared.focused_frame = true;
  prepared.keys.push_back(KeyEvent(WebInputEvent::Type::kRawKeyDown, modifiers, *spec));
  if (!spec->text.empty()) {
    prepared.keys.push_back(KeyEvent(WebInputEvent::Type::kChar, modifiers, *spec));
  }
  prepared.keys.push_back(KeyEvent(WebInputEvent::Type::kKeyUp, modifiers, *spec));
  prepared.awaited = WebInputEvent::Type::kKeyUp;
  prepared.stamp = prepared.keys.back().TimeStamp();
  return prepared;
}

Built Text(const base::DictValue& args, const Target& target) {
  const std::string* text = args.FindString("text");
  if (!text || text->empty()) {
    return base::unexpected(Refusal("bad_request", "text needs at least one character."));
  }
  if (text->find('\0') != std::string::npos) {
    return base::unexpected(Refusal("bad_request", "text holds no NUL."));
  }
  Prepared prepared;
  prepared.target = target;
  prepared.focused_frame = true;
  prepared.text = base::UTF8ToUTF16(*text);
  if (prepared.text.size() > kMaxTextUnits) {
    return base::unexpected(Refusal("bad_request", "text takes at most 4096 characters."));
  }
  return prepared;
}

}

base::DictValue Refusal(const char* code, const char* reason) {
  return base::DictValue().Set("ok", false).Set("code", code).Set("reason", reason);
}

base::TimeTicks NextStamp() {
  static base::TimeTicks last;
  base::TimeTicks now = base::TimeTicks::Now();
  if (now <= last) {
    now = last + base::Microseconds(1);
  }
  last = now;
  return now;
}

std::optional<Target> TargetOf(content::WebContents* contents, bool focused_frame) {
  if (!contents || contents->IsBeingDestroyed() || contents->IsCrashed()) {
    return std::nullopt;
  }
  content::RenderFrameHost* main = contents->GetPrimaryMainFrame();
  if (!main || !main->IsRenderFrameLive()) {
    return std::nullopt;
  }
  content::RenderFrameHost* frame = focused_frame ? contents->GetFocusedFrame() : nullptr;
  content::RenderWidgetHost* widget = (frame ? frame : main)->GetRenderWidgetHost();
  content::RenderWidgetHostView* view = main->GetView();
  if (!widget || !view || !widget->GetProcess()->IsInitializedAndNotDead()) {
    return std::nullopt;
  }
  gfx::Rect bounds = view->GetViewBounds();
  bounds.set_size(view->GetVisibleViewportSize());
  if (bounds.IsEmpty()) {
    return std::nullopt;
  }
  const double zoom =
      blink::ZoomLevelToZoomFactor(content::HostZoomMap::GetZoomLevel(contents));
  return Target{widget, bounds, zoom > 0 ? zoom : 1};
}

base::DictValue Viewport(const Target& target) {
  return base::DictValue()
      .Set("width", std::floor(target.bounds.width() / target.zoom))
      .Set("height", std::floor(target.bounds.height() / target.zoom));
}

Built Build(content::WebContents* contents, const base::DictValue& args, const std::string& action, int held) {
  if (!KnownAction(action)) {
    return base::unexpected(Refusal("bad_request", "Unknown input action."));
  }
  for (const auto [field, value] : args) {
    if (!Takes(action, field)) {
      return base::unexpected(Refusal("bad_request", "That action takes no such field."));
    }
  }
  const bool focused = action == "key" || action == "text";
  std::optional<Target> target = TargetOf(contents, focused);
  if (!target) {
    return base::unexpected(Refusal("no_page", "That tab's page isn't loaded or has no size yet."));
  }
  content::RenderFrameHost* frame = focused ? contents->GetFocusedFrame() : nullptr;
  if (!TakesInput(contents->GetPrimaryMainFrame()) || (frame && !TakesInput(frame))) {
    return base::unexpected(Refusal("privileged", "Only web pages take input from programs, not Ardia's or the browser's own pages."));
  }
  if (!focused) {
    return Mouse(args, action, *target, held);
  }
  return action == "key" ? Key(args, *target) : Text(args, *target);
}

}
