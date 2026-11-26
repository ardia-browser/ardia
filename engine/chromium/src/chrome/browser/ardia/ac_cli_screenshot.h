// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_SCREENSHOT_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_SCREENSHOT_H_

#include <cstddef>
#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "ui/gfx/geometry/rect_f.h"

namespace content {
class WebContents;
}

namespace ardia {

inline constexpr char kScreenshotTooBig[] =
    "the screenshot is too big to send; ask for jpeg, a lower quality, a clip "
    "or a smaller scale";

struct ScreenshotOptions {
  bool png = false;
  int quality = 80;
  std::optional<gfx::RectF> clip;
  bool clip_in_dips = false;
  double scale = 1.0;
  std::string owner;
  size_t max_encoded_bytes = 64 * 1024 * 1024;
};

using ScreenshotDone =
    base::OnceCallback<void(base::expected<base::DictValue, std::string>)>;

void CaptureTabScreenshot(content::WebContents* contents,
                          ScreenshotOptions options,
                          ScreenshotDone done);

bool TabDrawsOnScreen(content::WebContents* contents);

std::optional<ScreenshotOptions> ScreenshotOptionsFromCdp(
    const base::DictValue& params);

std::optional<ScreenshotOptions> ScreenshotOptionsFromArgs(
    const base::DictValue& args,
    std::string* error);

}

#endif
