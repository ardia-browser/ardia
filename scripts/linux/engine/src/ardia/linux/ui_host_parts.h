// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_UI_HOST_PARTS_H_
#define ARDIA_LINUX_UI_HOST_PARTS_H_

#include <string>

class GURL;

namespace blink {
class AssociatedInterfaceRegistry;
}

namespace content {
class NavigationThrottleRegistry;
class RenderFrameHost;
class WebContents;
}

namespace ardia_linux {

void StartUiHost();

void StopUiHost();

content::WebContents* UiHostContents();

void RegisterUiHostBinders(content::RenderFrameHost& frame,
                           blink::AssociatedInterfaceRegistry& registry);

void AddUiHostThrottles(content::NavigationThrottleRegistry& registry);

bool UiHostOpensAppWindow(content::RenderFrameHost* opener,
                          const GURL& target_url,
                          const std::string& frame_name);

}

#endif
