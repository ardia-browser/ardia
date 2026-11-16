#include "ardia/core/ac_app_urls.h"

#import <Foundation/Foundation.h>

#include <memory>
#include <optional>

#include "base/functional/bind.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "ardia/core/ac_browser.h"
#include "chrome/browser/ardia/ac_web3.h"
#import "ardia/core/ardiacore_internal.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardiacore {

namespace {

bool IsAppURL(const GURL& url) {
  return url.SchemeIs("ardia");
}

bool IsWebUIURL(const GURL& url) {
  return url.SchemeIs("chrome") || url.SchemeIs("devtools");
}

bool IsWeb3SettingsRequest(content::NavigationHandle* navigation,
                           const std::optional<url::Origin>& initiator) {
  return ardia::IsWeb3SettingsURL(navigation->GetURL()) &&
         navigation->HasUserGesture() && initiator &&
         initiator->GetTupleOrPrecursorTupleIfOpaque().scheme() ==
             ardia::kWeb3Scheme &&
         navigation->GetWebContents()
             ->GetPrimaryMainFrame()
             ->GetLastCommittedURL()
             .SchemeIs(ardia::kWeb3Scheme);
}

void ReportAppURLRequest(content::WebContents* contents,
                         const GURL& url,
                         bool user_gesture) {
  ArdiaCoreTab* tab = TabBridge::GetOrCreate(contents)->tab();
  id<ArdiaCoreTabDelegate> delegate = tab.delegate;
  if ([delegate respondsToSelector:@selector(tab:didRequestAppURL:userGesture:)]) {
    [delegate tab:tab
        didRequestAppURL:base::SysUTF8ToNSString(url.spec())
             userGesture:user_gesture];
  }
}

class AppSchemeThrottle : public content::NavigationThrottle {
 public:
  explicit AppSchemeThrottle(content::NavigationThrottleRegistry& registry)
      : content::NavigationThrottle(registry) {}

  ThrottleCheckResult WillStartRequest() override { return Check(); }
  ThrottleCheckResult WillRedirectRequest() override { return Check(); }
  const char* GetNameForLogging() override { return "ACAppSchemeThrottle"; }

 private:
  ThrottleCheckResult Check() {
    content::NavigationHandle* navigation = navigation_handle();
    if (!IsAppURL(navigation->GetURL())) {
      return PROCEED;
    }
    content::WebContents* contents = navigation->GetWebContents();
    const std::optional<url::Origin>& initiator =
        navigation->GetInitiatorOrigin();
    content::NavigationEntry* committed =
        contents->GetController().GetLastCommittedEntry();
    const bool popup_start = !committed || committed->IsInitialEntry();
    const bool from_webui =
        initiator && IsWebUIURL(initiator->GetURL()) &&
        IsWebUIURL(contents->GetPrimaryMainFrame()->GetLastCommittedURL());
    if (navigation->IsInPrimaryMainFrame() && !popup_start &&
        !navigation->WasServerRedirect() &&
        (from_webui || IsWeb3SettingsRequest(navigation, initiator))) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(
                         [](base::WeakPtr<content::WebContents> contents, GURL url,
                            bool user_gesture) {
                           if (contents) {
                             ReportAppURLRequest(contents.get(), url, user_gesture);
                           }
                         },
                         contents->GetWeakPtr(), navigation->GetURL(),
                         navigation->HasUserGesture()));
    }
    return CANCEL_AND_IGNORE;
  }
};

}

void AddAppSchemeThrottle(content::NavigationThrottleRegistry& registry) {
  registry.AddThrottle(std::make_unique<AppSchemeThrottle>(registry));
}

bool InterceptAppURL(content::WebContents* source,
                     const GURL& url,
                     bool user_gesture) {
  if (!IsAppURL(url)) {
    return false;
  }
  if (source && IsWebUIURL(source->GetLastCommittedURL())) {
    ReportAppURLRequest(source, url, user_gesture);
  }
  return true;
}

}
