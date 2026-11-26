// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_CORE_AC_TAB_INPUT_INTERNAL_H_
#define ARDIA_CORE_AC_TAB_INPUT_INTERNAL_H_

#include <optional>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "components/input/native_web_keyboard_event.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "third_party/blink/public/common/input/web_mouse_wheel_event.h"
#include "ui/gfx/geometry/rect.h"

namespace content {
class RenderWidgetHost;
class WebContents;
}

namespace ardiacore::tab_input_internal {

struct Target {
  raw_ptr<content::RenderWidgetHost> widget;
  gfx::Rect bounds;
  double zoom = 1;
};

struct Prepared {
  bool focused_frame = false;
  Target target;
  std::vector<blink::WebMouseEvent> mice;
  std::optional<blink::WebMouseWheelEvent> wheel;
  std::vector<input::NativeWebKeyboardEvent> keys;
  std::u16string text;
  std::optional<blink::WebInputEvent::Type> awaited;
  base::TimeTicks stamp;
  int transition = 0;
  bool pressing = false;
};

using Built = base::expected<Prepared, base::DictValue>;

base::DictValue Refusal(const char* code, const char* reason);

base::TimeTicks NextStamp();

std::optional<Target> TargetOf(content::WebContents* contents, bool focused_frame);

base::DictValue Viewport(const Target& target);

Built Build(content::WebContents* contents, const base::DictValue& args, const std::string& action, int held);

}

#endif
