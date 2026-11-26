#ifndef ARDIA_MAC_AC_MAC_LINK_GESTURE_H_
#define ARDIA_MAC_AC_MAC_LINK_GESTURE_H_

#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <string_view>

#include "ardia/mac/ac_mac_link_policy.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_observer.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

namespace content {
class NavigationHandle;
class NavigationThrottleRegistry;
struct OpenURLParams;
}

namespace ardia_mac {

class PageBinding;

class PageLinks : public content::WebContentsObserver,
                  public content::RenderWidgetHost::InputEventObserver,
                  public content::RenderWidgetHostObserver {
 public:
  PageLinks(PageBinding* binding, content::WebContents* contents);
  PageLinks(const PageLinks&) = delete;
  PageLinks& operator=(const PageLinks&) = delete;
  ~PageLinks() override;

  std::uintptr_t surface() const;
  void NoteTarget(const GURL& url);
  bool PeeksInsteadOf(content::NavigationHandle& handle);
  bool OpensInPlace(const GURL& url, WindowOpenDisposition disposition, bool form_submission, bool user_gesture);

 private:
  void Watch(content::RenderWidgetHost* widget);
  void Unwatch();
  void RenderFrameCreated(content::RenderFrameHost* frame) override;
  void RenderFrameHostChanged(content::RenderFrameHost* old_host,
                              content::RenderFrameHost* new_host) override;
  void PrimaryPageChanged(content::Page& page) override;
  void DidFinishNavigation(content::NavigationHandle* handle) override;
  void WebContentsDestroyed() override;
  void OnInputEvent(const content::RenderWidgetHost& widget,
                    const blink::WebInputEvent& event,
                    input::InputEventSource source) override;
  void RenderWidgetHostDestroyed(content::RenderWidgetHost* widget) override;

  raw_ptr<PageBinding> binding_;
  std::uintptr_t surface_ = 0;
  std::set<content::RenderWidgetHost*> widgets_;
  std::string target_;
  int64_t peek_navigation_ = 0;
  GURL peek_url_;
  std::optional<link_policy::Point> peek_point_;
  base::WeakPtrFactory<PageLinks> weak_factory_{this};
};

bool HandlesLinkRoute(std::string_view name);
void LinkRouteCall(std::string_view name,
                   const base::Value* args,
                   base::OnceCallback<void(bool, base::Value)> done);
void AppendLinkCapabilities(base::ListValue& capabilities);
void NoteLinkTarget(content::WebContents* source, const GURL& url);
bool InterceptLinkOpen(content::WebContents* source, const content::OpenURLParams& params);
WindowOpenDisposition OpeningDisposition(content::WebContents* source, const content::OpenURLParams& params);
WindowOpenDisposition PopupDisposition(content::WebContents* source,
                                       WindowOpenDisposition disposition);
void InstallLinkHooks();

}

#endif
