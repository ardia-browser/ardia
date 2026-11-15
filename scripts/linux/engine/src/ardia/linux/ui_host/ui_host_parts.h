#ifndef ARDIA_LINUX_UI_HOST_UI_HOST_PARTS_H_
#define ARDIA_LINUX_UI_HOST_UI_HOST_PARTS_H_

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

void ReloadUiHost();

content::WebContents* UiHostContents();

bool IsUiHostDocument(content::RenderFrameHost* frame);

bool IsUiHostContents(const content::WebContents* contents);

bool IsAppWindowContents(const content::WebContents* contents);

void RegisterUiHostBinders(content::RenderFrameHost& frame,
                           blink::AssociatedInterfaceRegistry& registry);

void AddUiHostThrottles(content::NavigationThrottleRegistry& registry);

bool UiHostOpensAppWindow(content::RenderFrameHost* opener,
                          const GURL& target_url,
                          const std::string& frame_name);

}

#endif
