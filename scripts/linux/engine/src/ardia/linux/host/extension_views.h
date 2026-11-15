// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_HOST_EXTENSION_VIEWS_H_
#define ARDIA_LINUX_HOST_EXTENSION_VIEWS_H_

#include <optional>
#include <string>
#include <string_view>

#include "chrome/browser/ui/extensions/extension_popup_types.h"

class Browser;
class BrowserWindowInterface;
class GURL;

namespace content {
class WebContents;
}

namespace gfx {
class Size;
}

namespace ardia_linux {

enum class ExtensionViewKind { kPopup, kSidePanel };

std::optional<ExtensionViewKind> ExtensionViewKindNamed(std::string_view name);

content::WebContents* OpenExtensionView(Browser* browser,
                                        const GURL& url,
                                        ExtensionViewKind kind);

bool IsExtensionView(content::WebContents* contents);

bool CloseExtensionView(content::WebContents* contents);

void CloseAllExtensionViews();

gfx::Size ExtensionPopupPreferredSize(content::WebContents* contents);

void ExpectActionPopup(BrowserWindowInterface* browser,
                       std::string extension_id,
                       ShowPopupCallback callback);

}

#endif
