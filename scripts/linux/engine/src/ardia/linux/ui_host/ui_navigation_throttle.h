#ifndef ARDIA_LINUX_UI_HOST_UI_NAVIGATION_THROTTLE_H_
#define ARDIA_LINUX_UI_HOST_UI_NAVIGATION_THROTTLE_H_

#include "content/public/browser/navigation_throttle.h"

class GURL;

namespace ardia_linux {

enum class UiDocument { kHost, kAppWindow };

bool UiDocumentMayCommit(UiDocument document,
                         bool main_frame,
                         const GURL& url);

class UiNavigationThrottle : public content::NavigationThrottle {
 public:
  static void MaybeAdd(content::NavigationThrottleRegistry& registry);

  UiNavigationThrottle(content::NavigationThrottleRegistry& registry,
                       UiDocument document);
  ~UiNavigationThrottle() override;

  ThrottleCheckResult WillStartRequest() override;
  ThrottleCheckResult WillRedirectRequest() override;
  ThrottleCheckResult WillCommitWithoutUrlLoader() override;
  const char* GetNameForLogging() override;

 private:
  ThrottleCheckResult Check(const GURL& url);

  const UiDocument document_;
};

}

#endif
