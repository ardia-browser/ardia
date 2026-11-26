#include "ardia/mac/ac_mac_page_events.h"

#include <utility>
#include <vector>

#include "ardia/mac/ac_mac_page_policy.h"
#include "base/process/kill.h"
#include "base/strings/string_number_conversions.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "components/blocked_content/popup_blocker_tab_helper.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/security_state/content/content_utils.h"
#include "components/security_state/core/security_state.h"
#include "components/zoom/zoom_controller.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/result_codes.h"
#include "net/base/net_errors.h"
#include "services/media_session/public/mojom/media_session.mojom.h"
#include "net/cert/cert_status_flags.h"
#include "net/cert/x509_certificate.h"
#include "net/ssl/ssl_connection_status_flags.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "third_party/blink/public/mojom/favicon/favicon_url.mojom.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/window_open_disposition.h"
#include "url/origin.h"

namespace ardia_mac {

namespace {

base::DictValue Principal(const net::CertPrincipal& principal) {
  base::ListValue organizations;
  for (const std::string& organization : principal.organization_names) {
    organizations.Append(organization);
  }
  return base::DictValue()
      .Set("commonName", principal.common_name)
      .Set("displayName", principal.GetDisplayName())
      .Set("organizations", std::move(organizations))
      .Set("country", principal.country_name);
}

base::DictValue Certificate(const net::X509Certificate& certificate) {
  base::DictValue result =
      base::DictValue()
          .Set("subject", Principal(certificate.subject()))
          .Set("issuer", Principal(certificate.issuer()))
          .Set("validFrom",
               certificate.valid_start().InMillisecondsFSinceUnixEpoch())
          .Set("validUntil",
               certificate.valid_expiry().InMillisecondsFSinceUnixEpoch())
          .Set("chainLength",
               static_cast<int>(certificate.intermediate_buffers().size() + 1));
  if (!certificate.serial_number().empty()) {
    result.Set("serialNumber", base::HexEncode(certificate.serial_number()));
  }
  result.Set("sha256", base::HexEncode(net::X509Certificate::CalculateFingerprint256(
                           certificate.cert_buffer())));
  return result;
}

base::ListValue CertificateErrors(net::CertStatus status) {
  constexpr std::pair<net::CertStatus, const char*> kNames[] = {
      {net::CERT_STATUS_COMMON_NAME_INVALID, "nameMismatch"},
      {net::CERT_STATUS_DATE_INVALID, "dateInvalid"},
      {net::CERT_STATUS_AUTHORITY_INVALID, "authorityInvalid"},
      {net::CERT_STATUS_REVOKED, "revoked"},
      {net::CERT_STATUS_INVALID, "invalid"},
      {net::CERT_STATUS_WEAK_SIGNATURE_ALGORITHM, "weakSignature"},
      {net::CERT_STATUS_NON_UNIQUE_NAME, "nonUniqueName"},
      {net::CERT_STATUS_WEAK_KEY, "weakKey"},
      {net::CERT_STATUS_PINNED_KEY_MISSING, "pinnedKeyMissing"},
      {net::CERT_STATUS_NAME_CONSTRAINT_VIOLATION, "nameConstraint"},
      {net::CERT_STATUS_VALIDITY_TOO_LONG, "validityTooLong"},
      {net::CERT_STATUS_CERTIFICATE_TRANSPARENCY_REQUIRED,
       "certificateTransparency"},
  };
  base::ListValue result;
  for (const auto& [flag, name] : kNames) {
    if (status & flag) {
      result.Append(name);
    }
  }
  return result;
}

std::string Protocol(int status) {
  switch (net::SSLConnectionStatusToVersion(status)) {
    case net::SSL_CONNECTION_VERSION_TLS1:
      return "TLS 1.0";
    case net::SSL_CONNECTION_VERSION_TLS1_1:
      return "TLS 1.1";
    case net::SSL_CONNECTION_VERSION_TLS1_2:
      return "TLS 1.2";
    case net::SSL_CONNECTION_VERSION_TLS1_3:
      return "TLS 1.3";
    case net::SSL_CONNECTION_VERSION_QUIC:
      return "QUIC";
    default:
      return std::string();
  }
}

page_policy::Termination TerminationFor(base::TerminationStatus status) {
  switch (status) {
    case base::TERMINATION_STATUS_NORMAL_TERMINATION:
      return page_policy::Termination::kNormal;
    case base::TERMINATION_STATUS_ABNORMAL_TERMINATION:
      return page_policy::Termination::kAbnormal;
    case base::TERMINATION_STATUS_PROCESS_WAS_KILLED:
      return page_policy::Termination::kKilled;
    case base::TERMINATION_STATUS_PROCESS_CRASHED:
      return page_policy::Termination::kCrashed;
    case base::TERMINATION_STATUS_STILL_RUNNING:
      return page_policy::Termination::kStillRunning;
    case base::TERMINATION_STATUS_OOM:
      return page_policy::Termination::kOom;
    case base::TERMINATION_STATUS_LAUNCH_FAILED:
      return page_policy::Termination::kLaunchFailed;
    default:
      return page_policy::Termination::kOther;
  }
}

std::optional<std::pair<int, int>> WidgetId(content::RenderWidgetHost* host) {
  if (!host || !host->GetProcess()) {
    return std::nullopt;
  }
  return std::make_pair(host->GetProcess()->GetDeprecatedID(),
                        host->GetRoutingID());
}

}

base::DictValue PageEvent(std::string_view name, base::Value data) {
  return base::DictValue().Set("name", name).Set("data", std::move(data));
}

base::DictValue SecuritySnapshot(content::WebContents* contents) {
  content::NavigationEntry* entry =
      contents ? contents->GetController().GetLastCommittedEntry() : nullptr;
  const GURL url = entry ? entry->GetURL() : GURL();
  base::DictValue result = base::DictValue()
                               .Set("level", "none")
                               .Set("url", url.spec())
                               .Set("origin", base::Value());
  if (!entry || entry->IsInitialEntry() || !url.is_valid()) {
    return result;
  }
  if (url.SchemeIsHTTPOrHTTPS()) {
    result.Set("origin", url::Origin::Create(url).Serialize());
  }
  if (url.SchemeIs("http")) {
    result.Set("level", "insecure");
    return result;
  }
  if (url.SchemeIs("file") || url.SchemeIs("chrome") ||
      url.SchemeIs("chrome-untrusted") || url.SchemeIs("devtools")) {
    result.Set("level", "local");
    return result;
  }
  if (!url.SchemeIs("https") ||
      contents->GetController().GetVisibleEntry() != entry) {
    return result;
  }
  std::unique_ptr<security_state::VisibleSecurityState> state =
      security_state::GetVisibleSecurityState(contents);
  if (!state || !state->connection_info_initialized) {
    return result;
  }
  constexpr net::CertStatus kMask =
      net::CERT_STATUS_ALL_ERRORS &
      ~(net::CERT_STATUS_NO_REVOCATION_MECHANISM |
        net::CERT_STATUS_UNABLE_TO_CHECK_REVOCATION);
  const net::CertStatus errors = state->cert_status & kMask;
  const bool ran =
      state->ran_mixed_content || state->ran_content_with_cert_errors;
  const bool displayed = state->displayed_mixed_content ||
                         state->displayed_content_with_cert_errors ||
                         state->contained_mixed_form;
  const char* level = errors               ? "certificateError"
                      : ran || displayed   ? "mixed"
                      : state->certificate && !state->is_error_page ? "secure"
                                                                    : "none";
  result.Set("level", level);
  result.Set("certificateErrors", CertificateErrors(errors));
  result.Set("mixedContent", ran         ? base::Value("ran")
                             : displayed ? base::Value("displayed")
                                         : base::Value());
  result.Set("isEV", (state->cert_status & net::CERT_STATUS_IS_EV) != 0);
  std::string protocol = Protocol(state->connection_status);
  if (!protocol.empty()) {
    result.Set("protocol", std::move(protocol));
  }
  if (state->certificate) {
    result.Set("certificate", Certificate(*state->certificate));
  }
  return result;
}

std::optional<std::string> PageThemeColor(content::WebContents* contents) {
  const std::optional<SkColor> color =
      contents ? contents->GetThemeColor() : std::nullopt;
  if (!color) {
    return std::nullopt;
  }
  return page_policy::ThemeColorText(
      static_cast<uint8_t>(SkColorGetR(*color)),
      static_cast<uint8_t>(SkColorGetG(*color)),
      static_cast<uint8_t>(SkColorGetB(*color)));
}

PageEvents::PageEvents(content::WebContents* contents, Report report)
    : content::WebContentsObserver(contents), report_(std::move(report)) {
  zoom_ = zoom::ZoomController::FromWebContents(contents);
  if (zoom_) {
    zoom_->AddObserver(this);
  }
  if (blocked_content::PopupBlockerTabHelper* popups = Popups()) {
    popups->manager()->AddObserver(this);
    observing_popups_ = true;
    for (const auto& [id, url] : popups->GetBlockedPopupRequests()) {
      RememberBlocked(id, url);
    }
  }
  media_ = std::make_pair(contents->IsCurrentlyAudible(),
                          contents->IsAudioMuted());
}

bool PageEvents::playing() const {
  content::WebContents* contents = web_contents();
  if (!contents) {
    return false;
  }
  if (!players_.empty() || contents->GetCurrentlyPlayingVideoCount() > 0) {
    return true;
  }
  content::MediaSession* session = content::MediaSession::GetIfExists(contents);
  media_session::mojom::MediaSessionInfoPtr info =
      session ? session->GetMediaSessionInfoSync() : nullptr;
  return info &&
         page_policy::SessionPlaying(
             info->state != media_session::mojom::MediaSessionInfo::SessionState::kInactive,
             info->playback_state == media_session::mojom::MediaPlaybackState::kPlaying);
}

PageEvents::~PageEvents() {
  Reset();
}

void PageEvents::Reset() {
  weak_factory_.InvalidateWeakPtrs();
  StopObserving();
  blocked_.clear();
  status_.clear();
  status_document_ = content::WeakDocumentPtr();
  hung_.clear();
  players_.clear();
  report_.Reset();
  Observe(nullptr);
}

void PageEvents::StopObserving() {
  if (observing_popups_) {
    observing_popups_ = false;
    if (blocked_content::PopupBlockerTabHelper* popups = Popups()) {
      popups->manager()->RemoveObserver(this);
    }
  }
  if (zoom_) {
    std::exchange(zoom_, nullptr)->RemoveObserver(this);
  }
}

void PageEvents::Send(std::string_view name, base::Value data) {
  if (report_ && web_contents()) {
    report_.Run(name, std::move(data));
  }
}

blocked_content::PopupBlockerTabHelper* PageEvents::Popups() const {
  return web_contents() ? blocked_content::PopupBlockerTabHelper::FromWebContents(
                              web_contents())
                        : nullptr;
}

bool PageEvents::CurrentDocument(
    const content::WeakDocumentPtr& document) const {
  content::RenderFrameHost* frame = document.AsRenderFrameHostIfValid();
  return web_contents() && frame && frame == web_contents()->GetPrimaryMainFrame();
}

bool PageEvents::Hung() const {
  for (const auto& [id, restarter] : hung_) {
    content::RenderWidgetHost* host =
        content::RenderWidgetHost::FromID(id.first, id.second);
    if (host && host->IsCurrentlyUnresponsive()) {
      return true;
    }
  }
  return false;
}

std::optional<base::DictValue> PageEvents::ZoomSnapshot() const {
  content::WebContents* contents = web_contents();
  if (!contents || !zoom_) {
    return std::nullopt;
  }
  const double factor = blink::ZoomLevelToZoomFactor(zoom_->GetZoomLevel());
  const std::optional<double> scale =
      zoom_->PageScaleFactorIsOne() ? std::optional<double>(1) : pinch_scale_;
  if (!scale || !std::isfinite(*scale) || *scale <= 0 || !std::isfinite(factor) ||
      factor <= 0) {
    return std::nullopt;
  }
  return base::DictValue()
      .Set("zoom", factor)
      .Set("host", contents->GetLastCommittedURL().host())
      .Set("isDefault", zoom_->IsAtDefaultZoom())
      .Set("pinchScale", *scale);
}

base::DictValue PageEvents::FaviconEvent() const {
  base::ListValue urls;
  std::string first;
  if (content::WebContents* contents = web_contents()) {
    for (const auto& candidate : contents->GetFaviconURLs()) {
      if (urls.size() >= page_policy::kFaviconCandidatesMax) {
        break;
      }
      if (first.empty()) {
        first = candidate->icon_url.spec();
      }
      urls.Append(candidate->icon_url.spec());
    }
  }
  return base::DictValue().Set("url", first).Set("urls", std::move(urls));
}

base::DictValue PageEvents::CrashEvent(base::TerminationStatus status) const {
  const int code = web_contents() ? web_contents()->GetCrashedErrorCode() : 0;
  return base::DictValue()
      .Set("status", code)
      .Set("reason", page_policy::CrashReason(TerminationFor(status)))
      .Set("code", code);
}

void PageEvents::AppendSnapshot(base::ListValue& events) {
  content::WebContents* contents = web_contents();
  if (!contents) {
    return;
  }
  events.Append(PageEvent("security", base::Value(SecuritySnapshot(contents))));
  if (std::optional<base::DictValue> zoom = ZoomSnapshot()) {
    events.Append(PageEvent("zoom", base::Value(std::move(*zoom))));
  }
  if (!contents->GetFaviconURLs().empty()) {
    events.Append(PageEvent("favicon", base::Value(FaviconEvent())));
  }
  events.Append(PageEvent(
      "fullscreen",
      base::Value(base::DictValue().Set("fullscreen", contents->IsFullscreen()))));
  events.Append(PageEvent(
      "status", base::Value(base::DictValue().Set(
                    "text", CurrentDocument(status_document_) ? status_
                                                              : std::string()))));
  if (contents->IsCrashed() &&
      page_policy::RendererGone(TerminationFor(contents->GetCrashedStatus()))) {
    events.Append(
        PageEvent("crashed", base::Value(CrashEvent(contents->GetCrashedStatus()))));
  }
  events.Append(PageEvent(Hung() ? "unresponsive" : "responsive",
                          base::Value(base::DictValue())));
  blocked_content::PopupBlockerTabHelper* popups = Popups();
  const auto requests = popups ? popups->GetBlockedPopupRequests()
                               : blocked_content::PopupBlockerTabHelper::PopupIdMap();
  for (auto it = blocked_.begin(); it != blocked_.end();) {
    if (!CurrentDocument(it->second.document) || !requests.contains(it->first)) {
      it = blocked_.erase(it);
      continue;
    }
    if (events.size() + 2 >= page_policy::kSnapshotEventsMax) {
      ++it;
      continue;
    }
    events.Append(PageEvent(
        "popupBlocked", base::Value(base::DictValue()
                                        .Set("id", base::NumberToString(it->first))
                                        .Set("url", it->second.url.spec())
                                        .Set("origin", it->second.origin))));
    ++it;
  }
  events.Append(PageEvent(
      "media", base::Value(base::DictValue()
                               .Set("playing", contents->IsCurrentlyAudible())
                               .Set("muted", contents->IsAudioMuted()))));
  if (contents->WasDiscarded()) {
    events.Append(PageEvent(
        "discarded",
        base::Value(base::DictValue().Set("url", contents->GetVisibleURL().spec()))));
  }
}

bool PageEvents::TargetURL(const GURL& url) {
  content::WebContents* contents = web_contents();
  if (!contents || !contents->GetPrimaryMainFrame()) {
    return false;
  }
  std::string text = url.is_valid() ? url.spec() : std::string();
  if (text == status_ && CurrentDocument(status_document_)) {
    return true;
  }
  status_ = text;
  status_document_ = contents->GetPrimaryMainFrame()->GetWeakDocumentPtr();
  Send("status", base::Value(base::DictValue().Set("text", std::move(text))));
  return true;
}

bool PageEvents::Unresponsive(content::RenderWidgetHost* host,
                              base::RepeatingClosure restarter) {
  const std::optional<std::pair<int, int>> id = WidgetId(host);
  if (!id || !web_contents() ||
      (!hung_.contains(*id) && hung_.size() >= page_policy::kHungWidgetsMax)) {
    return false;
  }
  hung_[*id] = std::move(restarter);
  Send("unresponsive", base::Value(base::DictValue()));
  return true;
}

bool PageEvents::Responsive(content::RenderWidgetHost* host) {
  const std::optional<std::pair<int, int>> id = WidgetId(host);
  if (!id || !hung_.erase(*id)) {
    return false;
  }
  if (hung_.empty()) {
    Send("responsive", base::Value(base::DictValue()));
  }
  return true;
}

bool PageEvents::ResolveUnresponsive(bool terminate) {
  if (!web_contents()) {
    return false;
  }
  std::map<std::pair<int, int>, base::RepeatingClosure> hung = std::move(hung_);
  hung_.clear();
  for (auto& [id, restarter] : hung) {
    if (!terminate) {
      if (restarter) {
        restarter.Run();
      }
      continue;
    }
    content::RenderWidgetHost* host =
        content::RenderWidgetHost::FromID(id.first, id.second);
    if (host && host->GetProcess() &&
        host->GetProcess()->IsInitializedAndNotDead()) {
      host->GetProcess()->Shutdown(content::RESULT_CODE_HUNG);
    }
  }
  return true;
}

bool PageEvents::OpenBlockedPopup(int32_t id, bool always) {
  content::WebContents* contents = web_contents();
  blocked_content::PopupBlockerTabHelper* popups = Popups();
  const auto found = blocked_.find(id);
  if (!contents || !popups || found == blocked_.end() ||
      !CurrentDocument(found->second.document) ||
      !popups->GetBlockedPopupRequests().contains(id)) {
    return false;
  }
  blocked_.erase(found);
  if (always) {
    if (HostContentSettingsMap* settings =
            HostContentSettingsMapFactory::GetForProfile(
                contents->GetBrowserContext())) {
      settings->SetContentSettingDefaultScope(contents->GetLastCommittedURL(),
                                              GURL(), ContentSettingsType::POPUPS,
                                              CONTENT_SETTING_ALLOW);
    }
  }
  popups->ShowBlockedPopup(id, WindowOpenDisposition::kNewForegroundTab);
  return true;
}

const PageEvents::BlockedPopup* PageEvents::RememberBlocked(int32_t id,
                                                            const GURL& url) {
  content::WebContents* contents = web_contents();
  if (!contents || !contents->GetPrimaryMainFrame() ||
      (!blocked_.contains(id) && blocked_.size() >= page_policy::kBlockedPopupsMax)) {
    return nullptr;
  }
  const GURL& committed = contents->GetLastCommittedURL();
  std::string origin = committed.SchemeIsHTTPOrHTTPS()
                           ? url::Origin::Create(committed).Serialize()
                           : std::string();
  return &(blocked_[id] = BlockedPopup{
               url, std::move(origin),
               contents->GetPrimaryMainFrame()->GetWeakDocumentPtr()});
}

void PageEvents::BlockedUrlAdded(int32_t id, const GURL& url) {
  const BlockedPopup* blocked = RememberBlocked(id, url);
  if (!blocked) {
    return;
  }
  Send("popupBlocked", base::Value(base::DictValue()
                                       .Set("id", base::NumberToString(id))
                                       .Set("url", url.spec())
                                       .Set("origin", blocked->origin)));
}

void PageEvents::DidUpdateFaviconURL(
    content::RenderFrameHost* frame,
    const std::vector<blink::mojom::FaviconURLPtr>& candidates,
    blink::mojom::FaviconUpdateReason reason) {
  if (!web_contents() || frame != web_contents()->GetPrimaryMainFrame()) {
    return;
  }
  base::ListValue urls;
  for (const auto& candidate : candidates) {
    if (urls.size() >= page_policy::kFaviconCandidatesMax) {
      break;
    }
    urls.Append(candidate->icon_url.spec());
  }
  Send("favicon",
       base::Value(base::DictValue()
                       .Set("url", candidates.empty()
                                       ? std::string()
                                       : candidates.front()->icon_url.spec())
                       .Set("urls", std::move(urls))));
}

void PageEvents::SendMedia(bool audible, bool muted) {
  if (media_ && media_->first == audible && media_->second == muted) {
    return;
  }
  media_ = std::make_pair(audible, muted);
  Send("media",
       base::Value(base::DictValue().Set("playing", audible).Set("muted", muted)));
}

void PageEvents::OnAudioStateChanged(bool audible) {
  if (web_contents()) {
    SendMedia(audible, web_contents()->IsAudioMuted());
  }
}

void PageEvents::DidUpdateAudioMutingState(bool muted) {
  if (web_contents()) {
    SendMedia(web_contents()->IsCurrentlyAudible(), muted);
  }
}

void PageEvents::MediaStartedPlaying(const MediaPlayerInfo& info,
                                     const content::MediaPlayerId& id) {
  players_.insert(id);
}

void PageEvents::MediaStoppedPlaying(const MediaPlayerInfo& info,
                                     const content::MediaPlayerId& id,
                                     MediaStoppedReason reason) {
  players_.erase(id);
}

void PageEvents::DidToggleFullscreenModeForTab(bool entered,
                                               bool will_cause_resize) {
  Send("fullscreen",
       base::Value(base::DictValue().Set("fullscreen", entered)));
}

void PageEvents::PrimaryMainFrameRenderProcessGone(
    base::TerminationStatus status) {
  status_.clear();
  status_document_ = content::WeakDocumentPtr();
  hung_.clear();
  players_.clear();
  if (!page_policy::RendererGone(TerminationFor(status))) {
    return;
  }
  Send("crashed", base::Value(CrashEvent(status)));
}

void PageEvents::DidFinishNavigation(content::NavigationHandle* handle) {
  if (page_policy::ClearsBlockedPopups(handle->IsInPrimaryMainFrame(),
                                       handle->HasCommitted(),
                                       handle->IsSameDocument())) {
    blocked_.clear();
  }
  if (!handle->IsInPrimaryMainFrame()) {
    return;
  }
  const int error = handle->GetNetErrorCode();
  if (page_policy::NavigationLoadError(error) && !handle->IsSameDocument()) {
    Send("loadError", base::Value(base::DictValue()
                                      .Set("url", handle->GetURL().spec())
                                      .Set("code", error)
                                      .Set("text", net::ErrorToShortString(error))));
  }
  if (handle->HasCommitted() && !handle->IsSameDocument()) {
    Send("security", base::Value(SecuritySnapshot(web_contents())));
  }
  if (std::optional<base::DictValue> zoom = ZoomSnapshot()) {
    Send("zoom", base::Value(std::move(*zoom)));
  }
}

void PageEvents::DidFailLoad(content::RenderFrameHost* frame,
                             const GURL& url,
                             int error_code) {
  if (!web_contents() || frame != web_contents()->GetPrimaryMainFrame()) {
    return;
  }
  Send("loadError", base::Value(base::DictValue()
                                    .Set("url", url.spec())
                                    .Set("code", error_code)
                                    .Set("text", net::ErrorToShortString(error_code))));
}

void PageEvents::DidChangeVisibleSecurityState() {
  Send("security", base::Value(SecuritySnapshot(web_contents())));
}

void PageEvents::PrimaryPageChanged(content::Page& page) {
  pinch_scale_.reset();
}

void PageEvents::OnPageScaleFactorChanged(float scale) {
  pinch_scale_ = std::isfinite(scale) && scale > 0
                     ? std::optional<double>(scale)
                     : std::nullopt;
  if (std::optional<base::DictValue> zoom = ZoomSnapshot()) {
    Send("zoom", base::Value(std::move(*zoom)));
  }
}

void PageEvents::OnZoomChanged(
    const zoom::ZoomController::ZoomChangedEventData& data) {
  if (std::optional<base::DictValue> zoom = ZoomSnapshot()) {
    Send("zoom", base::Value(std::move(*zoom)));
  }
}

void PageEvents::OnZoomControllerDestroyed(zoom::ZoomController* controller) {
  if (controller == zoom_) {
    std::exchange(zoom_, nullptr)->RemoveObserver(this);
  }
}

void PageEvents::WasDiscarded() {
  if (web_contents()) {
    Send("discarded",
         base::Value(base::DictValue().Set(
             "url", web_contents()->GetVisibleURL().spec())));
  }
}

void PageEvents::WebContentsDestroyed() {
  Reset();
}

}
