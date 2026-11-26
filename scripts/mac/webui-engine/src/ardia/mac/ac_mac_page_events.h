#ifndef ARDIA_MAC_AC_MAC_PAGE_EVENTS_H_
#define ARDIA_MAC_AC_MAC_PAGE_EVENTS_H_

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "components/blocked_content/url_list_manager.h"
#include "components/zoom/zoom_observer.h"
#include "content/public/browser/media_player_id.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents_observer.h"
#include "url/gurl.h"

namespace blocked_content {
class PopupBlockerTabHelper;
}

namespace content {
class RenderWidgetHost;
}

namespace ardia_mac {

base::DictValue SecuritySnapshot(content::WebContents* contents);
std::optional<std::string> PageThemeColor(content::WebContents* contents);
base::DictValue PageEvent(std::string_view name, base::Value data);

class PageEvents : public content::WebContentsObserver,
                   public zoom::ZoomObserver,
                   public blocked_content::UrlListManager::Observer {
 public:
  using Report = base::RepeatingCallback<void(std::string_view, base::Value)>;

  PageEvents(content::WebContents* contents, Report report);
  PageEvents(const PageEvents&) = delete;
  PageEvents& operator=(const PageEvents&) = delete;
  ~PageEvents() override;

  void AppendSnapshot(base::ListValue& events);
  bool TargetURL(const GURL& url);
  bool Unresponsive(content::RenderWidgetHost* host,
                    base::RepeatingClosure restarter);
  bool Responsive(content::RenderWidgetHost* host);
  bool ResolveUnresponsive(bool terminate);
  bool OpenBlockedPopup(int32_t id, bool always);
  bool playing() const;
  void Reset();

 private:
  struct BlockedPopup {
    GURL url;
    std::string origin;
    content::WeakDocumentPtr document;
  };

  void DidUpdateFaviconURL(
      content::RenderFrameHost* frame,
      const std::vector<blink::mojom::FaviconURLPtr>& candidates,
      blink::mojom::FaviconUpdateReason reason) override;
  void OnAudioStateChanged(bool audible) override;
  void DidUpdateAudioMutingState(bool muted) override;
  void MediaStartedPlaying(const MediaPlayerInfo& info,
                           const content::MediaPlayerId& id) override;
  void MediaStoppedPlaying(const MediaPlayerInfo& info,
                           const content::MediaPlayerId& id,
                           MediaStoppedReason reason) override;
  void DidToggleFullscreenModeForTab(bool entered,
                                     bool will_cause_resize) override;
  void PrimaryMainFrameRenderProcessGone(base::TerminationStatus status) override;
  void DidFinishNavigation(content::NavigationHandle* handle) override;
  void DidFailLoad(content::RenderFrameHost* frame,
                   const GURL& url,
                   int error_code) override;
  void DidChangeVisibleSecurityState() override;
  void PrimaryPageChanged(content::Page& page) override;
  void OnPageScaleFactorChanged(float scale) override;
  void WasDiscarded() override;
  void WebContentsDestroyed() override;
  void OnZoomChanged(const zoom::ZoomController::ZoomChangedEventData& data) override;
  void OnZoomControllerDestroyed(zoom::ZoomController* controller) override;
  void BlockedUrlAdded(int32_t id, const GURL& url) override;

  bool CurrentDocument(const content::WeakDocumentPtr& document) const;
  bool Hung() const;
  void Send(std::string_view name, base::Value data);
  void SendMedia(bool audible, bool muted);
  std::optional<base::DictValue> ZoomSnapshot() const;
  base::DictValue FaviconEvent() const;
  base::DictValue CrashEvent(base::TerminationStatus status) const;
  blocked_content::PopupBlockerTabHelper* Popups() const;
  const BlockedPopup* RememberBlocked(int32_t id, const GURL& url);
  void StopObserving();

  Report report_;
  raw_ptr<zoom::ZoomController> zoom_ = nullptr;
  bool observing_popups_ = false;
  std::optional<double> pinch_scale_;
  std::optional<std::pair<bool, bool>> media_;
  std::set<content::MediaPlayerId> players_;
  std::map<int32_t, BlockedPopup> blocked_;
  std::string status_;
  content::WeakDocumentPtr status_document_;
  std::map<std::pair<int, int>, base::RepeatingClosure> hung_;
  base::WeakPtrFactory<PageEvents> weak_factory_{this};
};

}

#endif
