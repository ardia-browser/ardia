#include "ardia/linux/ui_host/ui_navigation_throttle.h"

#include <memory>

#include "ardia/linux/log.h"
#include "ardia/linux/ui_host/ardia_app_source.h"
#include "ardia/linux/ui_host/ui_host_parts.h"
#include "base/strings/strcat.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/url_constants.h"
#include "url/gurl.h"
#include "url/url_constants.h"

namespace ardia_linux {

namespace {

bool IsBlankOrSrcdoc(const GURL& url) {
  return url.IsAboutBlank() || url.IsAboutSrcdoc();
}

bool IsArdiaApp(const GURL& url) {
  return url.SchemeIs(content::kChromeUIScheme) && url.host() == kArdiaAppHost;
}

}

bool UiDocumentMayCommit(UiDocument document,
                         bool main_frame,
                         const GURL& url) {
  if (!main_frame) {
    return IsBlankOrSrcdoc(url);
  }
  return document == UiDocument::kHost ? IsArdiaApp(url) : url.IsAboutBlank();
}

void UiNavigationThrottle::MaybeAdd(
    content::NavigationThrottleRegistry& registry) {
  content::WebContents* contents =
      registry.GetNavigationHandle().GetWebContents();
  if (IsUiHostContents(contents)) {
    registry.AddThrottle(
        std::make_unique<UiNavigationThrottle>(registry, UiDocument::kHost));
  } else if (IsAppWindowContents(contents)) {
    registry.AddThrottle(std::make_unique<UiNavigationThrottle>(
        registry, UiDocument::kAppWindow));
  }
}

UiNavigationThrottle::UiNavigationThrottle(
    content::NavigationThrottleRegistry& registry,
    UiDocument document)
    : content::NavigationThrottle(registry), document_(document) {}

UiNavigationThrottle::~UiNavigationThrottle() = default;

UiNavigationThrottle::ThrottleCheckResult UiNavigationThrottle::Check(
    const GURL& url) {
  const bool main_frame = navigation_handle()->IsInPrimaryMainFrame();
  if (navigation_handle()->IsSameDocument() ||
      UiDocumentMayCommit(document_, main_frame, url)) {
    return PROCEED;
  }
  Note("ui", base::StrCat({"refused a ", url.scheme(), " navigation in ",
                           document_ == UiDocument::kHost ? "the UI host"
                                                          : "an app window",
                           main_frame ? "" : "'s frame"}));
  return CANCEL;
}

UiNavigationThrottle::ThrottleCheckResult
UiNavigationThrottle::WillStartRequest() {
  return Check(navigation_handle()->GetURL());
}

UiNavigationThrottle::ThrottleCheckResult
UiNavigationThrottle::WillRedirectRequest() {
  return Check(navigation_handle()->GetURL());
}

UiNavigationThrottle::ThrottleCheckResult
UiNavigationThrottle::WillCommitWithoutUrlLoader() {
  return Check(navigation_handle()->GetURL());
}

const char* UiNavigationThrottle::GetNameForLogging() {
  return "ArdiaUiNavigationThrottle";
}

}
