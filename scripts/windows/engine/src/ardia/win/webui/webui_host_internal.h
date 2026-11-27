#ifndef ARDIA_WIN_WEBUI_WEBUI_HOST_INTERNAL_H_
#define ARDIA_WIN_WEBUI_WEBUI_HOST_INTERNAL_H_

#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "ardia/win/webui/webui_window_policy.h"
#include "base/values.h"
#include "ui/gfx/geometry/rect.h"
#include "url/gurl.h"

namespace content {
class BrowserContext;
class WebContents;
}

namespace views {
class WebView;
}

namespace ardia_win::webui {

using webui_window::kAppProfileName;

std::string Text(const base::DictValue& value, std::string_view key);

const base::ListValue* Arguments(const base::DictValue& value);

int TabId(const content::WebContents* contents);

base::Value Failure(std::string_view code, std::string_view message);

std::optional<gfx::Rect> RectFrom(const base::DictValue* rect);

void SubtractFromRegion(std::vector<gfx::Rect>& region, const gfx::Rect& cut);

std::optional<GURL> AllowedPageUrl(const std::string& requested);

std::unique_ptr<views::WebView> MakeViewport(content::BrowserContext* profile);

std::span<const std::string_view> HostCapabilities(bool utility);

}

#endif
